using System;
using System.Collections.Generic;
using System.Data.SqlClient;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Windows.Forms;
using System.Xml;

namespace SCCRMonPOS
{
    // Runs inside Setup before files are installed. It uses only SELECT against
    // AdaAcc and writes local, legacy-compatible configuration after verification.
    internal static class AdaPosSetup
    {
        internal const int SuccessExitCode = 43;
        internal sealed class Connection
        {
            public string Server = @".\SQLEXPRESS", Database = "AdaAcc", User = "", Password = "", Branch = "";
        }

        internal static int Run(string directory, bool silent)
        {
            Connection settings = null;
            string failure;
            try
            {
                EnsureStopped();
                settings = FindConnection(directory);
                if (settings == null) throw new InvalidOperationException("ยังไม่พบค่าฐานข้อมูลบนเครื่อง กรุณาให้ผู้ดูแลระบุบัญชีที่อ่านข้อมูลอย่างเดียว");
                VerifyConnection(settings);
                Apply(directory, settings);
                return SuccessExitCode;
            }
            catch (Exception ex) { failure = SafeError(ex); }
            if (silent) return 21;
            using (var form = new ConnectionForm(directory, settings ?? new Connection(), failure))
                return form.ShowDialog() == DialogResult.OK ? SuccessExitCode : 21;
        }

        private static void EnsureStopped()
        {
            bool created;
            using (var mutex = new System.Threading.Mutex(false, @"Global\SCCRMonPOS_SingleInstance", out created))
                if (!created) throw new InvalidOperationException("กรุณาออกจาก SCCRM ที่ไอคอนมุมขวาล่างก่อน แล้วกดเชื่อมต่ออีกครั้ง โดยเปิด AdaPos ไว้ได้");
        }

        internal static Connection FindConnection(string directory)
        {
            var values = ReadSettings(Path.Combine(directory, "SCCRMonPOS.exe.config"));
            foreach (var pair in ReadSettings(Path.Combine(directory, "SCCRMonPOS.secrets.config"))) values[pair.Key] = pair.Value;
            foreach (string key in new[] { "AdaPosDbServer", "AdaPosDbName", "AdaPosDbUser", "AdaPosDbPassword" })
            {
                string value = Environment.GetEnvironmentVariable("SCCRMONPOS__" + key);
                if (!string.IsNullOrWhiteSpace(value)) values[key] = value;
            }
            var existing = new Connection { Server = Value(values, "AdaPosDbServer", @".\SQLEXPRESS"), Database = Value(values, "AdaPosDbName", "AdaAcc"),
                User = Value(values, "AdaPosDbUser"), Password = Value(values, "AdaPosDbPassword") };
            if (UsableIdentity(existing)) return existing;

            foreach (string drive in new[] { "D:\\", "C:\\" })
            foreach (string folder in new[] { "SCstockDay", "SC-StockDay-Ordering" })
            {
                string file = Path.Combine(drive, folder, "apps", "adapos-sync", ".env");
                if (!File.Exists(file)) continue;
                Dictionary<string, string> agent;
                try { agent = ParseAgent(File.ReadAllText(file)); } catch (IOException) { continue; } catch (UnauthorizedAccessException) { continue; }
                var result = new Connection { Server = Value(agent, "ADAPOS_SQLSERVER_HOST"), Database = Value(agent, "ADAPOS_SQLSERVER_DATABASE"),
                    User = Value(agent, "ADAPOS_SQLSERVER_USER"), Password = Value(agent, "ADAPOS_SQLSERVER_PASSWORD"), Branch = Value(agent, "ADAPOS_SYNC_BRANCH_CODE") };
                if (!UsableIdentity(result) || result.Database != "AdaAcc" || !Regex.IsMatch(result.Branch, @"^\d{3}$")) continue;
                // The installed branch agent owns this explicit endpoint. A
                // named instance uses live registry discovery, never a stale port.
                if (!result.Server.Contains("\\") && !result.Server.Contains(","))
                {
                    int port;
                    if (int.TryParse(Value(agent, "ADAPOS_SQLSERVER_PORT"), out port) && port > 0 && port <= 65535) result.Server += "," + port;
                }
                return result;
            }
            return null;
        }

