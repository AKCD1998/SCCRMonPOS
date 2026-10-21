using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net.NetworkInformation;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Text;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Win32;

namespace SCCRMonPOS
{
    [DataContract]
    public sealed class DevicePolicy
    {
        [DataMember(Name = "schemaVersion")] public int SchemaVersion;
        [DataMember(Name = "tailnet")] public string Tailnet;
        [DataMember(Name = "devices")] public ApprovedDevice[] Devices;
    }

    [DataContract]
    public sealed class ApprovedDevice
    {
        [DataMember(Name = "nodeId")] public string NodeId;
        [DataMember(Name = "hostname")] public string Hostname;
        [DataMember(Name = "ipv4")] public string Ipv4;
        [DataMember(Name = "status")] public string Status;
        [DataMember(Name = "adaPaths")] public string[] AdaPaths;
    }

    [DataContract]
    public sealed class TailnetIdentity
    {
        [DataMember(Name = "BackendState")] public string BackendState;
        [DataMember(Name = "CurrentTailnet")] public TailnetName CurrentTailnet;
        [DataMember(Name = "Self")] public TailnetNode Self;
    }
    [DataContract]
    public sealed class TailnetName { [DataMember(Name = "Name")] public string Name; }
    [DataContract]
    public sealed class TailnetNode
    {
        [DataMember(Name = "ID")] public string Id;
        [DataMember(Name = "HostName")] public string Hostname;
        [DataMember(Name = "Online")] public bool Online;
        [DataMember(Name = "TailscaleIPs")] public string[] Ips;
    }

    public static class DeviceAccessGuard
    {
        public const int ApprovedCheckExitCode = 42;
        public static string Evaluate(DevicePolicy policy, TailnetIdentity identity,
            Func<string, bool> hasLocalAddress, Func<string, bool> hasAdaExecutable)
        {
            if (policy == null || policy.SchemaVersion != 1 || policy.Devices == null ||
                string.IsNullOrWhiteSpace(policy.Tailnet)) return "ไม่พบข้อกำหนดสิทธิ์เครื่องที่ใช้ได้";
            if (identity == null || identity.BackendState != "Running" || identity.Self == null ||
                !identity.Self.Online || identity.CurrentTailnet == null ||
                !string.Equals(identity.CurrentTailnet.Name, policy.Tailnet, StringComparison.Ordinal))
                return "กรุณาเชื่อมต่อ Tailscale บัญชีบริษัทก่อนใช้งาน";
            var matches = policy.Devices.Where(d => d.NodeId == identity.Self.Id).ToArray();
            if (matches.Length != 1 || matches[0].Status != "approved")
                return "เครื่องนี้ยังไม่ได้รับอนุญาตให้ติดตั้งหรือใช้ SCCRM กรุณาติดต่อแอดมิน";
            var device = matches[0];
            if (identity.Self.Ips == null || !identity.Self.Ips.Contains(device.Ipv4) ||
                !hasLocalAddress(device.Ipv4) ||
                !string.Equals(device.Hostname, identity.Self.Hostname, StringComparison.OrdinalIgnoreCase))
                return "ตัวตนหรือ IP ของเครื่องไม่ตรงกับเครื่องที่ได้รับอนุญาต";
            if (device.AdaPaths == null || !device.AdaPaths.Any(hasAdaExecutable))
                return "ไม่พบ AdaSoftware ที่ตรวจรับรองไว้บนเครื่องนี้ กรุณาติดต่อแอดมิน";
            return null;
        }

        public static T Parse<T>(string json)
        {
            if (string.IsNullOrWhiteSpace(json) || json.Length > 1024 * 1024)
                throw new InvalidDataException("Invalid device identity.");
            using (var input = new MemoryStream(Encoding.UTF8.GetBytes(json)))
                return (T)new DataContractJsonSerializer(typeof(T)).ReadObject(input);
        }

        public static DevicePolicy LoadPolicy()
        {
            // Compiled resource only: never accept a policy path or an allow flag
            // from arguments, application settings, environment, or the browser.
            using (var input = typeof(DeviceAccessGuard).Assembly.GetManifestResourceStream("SCCRMonPOS.DevicePolicy.json"))
            using (var reader = new StreamReader(input)) return Parse<DevicePolicy>(reader.ReadToEnd());
        }

