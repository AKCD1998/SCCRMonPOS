using System;
using System.Collections.Generic;
using System.Data.SqlClient;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Windows.Forms;
using SCCRMonPOS;
using SCCRMonPOS.Models;

internal static class ReceiptScopeCheck
{
    private static int checks;
    private static void Check(bool condition, string name) { if (!condition) throw new InvalidOperationException(name); checks++; }
    private static void Reject(Action action, string name) { bool rejected = false; try { action(); } catch { rejected = true; } Check(rejected, name); }
    private static object Call(object target, string name, params object[] args) => target.GetType().GetMethod(name, BindingFlags.NonPublic | BindingFlags.Instance).Invoke(target, args);
    private static PosReceipt Receipt(string branch, string pos) => new PosReceipt { DocNo = "SYNTHETIC-" + pos, BranchCode = branch, PosCode = pos, DocType = "1", GrandTotal = 100, Items = new List<PosReceiptItem> { new PosReceiptItem { Seq = 1, ProductCode = "FIXTURE", ProductName = "Fixture", Qty = 1, NetAmount = 100, UnitPrice = 100 } } };
    private static void Offline()
    {
        var one = new ReceiptTerminalScope("001", "001"); var two = new ReceiptTerminalScope("001", "002");
        Check(one.Contains(Receipt("001", "001")) && two.Contains(Receipt("001", "002")), "own receipts accepted");
        Check(!one.Contains(Receipt("001", "002")) && !two.Contains(Receipt("001", "001")), "both cross-register directions rejected");
        Check(!one.Contains(Receipt("002", "001")) && !one.Contains(Receipt("001", "")) && !one.Contains(null), "branch and missing identifiers rejected");
        Check(!one.Contains(Receipt("001", "1")), "never guess a register number");
        Reject(() => one.Require(Receipt("001", "002")), "cross-register claim rejected");
        Reject(() => new ReceiptTerminalScope("../001", "001"), "unsafe watermark path rejected");
        var policy = DeviceAccessGuard.LoadPolicy();
        var approvedOne = policy.Devices.Single(d => d.NodeId == "nKAsnKMrkZ11CNTRL");
        var approvedTwo = policy.Devices.Single(d => d.NodeId == "nEdQXowQ4t11CNTRL");
        Check(ReceiptTerminalScope.Resolve(approvedOne, "", "").PosCode == "001", "POS1 node bound to register 001");
        Check(ReceiptTerminalScope.Resolve(approvedTwo, "", "").PosCode == "002", "POS2 node bound to register 002");
        Check(ReceiptTerminalScope.Resolve(approvedTwo, "001", "001") == null, "copied POS1 config cannot override POS2 assignment");
        Check(ReceiptTerminalScope.Resolve(approvedTwo, "005", "002") == null, "wrong branch config refused");
        var approved004Two = policy.Devices.Single(d => d.NodeId == "noJJCWPrL221CNTRL");
        var scope004Two = ReceiptTerminalScope.Resolve(approved004Two, "", "");
        Check(scope004Two.BranchCode == "004" && scope004Two.PosCode == "002", "branch 004 POS002 node bound to its own register");
        Check(scope004Two.Contains(Receipt("004", "002")), "branch 004 POS002 accepts its own receipt");
        Check(!scope004Two.Contains(Receipt("004", "001")) && !scope004Two.Contains(Receipt("001", "002")), "branch 004 POS002 rejects other register and branch");
        Check(ReceiptTerminalScope.Resolve(approved004Two, "004", "001") == null && ReceiptTerminalScope.Resolve(approved004Two, "001", "002") == null, "copied configuration cannot override branch 004 POS002 assignment");
        Check(ReceiptTerminalScope.Resolve(null, "001", "001") == null, "no verified device has no terminal");
        var unmapped = new ApprovedDevice { Status = "approved" };
        Check(ReceiptTerminalScope.Resolve(unmapped, "", "") == null, "unmapped terminal never watches all receipts");
        Check(ReceiptTerminalScope.Resolve(unmapped, "004", "002").PosCode == "002", "explicit admin terminal for an unmapped approved device");
        unmapped.Status = "pending"; Check(ReceiptTerminalScope.Resolve(unmapped, "004", "002") == null, "pending device cannot resolve a scope");
        using (var missing = new AdaPosWatcher(null, false, null))
        {
            bool unavailable = false; missing.WatcherDisconnected += (s,e) => unavailable = true;
            missing.Start(); Check(unavailable, "missing scope refuses polling before SQL");
            Check(missing.LoadReceiptByDocNo("anything") == null && !missing.TryRefetchLineItems(Receipt("001", "001")), "missing scope cannot fetch or retry a receipt");
        }
        string root = Path.Combine(Path.GetTempPath(), "sccrm-receipt-scope-" + Guid.NewGuid().ToString("N"));
        var old = new ReceiptWatermarkStore(root); old.Save(ReceiptWatermark.Create(DateTime.Today, "23:59:59", "OLD-GLOBAL"));
        var storeOne = new ReceiptWatermarkStore(root, one); var storeTwo = new ReceiptWatermarkStore(root, two);
        Check(storeOne.Load() == null && storeTwo.Load() == null, "legacy global watermark not reused");
        storeOne.Save(ReceiptWatermark.Create(DateTime.Today, "11:00:00", "ONE"));
        storeTwo.Save(ReceiptWatermark.Create(DateTime.Today, "12:00:00", "TWO"));
        Check(storeOne.Load().DocNo == "ONE" && storeTwo.Load().DocNo == "TWO" && old.Load().DocNo == "OLD-GLOBAL", "terminal cursors isolated without deleting the original");
        Environment.SetEnvironmentVariable("SCCRMONPOS__ApiBaseUrl", "http://127.0.0.1:1");
        try
        {
            foreach (var scope in new[] { one, two })
            using (var watcher = new AdaPosWatcher(null, false, scope))
            using (var display = new CustomerDisplayController(Path.Combine(root, "display")))
            using (var form = new MemberClaimForm(new ApiClient("http://127.0.0.1:1"), watcher, 25, "synthetic", Receipt(scope.BranchCode, scope.PosCode), display))
            {
                Call(form, "AddMemberRow", new MemberSearchResult { Id = "fixture", DisplayName = "Fixture", PointsAvailable = true });
                Call(form, "SelectMemberAtRow", 0);
                Check((bool)Call(form, "CanConfirm"), "own bill can be confirmed");
                Check(((LoyaltyClaimRequest)Call(form, "BuildClaimRequest")).PosCode == scope.PosCode, "claim carries owning register");
                var receipt = (PosReceipt)typeof(MemberClaimForm).GetField("_receipt", BindingFlags.NonPublic | BindingFlags.Instance).GetValue(form);
                receipt.PosCode = scope.PosCode == "001" ? "002" : "001";
                Check(!(bool)Call(form, "CanConfirm"), "stale cross-register bill disables confirmation");
                Reject(() => Call(form, "BuildClaimRequest"), "request construction also rejects a cross-register bill");
                Call(form, "LoadReceipt", Receipt("001", receipt.PosCode));
                Check(typeof(MemberClaimForm).GetField("_receipt", BindingFlags.NonPublic | BindingFlags.Instance).GetValue(form) == null, "foreign prefill discarded");
            }
        }
        finally { Environment.SetEnvironmentVariable("SCCRMONPOS__ApiBaseUrl", null); }
    }
    [DataContract] private sealed class Input
    {
        [DataMember] public string Server;
        [DataMember] public string User;
        [DataMember] public string Password;
    }
    private static void Live()
    {
        var input = (Input)new DataContractJsonSerializer(typeof(Input)).ReadObject(Console.OpenStandardInput());
        Check(input.Server == @"100.81.137.41\SQLEXPRESS" && input.User == "readonly_pilot", "reviewed SELECT-only endpoint");
        Environment.SetEnvironmentVariable("SCCRMONPOS__AdaPosDbServer", input.Server);
        Environment.SetEnvironmentVariable("SCCRMONPOS__AdaPosDbUser", input.User);
        Environment.SetEnvironmentVariable("SCCRMONPOS__AdaPosDbPassword", input.Password);
        Environment.SetEnvironmentVariable("SCCRMONPOS__AdaPosDbName", "AdaAcc");
        try
        {
            var builder = new SqlConnectionStringBuilder { DataSource = input.Server, InitialCatalog = "AdaAcc", UserID = input.User, Password = input.Password, ConnectTimeout = 8, ApplicationName = "SCCRM-Receipt-Scope-ReadOnly-Check" };
            using (var connection = new SqlConnection(builder.ConnectionString))
            {
                connection.Open(); var fixtures = new List<PosReceipt>();
                foreach (string pos in new[] { "001", "002" })
                using (var command = connection.CreateCommand())
                {
                    command.CommandTimeout = 8;
                    command.CommandText = "SELECT TOP (1) FTShdDocNo,FDDateIns,FTTimeIns FROM (SELECT FTShdDocNo,FTBchCode,FTPosCode,FTShdStaPaid,FCShdGrand,FDDateIns,FTTimeIns FROM dbo.TPSTSalHD UNION ALL SELECT FTShdDocNo,FTBchCode,FTPosCode,FTShdStaPaid,FCShdGrand,FDDateIns,FTTimeIns FROM dbo.TSHD" + pos + ") h WHERE FTBchCode='001' AND FTPosCode=@pos AND FTShdStaPaid='3' AND FCShdGrand>0 ORDER BY FDDateIns DESC,FTTimeIns DESC,FTShdDocNo DESC";
                    command.Parameters.AddWithValue("@pos", pos);
                    using (var reader = command.ExecuteReader())
                    {
                        Check(reader.Read(), "real paid receipt exists for POS " + pos);
                        fixtures.Add(new PosReceipt { DocNo = Convert.ToString(reader[0]), InsertDate = Convert.ToDateTime(reader[1]), InsertTime = Convert.ToString(reader[2]), BranchCode = "001", PosCode = pos });
                    }
                }
                Check(fixtures[0].DocNo != fixtures[1].DocNo, "distinct real receipts");
                foreach (var fixture in fixtures)
                using (var watcher = new AdaPosWatcher(ReceiptWatermark.Create(fixture.InsertDate, fixture.InsertTime, ""), false, new ReceiptTerminalScope("001", fixture.PosCode)))
                {
                    var receipt = watcher.LoadReceiptByDocNo(fixture.DocNo);
                    Check(receipt != null && watcher.OwnsReceipt(receipt) && receipt.Items.Count > 0, "native own receipt and line items available on POS " + fixture.PosCode);
                    Check(watcher.LoadReceiptByDocNo(fixtures.Single(f => f.PosCode != fixture.PosCode).DocNo) == null, "native manual lookup refuses other POS " + fixture.PosCode);
                    Check(!watcher.TryRefetchLineItems(fixtures.Single(f => f.PosCode != fixture.PosCode)), "retry refuses foreign POS before SQL");
                    var rows = (List<PosReceipt>)Call(watcher, "FetchNewReceipts", connection);
                    Check(rows.Count > 0 && rows.All(watcher.OwnsReceipt), "actual polling returns only the selected branch and POS " + fixture.PosCode);
                }
                using (var wrongBranch = new AdaPosWatcher(null, false, new ReceiptTerminalScope("999", "001")))
                    Check(wrongBranch.LoadReceiptByDocNo(fixtures[0].DocNo) == null, "actual lookup refuses foreign branch");
            }
        }
        finally
        {
            foreach (string key in new[] { "AdaPosDbServer", "AdaPosDbUser", "AdaPosDbPassword", "AdaPosDbName" }) Environment.SetEnvironmentVariable("SCCRMONPOS__" + key, null);
            input.Password = null;
        }
    }
    [STAThread] private static int Main(string[] args)
    {
        try
        {
            Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
            if (args.Length == 0) Offline(); else { Check(args.Length == 1 && args[0] == "--verify-sql", "supported test mode"); Live(); }
            Console.WriteLine("{\"ok\":true,\"checks\":" + checks + ",\"adaAccWrites\":0,\"claimsSubmitted\":0,\"liveSqlReadOnly\":" + (args.Length > 0 ? "true" : "false") + "}"); return 0;
        }
        catch (Exception error) { Console.WriteLine("{\"ok\":false,\"checks\":" + checks + ",\"type\":\"" + error.GetType().Name + "\"}"); return 1; }
    }
}