        internal static Dictionary<string, string> ParseAgent(string content)
        {
            var values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            var allowed = new HashSet<string>(new[] { "ADAPOS_SQLSERVER_HOST", "ADAPOS_SQLSERVER_PORT", "ADAPOS_SQLSERVER_DATABASE", "ADAPOS_SQLSERVER_USER", "ADAPOS_SQLSERVER_PASSWORD", "ADAPOS_SYNC_BRANCH_CODE" });
            foreach (string line in content.Split('\n'))
            {
                int equal = line.IndexOf('='); if (equal < 1) continue;
                string key = line.Substring(0, equal).Trim(); if (!allowed.Contains(key)) continue;
                string value = line.Substring(equal + 1).Trim();
                if (value.Length >= 2 && ((value[0] == '"' && value[value.Length - 1] == '"') || (value[0] == '\'' && value[value.Length - 1] == '\''))) value = value.Substring(1, value.Length - 2);
                values[key] = value;
            }
            return values;
        }

        private static bool UsableIdentity(Connection value) => !string.IsNullOrWhiteSpace(value.Server) && !string.IsNullOrWhiteSpace(value.User) && value.User.Trim().ToLowerInvariant() != "sa" && !string.IsNullOrEmpty(value.Password);
        private static string Value(Dictionary<string, string> source, string key, string fallback = "") => source.ContainsKey(key) ? source[key] : fallback;

        internal static SqlConnectionStringBuilder ConnectionString(Connection settings, string server)
        {
            return new SqlConnectionStringBuilder { DataSource = server, InitialCatalog = settings.Database, UserID = settings.User,
                Password = settings.Password, ConnectTimeout = 4, ApplicationName = "SCCRMonPOS-Setup-ReadOnly" };
        }