        public static bool Check(out string error)
        {
            try
            {
                // AnyCPU can run as a 32-bit process on 64-bit Windows. Read the
                // native Program Files location from HKLM, not the process view
                // or a user-overridable environment variable.
                string programFiles;
                using (var machine = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine,
                    Environment.Is64BitOperatingSystem ? RegistryView.Registry64 : RegistryView.Registry32))
                using (var windows = machine.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion"))
                    programFiles = windows == null ? null : windows.GetValue("ProgramFilesDir") as string;
                if (string.IsNullOrWhiteSpace(programFiles) || !Path.IsPathRooted(programFiles) ||
                    programFiles.StartsWith(@"\\", StringComparison.Ordinal)) throw new InvalidDataException("Invalid program location.");
                var executable = Path.Combine(programFiles, "Tailscale", "tailscale.exe");
                if (!File.Exists(executable)) throw new InvalidDataException("Tailscale is not installed.");
                // Fixed protected installation path; never resolve executables via PATH.
                var start = new ProcessStartInfo(executable, "status --json --peers=false")
                {
                    UseShellExecute = false, CreateNoWindow = true,
                    RedirectStandardOutput = true, RedirectStandardError = true,
                };
                using (var process = Process.Start(start))
                {
                    var stdout = process.StandardOutput.ReadToEndAsync();
                    var stderr = process.StandardError.ReadToEndAsync();
                    if (!process.WaitForExit(8000))
                    {
                        try { process.Kill(); } catch { }
                        throw new TimeoutException();
                    }
                    if (process.ExitCode != 0 || !stdout.Wait(1000)) throw new InvalidDataException("Tailscale is unavailable.");
                    var identity = Parse<TailnetIdentity>(stdout.Result);
                    error = Evaluate(LoadPolicy(), identity, HasLocalAddress, HasAdaExecutable);
                    return error == null;
                }
            }
            catch
            {
                error = "ตรวจสิทธิ์เครื่องไม่ได้ กรุณาเชื่อมต่อ Tailscale แล้วลองใหม่ หรือติดต่อแอดมิน";
                return false;
            }
        }

        private static bool HasLocalAddress(string address)
        {
            return NetworkInterface.GetAllNetworkInterfaces()
                .Where(n => n.OperationalStatus == OperationalStatus.Up)
                .SelectMany(n => n.GetIPProperties().UnicastAddresses)
                .Any(a => a.Address.ToString() == address);
        }

        private static bool HasAdaExecutable(string path)
        {
            try
            {
                if (!Path.IsPathRooted(path) || path.StartsWith(@"\\", StringComparison.Ordinal) ||
                    !new[] { "AdaPosFront.exe", "AdaSmart.exe", "AdaPosBack.exe" }.Contains(Path.GetFileName(path))) return false;
                if (new DriveInfo(Path.GetPathRoot(path)).DriveType != DriveType.Fixed) return false;
                var file = new FileInfo(path);
                if (!file.Exists || file.Length < 1024 * 1024) return false;
                using (var stream = file.OpenRead())
                    if (stream.ReadByte() != 'M' || stream.ReadByte() != 'Z') return false;
                return !string.IsNullOrWhiteSpace(FileVersionInfo.GetVersionInfo(path).FileVersion);
            }
            catch { return false; }
        }
    }

    public sealed class DeviceAccessMonitor : IDisposable
    {
        private readonly Timer timer = new Timer { Interval = 60000 };
        private bool checking;
        private bool disposed;
        public string DeniedReason { get; private set; }
        public DeviceAccessMonitor() { timer.Tick += Check; timer.Start(); }
        private async void Check(object sender, EventArgs args)
        {
            if (checking || disposed) return;
            checking = true;
            try
            {
                string error = await Task.Run(() => { string value; return DeviceAccessGuard.Check(out value) ? null : value; });
                if (disposed || error == null) return;
                timer.Stop();
                // End the app and dispose its watcher/forms before displaying
                // a warning. A modal dialog must not keep an unauthorized app
                // working while it waits for someone to dismiss the message.
                DeniedReason = error;
                Application.Exit();
            }
            finally { checking = false; }
        }
        public void Dispose() { disposed = true; timer.Dispose(); }
    }
}
