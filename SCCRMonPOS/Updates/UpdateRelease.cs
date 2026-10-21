using System;
using System.IO;
using System.Linq;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Security.Cryptography;
using System.Text;

namespace SCCRMonPOS.Updates
{
    [DataContract]
    public sealed class UpdateRelease
    {
        [DataMember(Name = "schemaVersion")] public int SchemaVersion { get; set; }
        [DataMember(Name = "releaseId")] public string ReleaseId { get; set; }
        [DataMember(Name = "version")] public string Version { get; set; }
        [DataMember(Name = "downloadUrl")] public string DownloadUrl { get; set; }
        [DataMember(Name = "sha256")] public string Sha256 { get; set; }
        [DataMember(Name = "size")] public long Size { get; set; }
        [DataMember(Name = "notes")] public string Notes { get; set; }
        [DataMember(Name = "sourceCommit")] public string SourceCommit { get; set; }
        [DataMember(Name = "publishedAt")] public string PublishedAt { get; set; }
        [DataMember(Name = "deviceAccessVersion")] public int DeviceAccessVersion { get; set; }

        public void RequireDeviceAccess()
        {
            if (DeviceAccessVersion != 1)
                throw new InvalidDataException("This release does not enforce the required device policy.");
        }

        [DataContract]
        private sealed class Envelope
        {
            [DataMember(Name = "payload")] public string Payload { get; set; }
            [DataMember(Name = "signature")] public string Signature { get; set; }
        }

        public static UpdateRelease Verify(string envelopeJson)
        {
            using (var stream = typeof(UpdateRelease).Assembly.GetManifestResourceStream("SCCRMonPOS.UpdatePublicKey.xml"))
            using (var reader = new StreamReader(stream)) return Verify(envelopeJson, reader.ReadToEnd());
        }

        public static UpdateRelease Verify(string envelopeJson, string publicKeyXml)
        {
            if (string.IsNullOrWhiteSpace(envelopeJson) || envelopeJson.Length > 65536) throw new InvalidDataException("Invalid release manifest.");
            var envelope = Parse<Envelope>(Encoding.UTF8.GetBytes(envelopeJson));
            byte[] payload = Convert.FromBase64String(envelope.Payload);
            byte[] signature = Convert.FromBase64String(envelope.Signature);
            using (var rsa = new RSACryptoServiceProvider())
            {
                rsa.PersistKeyInCsp = false;
                rsa.FromXmlString(publicKeyXml);
                if (!rsa.VerifyData(payload, CryptoConfig.MapNameToOID("SHA256"), signature))
                    throw new CryptographicException("Release signature is invalid.");
            }
            var release = Parse<UpdateRelease>(payload);
            Uri url;
            if (release.SchemaVersion != 1 || string.IsNullOrWhiteSpace(release.ReleaseId) || release.ReleaseId.Length > 100 ||
                string.IsNullOrWhiteSpace(release.Version) || release.Version.Length > 60 ||
                release.Size < 1024 || release.Size > 20 * 1024 * 1024 ||
                release.Sha256 == null || release.Sha256.Length != 64 || !release.Sha256.All(Uri.IsHexDigit) ||
                !Uri.TryCreate(release.DownloadUrl, UriKind.Absolute, out url) || url.Scheme != "https" ||
                url.Host != "github.com" || !url.IsDefaultPort || !string.IsNullOrEmpty(url.UserInfo) ||
                !url.AbsolutePath.StartsWith("/AKCD1998/SCCRMonPOS/releases/download/", StringComparison.Ordinal) ||
                !url.AbsolutePath.EndsWith("/SCCRMonPOS.exe", StringComparison.Ordinal) ||
                !string.IsNullOrEmpty(url.Query) || !string.IsNullOrEmpty(url.Fragment) || (release.Notes ?? "").Length > 5000)
                throw new InvalidDataException("Release metadata is invalid.");
            return release;
        }

        private static T Parse<T>(byte[] value)
        {
            using (var stream = new MemoryStream(value))
                return (T)new DataContractJsonSerializer(typeof(T)).ReadObject(stream);
        }

        public static string HashFile(string path)
        {
            using (var stream = File.OpenRead(path))
            using (var hash = SHA256.Create()) return BitConverter.ToString(hash.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
        }

        public void VerifyExecutable(string path)
        {
            if (new FileInfo(path).Length != Size || !string.Equals(HashFile(path), Sha256, StringComparison.OrdinalIgnoreCase))
                throw new CryptographicException("Downloaded executable does not match the signed release.");
        }
    }
}