        internal static string VerifyConnection(Connection settings)
        {
            if (!UsableIdentity(settings) || settings.Database != "AdaAcc") throw new InvalidOperationException("ต้องใช้บัญชีอ่านอย่างเดียวสำหรับฐาน AdaAcc และไม่ใช้บัญชี sa");
            CheckEnvironment(settings);
            SqlConnection connection = null;
            try
            {
                foreach (string server in AdaPosWatcher.BuildSetupServerCandidates(settings.Server))
                {
                    var candidate = new SqlConnection(ConnectionString(settings, server).ConnectionString);
                    try { candidate.Open(); connection = candidate; break; }
                    catch (SqlException) { candidate.Dispose(); }
                }
                if (connection == null) throw new InvalidOperationException("ยังเชื่อมฐาน AdaPos ไม่ได้ กรุณาตรวจชื่อเซิร์ฟเวอร์ บัญชี และรหัสผ่านกับผู้ดูแล");
                using (var command = connection.CreateCommand())
                {
                    command.CommandTimeout = 10;
                    command.CommandText = "SELECT IS_SRVROLEMEMBER('sysadmin'),IS_SRVROLEMEMBER('securityadmin'),IS_SRVROLEMEMBER('serveradmin'),IS_SRVROLEMEMBER('setupadmin'),IS_SRVROLEMEMBER('processadmin'),IS_SRVROLEMEMBER('bulkadmin'),IS_MEMBER('db_owner'),IS_MEMBER('db_datawriter'),IS_MEMBER('db_ddladmin'),IS_MEMBER('db_securityadmin'),IS_MEMBER('db_accessadmin'),IS_MEMBER('db_backupoperator'),HAS_PERMS_BY_NAME(DB_NAME(),'DATABASE','CONTROL'),HAS_PERMS_BY_NAME(DB_NAME(),'DATABASE','ALTER'),HAS_PERMS_BY_NAME(DB_NAME(),'DATABASE','INSERT'),HAS_PERMS_BY_NAME(DB_NAME(),'DATABASE','UPDATE'),HAS_PERMS_BY_NAME(DB_NAME(),'DATABASE','DELETE'),HAS_PERMS_BY_NAME(DB_NAME(),'DATABASE','SELECT')";
                    using (var reader = command.ExecuteReader())
                    {
                        if (!reader.Read()) throw new InvalidOperationException("ตรวจสิทธิ์ฐานข้อมูลไม่สำเร็จ");
                        for (int i = 0; i < reader.FieldCount; i++)
                            if (reader.IsDBNull(i) || Convert.ToInt32(reader.GetValue(i)) != (i == reader.FieldCount - 1 ? 1 : 0))
                                throw new InvalidOperationException("บัญชีนี้มีสิทธิ์เกินกว่าการอ่านข้อมูล กรุณาใช้บัญชีอ่านอย่างเดียว");
                    }
                    command.CommandText = "SELECT COUNT(*) FROM sys.tables WHERE is_ms_shipped=0 AND (HAS_PERMS_BY_NAME(QUOTENAME(SCHEMA_NAME(schema_id))+'.'+QUOTENAME(name),'OBJECT','INSERT')=1 OR HAS_PERMS_BY_NAME(QUOTENAME(SCHEMA_NAME(schema_id))+'.'+QUOTENAME(name),'OBJECT','UPDATE')=1 OR HAS_PERMS_BY_NAME(QUOTENAME(SCHEMA_NAME(schema_id))+'.'+QUOTENAME(name),'OBJECT','DELETE')=1 OR HAS_PERMS_BY_NAME(QUOTENAME(SCHEMA_NAME(schema_id))+'.'+QUOTENAME(name),'OBJECT','ALTER')=1)";
                    if (Convert.ToInt32(command.ExecuteScalar()) != 0) throw new InvalidOperationException("บัญชีนี้ยังแก้ไขตารางได้ กรุณาใช้บัญชีอ่านอย่างเดียว");
                    command.CommandText = "SELECT name FROM sys.tables WHERE schema_id=SCHEMA_ID('dbo') AND (name='TPSTSalHD' OR name LIKE 'TSHD[0-9][0-9][0-9]')";
                    var headers = new List<string>();
                    using (var reader = command.ExecuteReader()) while (reader.Read()) headers.Add(reader.GetString(0));
                    if (headers.Count == 0) throw new InvalidOperationException("ไม่พบตารางบิล AdaPos ในฐานที่เลือก");
                    bool branchSeen = false, anyReceipt = false;
                    foreach (string header in headers)
                    {
                        if (header != "TPSTSalHD" && !Regex.IsMatch(header, @"^TSHD\d{3}$")) throw new InvalidOperationException("รูปแบบตารางบิลไม่รองรับ");
                        string detail = header == "TPSTSalHD" ? "TPSTSalDT" : "TSDT" + header.Substring(4);
                        command.CommandText = "SELECT TOP (0) FTShdDocNo,FTBchCode,FTPosCode,FTUsrCode,FDShdDocDate,FTShdDocTime,FCShdGrand,FCShdDis,FTShdDocType,FTShdStaPaid FROM dbo.[" + header + "]; SELECT TOP (0) FTShdDocNo,FNSdtSeqNo,FTPdtCode,FTPdtName,FTSdtBarCode,FCSdtQty,FCSdtSetPrice,FCSdtNet,FCSdtDis,FTPmhCode FROM dbo.[" + detail + "]";
                        using (var reader = command.ExecuteReader()) { while (reader.NextResult()) { } }
                        if (!string.IsNullOrWhiteSpace(settings.Branch))
                        {
                            command.CommandText = "SELECT TOP (1) FTBchCode FROM dbo.[" + header + "]";
                            var branch = command.ExecuteScalar();
                            if (branch != null && branch != DBNull.Value) { anyReceipt = true; branchSeen |= Convert.ToString(branch).Trim() == settings.Branch; }
                        }
                    }
                    if (anyReceipt && !branchSeen) throw new InvalidOperationException("รหัสสาขาในค่าตั้งค่าไม่ตรงกับฐานบิล กรุณาให้ผู้ดูแลตรวจสอบก่อน");
                }
                return connection.DataSource;
            }
            finally { connection?.Dispose(); }
        }

