using System;
using System.IO;
using System.Linq;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Xml;
using SCCRMonPOS;

internal static class AdaPosSetupCheck
{
    private static int checks;
    private static void Check(bool value, string name) { if (!value) throw new Exception(name); checks++; }
    private static string Value(string file, string key) { var doc = new XmlDocument(); doc.Load(file); return doc.SelectSingleNode("/configuration/appSettings/add[@key='" + key + "']")?.Attributes["value"].Value; }
    private static void Reject(Action action, string name) { bool failed = false; try { action(); } catch { failed = true; } Check(failed, name); }
    [DataContract] private sealed class LiveInput
    {
        [DataMember] public string Server;
        [DataMember] public string User;
        [DataMember] public string Password;
        [DataMember] public string Branch;
    }
    private static int Main(string[] args)
    {
        string directory = Path.Combine(Path.GetTempPath(), "SCCRMonPOS-setup-test-" + Guid.NewGuid().ToString("N"));
        try
        {
            if (args.Length == 1 && args[0] == "--verify-sql")
            {
                var input = (LiveInput)new DataContractJsonSerializer(typeof(LiveInput)).ReadObject(Console.OpenStandardInput());
                AdaPosSetup.VerifyConnection(new AdaPosSetup.Connection { Server = input.Server, User = input.User, Password = input.Password, Branch = input.Branch });
                Console.WriteLine("{\"nativeSqlReadOnlyVerified\":true,\"adaAccWrites\":0}"); return 0;
            }
            Check(args.Length == 0, "supported test mode");
            var parsed = AdaPosSetup.ParseAgent("ADAPOS_SQLSERVER_USER=reader\nADAPOS_SQLSERVER_PASSWORD='special;=<&\"'\nADAPOS_SQLSERVER_ADMIN_PASSWORD=never-import\nADAPOS_SYNC_TOKEN=never-import\nADAPOS_SYNC_BRANCH_CODE=005\n");
            Check(parsed.Count == 3 && parsed["ADAPOS_SQLSERVER_PASSWORD"] == "special;=<&\"", "import allowlist and literal password");
            var inputSettings = new AdaPosSetup.Connection { User = "fixture-reader", Password = "fixture;Password=bad;\"<>&'" };
            var builder = AdaPosSetup.ConnectionString(inputSettings, @".\SQLEXPRESS");
            Check(builder.Password == inputSettings.Password && builder.UserID == inputSettings.User && !builder.IntegratedSecurity, "connection-string escaping");
            Check(builder.ConnectTimeout > 4 && builder.ConnectTimeout <= 30, "bounded connection budget tolerates slow pre-login");
            string connectTimeout = AdaPosSetup.VerificationError(AdaPosSetup.VerificationStage.Connect, -2);
            string tableTimeout = AdaPosSetup.VerificationError(AdaPosSetup.VerificationStage.TablePermissions, -2);
            Check(!connectTimeout.Contains("เชื่อม SQL แล้ว") && tableTimeout.Contains("เชื่อม SQL แล้ว") && tableTimeout.Contains("รายตาราง"), "timeouts distinguish connection from an authenticated metadata check");
            Check(AdaPosSetup.VerificationError(AdaPosSetup.VerificationStage.Connect, 18456).Contains("เข้าสู่ระบบ") && !tableTimeout.Contains("รหัสผ่าน"), "authentication rejection is distinct from slow metadata");
            Check(AdaPosSetup.VerificationError(AdaPosSetup.VerificationStage.ReceiptColumns, 1222).Contains("ล็อก") && AdaPosSetup.VerificationError(AdaPosSetup.VerificationStage.ReceiptColumns, 207).Contains("207"), "lock and schema failures retain safe phase diagnostics");
            Reject(() => AdaPosSetup.VerifyConnection(new AdaPosSetup.Connection { User = "sa", Password = "fixture" }), "refuse sa before connecting");
            Directory.CreateDirectory(Path.Combine(directory, "data"));
            string config = Path.Combine(directory, "SCCRMonPOS.exe.config"), secret = Path.Combine(directory, "SCCRMonPOS.secrets.config"), session = Path.Combine(directory, "data", "staff-config.json");
            File.WriteAllText(config, "<configuration><!--keep--><appSettings><add key='ApiBaseUrl' value='https://fixture.invalid'/><add key='AdaPosEnabled' value='false'/><add key='OtherSetting' value='keep'/></appSettings></configuration>");
            File.WriteAllText(secret, "<configuration><appSettings><add key='PosApiKey' value='fixture-only'/><add key='AdaPosEnabled' value='false'/></appSettings></configuration>");
            File.WriteAllText(session, "fixture-session-must-not-change");
            AdaPosSetup.Apply(directory, inputSettings);
            Check(Value(config, "AdaPosEnabled") == "true", "watcher enabled");
            Check(Value(config, "ApiBaseUrl") == "https://fixture.invalid" && Value(config, "OtherSetting") == "keep" && File.ReadAllText(config).Contains("<!--keep-->"), "existing settings preserved");
            Check(Value(secret, "PosApiKey") == "fixture-only" && Value(secret, "AdaPosEnabled") == null, "unrelated secrets preserved and override removed");
            Check(Value(secret, "AdaPosDbPassword") == inputSettings.Password, "secret XML escaping");
            Check(!File.ReadAllText(config).Contains(inputSettings.Password), "password not in public configuration");
            Check(File.ReadAllText(session) == "fixture-session-must-not-change", "staff session preserved");
            var rules = File.GetAccessControl(secret).GetAccessRules(true, true, typeof(SecurityIdentifier)).Cast<FileSystemAccessRule>().ToArray();
            Check(File.GetAccessControl(secret).AreAccessRulesProtected && rules.All(r => r.IdentityReference.Equals(WindowsIdentity.GetCurrent().User) || r.IdentityReference.Equals(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null)) || r.IdentityReference.Equals(new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null))), "private secret ACL");
            Check(File.Exists(Path.Combine(directory, "data", "adapos-setup-result.json")) && !File.ReadAllText(Path.Combine(directory, "data", "adapos-setup-result.json")).Contains(inputSettings.User), "non-secret setup report");
            AdaPosSetup.Apply(directory, inputSettings);
            Check(File.ReadAllText(session) == "fixture-session-must-not-change", "repeat setup preserves staff session");
            byte[] beforeConfig = File.ReadAllBytes(config), beforeSecret = File.ReadAllBytes(secret);
            Reject(() => AdaPosSetup.Apply(directory, new AdaPosSetup.Connection { User = "changed-fixture", Password = "changed-fixture" }, () => { throw new IOException("injected failure"); }), "injected write failure");
            Check(beforeConfig.SequenceEqual(File.ReadAllBytes(config)) && beforeSecret.SequenceEqual(File.ReadAllBytes(secret)), "atomic rollback restores exact files");
            Check(!Directory.GetFiles(directory, "*.prepared-*").Any(), "prepared files removed");
            Check(Directory.GetFiles(Path.Combine(directory, "data", "configuration-backups"), "SCCRMonPOS.secrets.config", SearchOption.AllDirectories).Length >= 3, "existing credentials backed up");
            Environment.SetEnvironmentVariable("SCCRMONPOS__AdaPosEnabled", "false");
            try { Reject(() => AdaPosSetup.VerifyConnection(inputSettings), "environment override detected before connecting"); }
            finally { Environment.SetEnvironmentVariable("SCCRMONPOS__AdaPosEnabled", null); }
            File.WriteAllText(secret, "<!DOCTYPE configuration [<!ENTITY x SYSTEM 'file:///not-read'>]><configuration><appSettings /></configuration>");
            byte[] malformed = File.ReadAllBytes(secret);
            Reject(() => AdaPosSetup.Apply(directory, inputSettings), "DTD rejected");
            Check(beforeConfig.SequenceEqual(File.ReadAllBytes(config)) && malformed.SequenceEqual(File.ReadAllBytes(secret)), "malformed configuration untouched");
            File.WriteAllBytes(secret, beforeSecret);
            File.WriteAllText(config, "<configuration><appSettings configSource='external.config'/></configuration>");
            Reject(() => AdaPosSetup.Apply(directory, inputSettings), "external configuration requires review");
            Check(beforeSecret.SequenceEqual(File.ReadAllBytes(secret)), "failed preparation never changes secrets");
            Console.WriteLine("{\"passed\":" + checks + ",\"adaAccAccessed\":false}"); return 0;
        }
        catch (Exception error) { Console.Error.WriteLine(AdaPosSetup.SafeError(error)); return 1; }
        finally
        {
            string allowed = Path.Combine(Path.GetTempPath(), "SCCRMonPOS-setup-test-");
            if (Directory.Exists(directory) && Path.GetFullPath(directory).StartsWith(allowed, StringComparison.OrdinalIgnoreCase)
                && (File.GetAttributes(directory) & FileAttributes.ReparsePoint) == 0) Directory.Delete(directory, true);
        }
    }
}