        private static void CheckEnvironment(Connection value)
        {
            foreach (var pair in new Dictionary<string, string> { { "AdaPosEnabled", "true" }, { "AdaPosDbServer", value.Server }, { "AdaPosDbName", value.Database }, { "AdaPosDbUser", value.User }, { "AdaPosDbPassword", value.Password } })
            {
                string current = Environment.GetEnvironmentVariable("SCCRMONPOS__" + pair.Key);
                if (!string.IsNullOrWhiteSpace(current) && current != pair.Value) throw new InvalidOperationException("มีค่าการเชื่อมต่อจาก environment ที่ทับค่าตัวติดตั้ง กรุณาให้ผู้ดูแลตรวจการตั้งค่าเดิมก่อน");
            }
        }

        private static XmlDocument ReadXml(string path)
        {
            var doc = new XmlDocument { PreserveWhitespace = true, XmlResolver = null };
            if (File.Exists(path)) using (var reader = XmlReader.Create(path, new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null })) doc.Load(reader);
            else doc.LoadXml("<?xml version=\"1.0\" encoding=\"utf-8\"?><configuration><appSettings /></configuration>");
            if (doc.DocumentElement?.Name != "configuration") throw new InvalidOperationException("ไฟล์ตั้งค่าเดิมไม่ถูกต้อง กรุณาให้ผู้ดูแลตรวจสอบ");
            return doc;
        }

        private static Dictionary<string, string> ReadSettings(string path)
        {
            var values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (XmlNode node in ReadXml(path).SelectNodes("/configuration/appSettings/add"))
                if (node.Attributes?["key"] != null) values[node.Attributes["key"].Value] = node.Attributes["value"]?.Value ?? "";
            return values;
        }

        private static void Set(XmlDocument doc, string key, string value)
        {
            var settings = doc.SelectSingleNode("/configuration/appSettings");
            if (settings == null) settings = doc.DocumentElement.AppendChild(doc.CreateElement("appSettings"));
            if (settings.Attributes?["configSource"] != null || settings.Attributes?["file"] != null) throw new InvalidOperationException("ไฟล์ตั้งค่าเดิมอ้างไฟล์ภายนอก กรุณาให้ผู้ดูแลตรวจสอบก่อน");
            var nodes = settings.SelectNodes("add[@key='" + key + "']");
            foreach (XmlNode node in nodes) settings.RemoveChild(node);
            var add = doc.CreateElement("add"); add.SetAttribute("key", key); add.SetAttribute("value", value); settings.AppendChild(add);
        }

        private static byte[] Bytes(XmlDocument doc)
        {
            using (var stream = new MemoryStream()) { doc.Save(stream); return stream.ToArray(); }
        }

        private static FileSecurity PrivateAccess()
        {
            var security = new FileSecurity(); security.SetAccessRuleProtection(true, false);
            foreach (var sid in new[] { WindowsIdentity.GetCurrent().User, new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null) })
                security.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.FullControl, AccessControlType.Allow));
            return security;
        }

        private static void PrivateWrite(string path, byte[] bytes)
        {
            using (var stream = new FileStream(path, FileMode.CreateNew, FileSystemRights.Write, FileShare.None, 4096, FileOptions.None, PrivateAccess())) stream.Write(bytes, 0, bytes.Length);
        }

        private static void AtomicWrite(string path, byte[] bytes)
        {
            string temporary = path + ".prepared-" + Guid.NewGuid().ToString("N");
            try
            {
                PrivateWrite(temporary, bytes);
                if (File.Exists(path)) File.Replace(temporary, path, null); else File.Move(temporary, path);
                File.SetAccessControl(path, PrivateAccess());
            }
            finally { if (File.Exists(temporary)) File.Delete(temporary); }
        }

        internal static void Apply(string directory, Connection settings, Action afterSecrets = null)
        {
            EnsureStopped(); CheckEnvironment(settings);
            directory = Path.GetFullPath(directory);
            if (directory.StartsWith(@"\\") || directory.TrimEnd('\\') == Path.GetPathRoot(directory).TrimEnd('\\')) throw new InvalidOperationException("กรุณาติดตั้งในโฟลเดอร์บนเครื่องนี้");
            foreach (string candidate in new[] { directory, Path.Combine(directory, "data"), Path.Combine(directory, "data", "configuration-backups"), Path.Combine(directory, "SCCRMonPOS.exe.config"), Path.Combine(directory, "SCCRMonPOS.secrets.config") })
                if ((File.Exists(candidate) || Directory.Exists(candidate)) && (File.GetAttributes(candidate) & FileAttributes.ReparsePoint) != 0) throw new InvalidOperationException("โฟลเดอร์ตั้งค่าเป็นลิงก์ กรุณาให้ผู้ดูแลตรวจสอบก่อน");
            string configPath = Path.Combine(directory, "SCCRMonPOS.exe.config"), secretPath = Path.Combine(directory, "SCCRMonPOS.secrets.config");
            byte[] oldConfig = File.Exists(configPath) ? File.ReadAllBytes(configPath) : null, oldSecret = File.Exists(secretPath) ? File.ReadAllBytes(secretPath) : null;
            var config = ReadXml(configPath); var secrets = ReadXml(secretPath);
            if (oldConfig == null) { Set(config, "ApiBaseUrl", "https://sc-official-website.onrender.com"); Set(config, "BahtPerPoint", "25"); }
            Set(config, "AdaPosEnabled", "true"); Set(config, "AdaPosDbServer", settings.Server); Set(config, "AdaPosDbName", settings.Database);
            Set(config, "AdaPosPollMs", "3000"); Set(config, "WatcherDiagnosticsEnabled", "true");
            // Secret overrides for these settings must agree with public config.
            foreach (string key in new[] { "AdaPosEnabled", "AdaPosDbServer", "AdaPosDbName", "AdaPosPollMs", "WatcherDiagnosticsEnabled" })
                foreach (XmlNode node in secrets.SelectNodes("/configuration/appSettings/add[@key='" + key + "']")) node.ParentNode.RemoveChild(node);
            Set(secrets, "AdaPosDbUser", settings.User); Set(secrets, "AdaPosDbPassword", settings.Password);
            string backup = Path.Combine(directory, "data", "configuration-backups", DateTime.UtcNow.ToString("yyyyMMdd-HHmmss", System.Globalization.CultureInfo.InvariantCulture) + "-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(backup);
            if (oldConfig != null) PrivateWrite(Path.Combine(backup, "SCCRMonPOS.exe.config"), oldConfig);
            if (oldSecret != null) PrivateWrite(Path.Combine(backup, "SCCRMonPOS.secrets.config"), oldSecret);
            try
            {
                AtomicWrite(secretPath, Bytes(secrets)); afterSecrets?.Invoke(); AtomicWrite(configPath, Bytes(config));
                // No credentials, tokens, or receipt contents in the setup report.
                string report = "{\"applied\":true,\"readOnlyVerified\":true,\"adaAccWrites\":0,\"checkedAt\":\"" + DateTime.UtcNow.ToString("o") + "\"}";
                AtomicWrite(Path.Combine(directory, "data", "adapos-setup-result.json"), Encoding.UTF8.GetBytes(report));
            }
            catch
            {
                if (oldSecret == null) { if (File.Exists(secretPath)) File.Delete(secretPath); } else AtomicWrite(secretPath, oldSecret);
                if (oldConfig == null) { if (File.Exists(configPath)) File.Delete(configPath); } else AtomicWrite(configPath, oldConfig);
                throw;
            }
        }

        internal static string SafeError(Exception ex)
        {
            if (ex is InvalidOperationException) return ex.Message;
            if (ex is SqlException) return "อ่านโครงสร้างบิลไม่สำเร็จ กรุณาให้ผู้ดูแลตรวจฐาน AdaAcc (SQL " + ((SqlException)ex).Number + ")";
            if (ex is UnauthorizedAccessException || ex is IOException) return "อ่านหรือบันทึกไฟล์ตั้งค่าไม่ได้ กรุณาตรวจสิทธิ์โฟลเดอร์ติดตั้งกับผู้ดูแล";
            return "ตั้งค่าเชื่อม AdaPos ไม่สำเร็จ กรุณาติดต่อผู้ดูแล";
        }

        private sealed class ConnectionForm : Form
        {
            private readonly TextBox server, database, user, password;
            private readonly Label status;
            private readonly Button connect;
            private bool working;
            internal ConnectionForm(string directory, Connection value, string failure)
            {
                Text = "SCCRM — เชื่อมต่อ AdaPos"; Size = new Size(570, 420); FormBorderStyle = FormBorderStyle.FixedDialog;
                MaximizeBox = false; MinimizeBox = false; StartPosition = FormStartPosition.CenterScreen; Font = new Font("Segoe UI", 10);
                var header = new Label { Text = "เชื่อม AdaPos เพื่ออ่านบิลสมาชิก", Left = 22, Top = 18, Width = 520, Height = 34, ForeColor = Color.FromArgb(11, 31, 184), Font = new Font(Font, FontStyle.Bold) }; Controls.Add(header);
                server = Field("เซิร์ฟเวอร์", value.Server, 60); database = Field("ฐานข้อมูล", value.Database, 105);
                user = Field("บัญชีอ่านอย่างเดียว", value.User, 150); password = Field("รหัสผ่านฐานข้อมูล", value.Password, 195); password.UseSystemPasswordChar = true;
                status = new Label { Text = failure, Left = 22, Top = 245, Width = 510, Height = 64 }; Controls.Add(status);
                connect = new Button { Text = "ตรวจการเชื่อมต่อและติดตั้ง", Left = 245, Top = 320, Width = 285, Height = 38 }; Controls.Add(connect);
                var cancel = new Button { Text = "ยกเลิก", Left = 22, Top = 320, Width = 100, Height = 38, DialogResult = DialogResult.Cancel }; Controls.Add(cancel);
                CancelButton = cancel;
                FormClosing += (s, e) => { if (working) e.Cancel = true; };
                connect.Click += async (s, e) =>
                {
                    working = true; connect.Enabled = false; cancel.Enabled = false; status.Text = "กำลังตรวจบัญชีอ่านอย่างเดียวและโครงสร้างบิล…";
                    var input = new Connection { Server = server.Text.Trim(), Database = database.Text.Trim(), User = user.Text.Trim(), Password = password.Text };
                    try { await Task.Run(() => { EnsureStopped(); VerifyConnection(input); Apply(directory, input); }); working = false; DialogResult = DialogResult.OK; Close(); }
                    catch (Exception error) { status.Text = SafeError(error); }
                    finally { working = false; connect.Enabled = true; cancel.Enabled = true; }
                };
            }
            private TextBox Field(string label, string value, int top)
            {
                Controls.Add(new Label { Text = label, Left = 22, Top = top + 5, Width = 170 });
                var field = new TextBox { Text = value, Left = 200, Top = top, Width = 330 }; Controls.Add(field); return field;
            }
        }
    }
}
