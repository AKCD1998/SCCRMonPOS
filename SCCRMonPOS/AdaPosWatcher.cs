using System;
using System.Collections.Generic;
using System.Configuration;
using System.Data;
using System.Data.SqlClient;
using System.Threading;
using Microsoft.Win32;
using SCCRMonPOS.Models;

namespace SCCRMonPOS
{
    /// <summary>
    /// Polls the AdaPos SQL Server database (AdaAcc on POSSRV) for new completed
    /// receipts and fires events that TrayAppContext reacts to.
    ///
    /// Threading: runs its own background thread. Events are raised on that thread —
    /// TrayAppContext is responsible for marshalling UI work back to the UI thread.
    ///
    /// Watermark: on Start() the watermark is set to "right now", so only receipts
    /// that complete after the program starts are picked up. Historical rows are ignored.
    ///
    /// Resilience: SQL errors are caught and surfaced via WatcherDisconnected. The loop
    /// keeps running and reconnects automatically on the next successful poll.
    /// </summary>
    public sealed class AdaPosWatcher : IDisposable
    {
        // ── Events ────────────────────────────────────────────────────────────

        /// <summary>Raised when a new paid sale receipt is detected.</summary>
        public event EventHandler<PosReceipt> ReceiptCompleted;

        /// <summary>Raised when a return receipt (DocType='9') is detected.</summary>
        public event EventHandler<PosReceipt> ReturnDetected;

        /// <summary>Raised when the DB connection is (re)established after being down.</summary>
        public event EventHandler WatcherConnected;

        /// <summary>Raised when the DB connection is lost. Arg is the error message.</summary>
        public event EventHandler<string> WatcherDisconnected;
        public event EventHandler<string> WatcherDiagnostic;

        // ── Config ────────────────────────────────────────────────────────────

        private readonly string _configuredServer;
        private readonly string _database;
        private readonly string _user;
        private readonly string _password;
        private readonly int    _pollMs;
        private readonly bool   _enabled;
        private readonly ReceiptTerminalScope _terminal;

        // ── State ─────────────────────────────────────────────────────────────

        private Thread       _thread;
        private volatile bool _running;
        private ReceiptWatermark _watermark;
        private bool         _dbOnline;   // tracks last-known connection state
        private string       _resolvedConnStr;
        private readonly bool _diagnosticsEnabled;
        private string _resolvedServer;
        private List<SaleTableSet> _saleTableSets;
        // Receipts detected but not yet finalized (GrandTotal=0 or no items). Re-checked every poll.
        private readonly Dictionary<string, PosReceipt> _pendingReceipts =
            new Dictionary<string, PosReceipt>(StringComparer.OrdinalIgnoreCase);
        private readonly Dictionary<string, DateTime> _pendingCapturedAt =
            new Dictionary<string, DateTime>(StringComparer.OrdinalIgnoreCase);
        // Return bills detected before AdaPos wrote the original-bill ref (FTShdPosCN).
        // Held and re-checked every poll until the ref appears or the bill times out.
        private readonly Dictionary<string, PosReceipt> _pendingReturns =
            new Dictionary<string, PosReceipt>(StringComparer.OrdinalIgnoreCase);
        private readonly Dictionary<string, DateTime> _pendingReturnCapturedAt =
            new Dictionary<string, DateTime>(StringComparer.OrdinalIgnoreCase);
        private static readonly TimeSpan PendingReceiptTimeout = TimeSpan.FromMinutes(10);

        // ─────────────────────────────────────────────────────────────────────

        public AdaPosWatcher(ReceiptWatermark initialWatermark, bool diagnosticsEnabled)
            : this(initialWatermark, diagnosticsEnabled, ReceiptTerminalScope.FromConfiguration()) { }

        internal AdaPosWatcher(ReceiptWatermark initialWatermark, bool diagnosticsEnabled, ReceiptTerminalScope terminal)
        {
            _terminal = terminal;
            _enabled = ReadBool("AdaPosEnabled", true);

            _configuredServer = Cfg("AdaPosDbServer",   "192.168.0.127,49683");
            _database         = Cfg("AdaPosDbName",     "AdaAcc");
            _user             = Cfg("AdaPosDbUser",     "sa");
            _password         = Cfg("AdaPosDbPassword", "adasoft");
            _pollMs = ReadInt("AdaPosPollMs", 3000);
            _diagnosticsEnabled = diagnosticsEnabled;
            _watermark = initialWatermark ?? ReceiptWatermark.Create(DateTime.Today, DateTime.Now.ToString("HH:mm:ss"), "");
        }

        // ── Public API ────────────────────────────────────────────────────────

        public bool IsEnabled { get { return _enabled; } }
        public string TerminalDescription => _terminal?.Description ?? "ยังไม่กำหนดสาขา / เครื่องขาย";
        public bool OwnsReceipt(PosReceipt receipt) => _terminal != null && _terminal.Contains(receipt);

        public void Start()
        {
            if (!_enabled || _thread != null) return;
            if (_terminal == null)
            {
                WatcherDisconnected?.Invoke(this, "ยังไม่ผูกสาขาและเลขเครื่องขายกับเครื่องนี้ กรุณาให้แอดมินตั้งค่าก่อนอ่านบิล");
                return;
            }

            // Watermark starts at this moment — historical receipts are ignored
            _running = true;
            _thread  = new Thread(PollLoop)
            {
                IsBackground = true,
                Name         = "AdaPosWatcher"
            };
            _thread.Start();
        }

        public void Stop()
        {
            _running = false;
            _thread  = null;
        }

        public void Dispose() { Stop(); }

        public void AcknowledgeReceipt(PosReceipt receipt)
        {
            if (!OwnsReceipt(receipt)) return;
            ReceiptWatermark next = ReceiptWatermark.FromReceipt(receipt);
            if (next != null && IsAfterWatermark(next, _watermark))
                _watermark = next;
        }

        private static bool IsAfterWatermark(ReceiptWatermark candidate, ReceiptWatermark current)
        {
            if (current == null) return true;
            if (candidate.InsertDate > current.InsertDate) return true;
            if (candidate.InsertDate < current.InsertDate) return false;
            int t = string.Compare(candidate.InsertTime ?? "", current.InsertTime ?? "", StringComparison.Ordinal);
            if (t != 0) return t > 0;
            return string.Compare(candidate.DocNo ?? "", current.DocNo ?? "", StringComparison.OrdinalIgnoreCase) > 0;
        }

        /// <summary>
        /// Looks up a receipt (header + items + payment) by its document number.
        /// Returns null if not found or if the DB is not available.
        /// </summary>
        public PosReceipt LoadReceiptByDocNo(string docNo)
        {
            if (_terminal == null || string.IsNullOrWhiteSpace(docNo)) return null;
            try
            {
                string connStr = ResolveConnectionString();
                using (var conn = new SqlConnection(connStr))
                {
                    conn.Open();
                    EnsureSaleTables(conn);
                    return FetchReceiptByDocNo(conn, docNo.Trim());
                }
            }
            catch { return null; }
        }

        private PosReceipt FetchReceiptByDocNo(SqlConnection conn, string docNo)
        {
            if (_saleTableSets == null) return null;
            foreach (SaleTableSet set in _saleTableSets)
            {
                string sql = @"
                    SELECT h.FTShdDocNo, h.FTShdDocType, h.FTBchCode, h.FTPosCode, h.FTUsrCode,
                           h.FDShdDocDate, h.FTShdDocTime, h.FDDateIns, h.FTTimeIns,
                           h.FCShdGrand, h.FCShdDis, h.FCShdMnyCsh, h.FCShdChn,
                           h.FTShdStaRefund, h.FTShdPosCN
                    FROM   " + set.HeaderTable + @" h
                    WHERE  h.FTShdDocNo = @docNo
                       AND h.FTBchCode = @receiptBranch AND h.FTPosCode = @receiptPos
                       AND h.FTShdStaPaid = '3'";

                using (var cmd = new SqlCommand(sql, conn))
                {
                    _terminal.AddParameters(cmd);
                    cmd.Parameters.Add("@docNo", SqlDbType.VarChar, 50).Value = docNo;
                    using (var r = cmd.ExecuteReader())
                    {
                        if (!r.Read()) continue;
                        string docType = Str(r, "FTShdDocType");
                        var receipt = new PosReceipt
                        {
                            DocNo         = Str(r,  "FTShdDocNo"),
                            DocType       = docType,
                            IsReturn      = docType == "9",
                            BranchCode    = Str(r,  "FTBchCode"),
                            PosCode       = Str(r,  "FTPosCode"),
                            CashierCode   = Str(r,  "FTUsrCode"),
                            DocDate       = Date(r, "FDShdDocDate"),
                            DocTime       = Str(r,  "FTShdDocTime"),
                            InsertDate    = Date(r, "FDDateIns"),
                            InsertTime    = Str(r,  "FTTimeIns"),
                            GrandTotal    = Dec(r,  "FCShdGrand"),
                            Discount      = Dec(r,  "FCShdDis"),
                            CashAmount    = Dec(r,  "FCShdMnyCsh"),
                            ChangeGiven   = Dec(r,  "FCShdChn"),
                            OriginalDocNo = Str(r,  "FTShdPosCN"),
                            HeaderTable   = set.HeaderTable,
                            DetailTable   = set.DetailTable,
                            PaymentTable  = set.PaymentTable
                        };
                        r.Close();
                        try { FetchLineItems(conn, receipt); } catch { }
                        try { FetchPayment(conn, receipt); }   catch { }
                        return receipt;
                    }
                }
            }
            return null;
        }

        /// <summary>
        /// Re-fetches line items from the DB into an already-captured receipt whose Items list is empty.
        /// Returns true if items were fetched successfully.
        /// </summary>
        public bool TryRefetchLineItems(PosReceipt receipt)
        {
            if (!OwnsReceipt(receipt)) return false;
            try
            {
                string connStr = ResolveConnectionString();
                using (var conn = new SqlConnection(connStr))
                {
                    conn.Open();
                    RefreshReceiptHeader(conn, receipt);
                    receipt.Items.Clear();
                    FetchLineItems(conn, receipt);
                    return receipt.GrandTotal > 0 && receipt.Items != null && receipt.Items.Count > 0;
                }
            }
            catch
            {
                return false;
            }
        }

        // ── Poll loop ─────────────────────────────────────────────────────────

        private void PollLoop()
        {
            while (_running)
            {
                try
                {
                    PollOnce();

                    if (!_dbOnline)
                    {
                        _dbOnline = true;
                        WatcherConnected?.Invoke(this, EventArgs.Empty);
                    }
                }
                catch (Exception ex)
                {
                    _resolvedConnStr = null;
                    _resolvedServer = null;
                    _saleTableSets = null;
                    RaiseDiagnostic("Watcher error: " + ex.Message);
                    if (_dbOnline)
                    {
                        _dbOnline = false;
                        WatcherDisconnected?.Invoke(this, ex.Message);
                    }
                }

                if (_running)
                    Thread.Sleep(_pollMs);
            }
        }

        private void PollOnce()
        {
            if (_terminal == null) throw new InvalidOperationException("ยังไม่กำหนดเครื่องขายสำหรับอ่านบิล");
            using (var conn = new SqlConnection(ResolveConnectionString()))
            {
                conn.Open();
                EnsureSaleTables(conn);

                // Re-check receipts that were incomplete (GrandTotal=0 or no items) on a previous poll.
                CheckPendingReceipts(conn);

                // Re-check return bills that were missing their original-bill ref on a previous poll.
                CheckPendingReturns(conn);

                List<PosReceipt> receipts = FetchNewReceipts(conn);
                RaisePollDiagnostic(receipts);

                foreach (PosReceipt receipt in receipts)
                {
                    if (!OwnsReceipt(receipt)) continue;
                    if (receipt.IsReturn)
                    {
                        if (!string.IsNullOrWhiteSpace(receipt.OriginalDocNo))
                        {
                            // Original-bill ref already present — fire immediately.
                            ReturnDetected?.Invoke(this, receipt);
                        }
                        else
                        {
                            // AdaPos writes the return header ~3 s before it fills FTShdPosCN.
                            // Hold and re-check until the ref appears, instead of dropping the reversal.
                            if (!_pendingReturnCapturedAt.ContainsKey(receipt.DocNo))
                                _pendingReturnCapturedAt[receipt.DocNo] = DateTime.Now;
                            _pendingReturns[receipt.DocNo] = receipt;
                            RaiseDiagnostic("Return pending original-bill ref: " + receipt.DocNo);
                        }
                        continue;
                    }

                    try { FetchLineItems(conn, receipt); }
                    catch (Exception ex) { RaiseDiagnostic("Line-item fetch failed for " + receipt.DocNo + ": " + ex.Message); }

                    try { FetchPayment(conn, receipt); }
                    catch (Exception ex) { RaiseDiagnostic("Payment fetch failed for " + receipt.DocNo + ": " + ex.Message); }

                    if (IsReceiptComplete(receipt))
                    {
                        ReceiptCompleted?.Invoke(this, receipt);
                    }
                    else
                    {
                        // AdaPos hasn't finalized this transaction yet — header is written before items/payment.
                        // Hold it and re-check on every poll until it's complete or times out.
                        if (!_pendingCapturedAt.ContainsKey(receipt.DocNo))
                            _pendingCapturedAt[receipt.DocNo] = DateTime.Now;
                        _pendingReceipts[receipt.DocNo] = receipt;
                        RaiseDiagnostic("Receipt pending finalization: " + receipt.DocNo +
                            " (total=" + receipt.GrandTotal + ", items=" + receipt.Items.Count + ")");
                    }
                }
            }
        }

        private void CheckPendingReceipts(SqlConnection conn)
        {
            if (_pendingReceipts.Count == 0) return;

            DateTime now = DateTime.Now;
            foreach (string docNo in new List<string>(_pendingReceipts.Keys))
            {
                // Discard abandoned/voided transactions that never finalize.
                DateTime capturedAt;
                if (_pendingCapturedAt.TryGetValue(docNo, out capturedAt) &&
                    now - capturedAt > PendingReceiptTimeout)
                {
                    _pendingReceipts.Remove(docNo);
                    _pendingCapturedAt.Remove(docNo);
                    RaiseDiagnostic("Pending receipt timed out (abandoned): " + docNo);
                    continue;
                }

                PosReceipt receipt = _pendingReceipts[docNo];
                try
                {
                    RefreshReceiptHeader(conn, receipt);
                    receipt.Items.Clear();
                    FetchLineItems(conn, receipt);
                    FetchPayment(conn, receipt);

                    if (IsReceiptComplete(receipt))
                    {
                        _pendingReceipts.Remove(docNo);
                        _pendingCapturedAt.Remove(docNo);
                        RaiseDiagnostic("Pending receipt finalized: " + docNo +
                            " (total=" + receipt.GrandTotal + ", items=" + receipt.Items.Count + ")");
                        ReceiptCompleted?.Invoke(this, receipt);
                    }
                }
                catch (Exception ex)
                {
                    RaiseDiagnostic("Pending receipt re-check failed for " + docNo + ": " + ex.Message);
                }
            }
        }

        private void CheckPendingReturns(SqlConnection conn)
        {
            if (_pendingReturns.Count == 0) return;

            DateTime now = DateTime.Now;
            foreach (string docNo in new List<string>(_pendingReturns.Keys))
            {
                PosReceipt receipt = _pendingReturns[docNo];

                DateTime capturedAt;
                bool timedOut = _pendingReturnCapturedAt.TryGetValue(docNo, out capturedAt) &&
                                now - capturedAt > PendingReceiptTimeout;

                if (!timedOut)
                {
                    try
                    {
                        RefreshReturnHeader(conn, receipt);
                    }
                    catch (Exception ex)
                    {
                        RaiseDiagnostic("Pending return re-check failed for " + docNo + ": " + ex.Message);
                        continue; // leave it pending; retry on the next poll until it times out
                    }
                }

                if (!string.IsNullOrWhiteSpace(receipt.OriginalDocNo))
                {
                    _pendingReturns.Remove(docNo);
                    _pendingReturnCapturedAt.Remove(docNo);
                    RaiseDiagnostic("Pending return resolved: " + docNo + " -> original=" + receipt.OriginalDocNo);
                    ReturnDetected?.Invoke(this, receipt);
                }
                else if (timedOut)
                {
                    // Original ref never arrived. Fire anyway so the watermark advances (stops re-fetching)
                    // and TrayAppContext logs the skip; reversal will no-op without an original bill.
                    _pendingReturns.Remove(docNo);
                    _pendingReturnCapturedAt.Remove(docNo);
                    RaiseDiagnostic("Pending return timed out without original-bill ref: " + docNo);
                    ReturnDetected?.Invoke(this, receipt);
                }
            }
        }

        private static bool IsReceiptComplete(PosReceipt receipt)
        {
            return receipt.GrandTotal > 0 && receipt.Items.Count > 0;
        }

        private string ResolveConnectionString()
        {
            if (!string.IsNullOrWhiteSpace(_resolvedConnStr))
                return _resolvedConnStr;

            var errors = new List<string>();
            foreach (string server in BuildServerCandidates())
            {
                string connStr = BuildConnectionString(server);
                try
                {
                    using (var conn = new SqlConnection(connStr))
                    {
                        conn.Open();
                        _resolvedConnStr = connStr;
                        _resolvedServer = server;
                        RaiseDiagnostic("Resolved SQL endpoint: configured=" + _configuredServer + " | active=" + server);
                        return _resolvedConnStr;
                    }
                }
                catch (Exception ex)
                {
                    errors.Add(server + " => " + ex.Message);
                }
            }

            throw new InvalidOperationException(
                "Unable to connect to AdaPos SQL. Tried: " + string.Join(" | ", errors.ToArray()));
        }

        private string BuildConnectionString(string server)
        {
            return new SqlConnectionStringBuilder { DataSource = server, InitialCatalog = _database,
                UserID = _user, Password = _password, ConnectTimeout = 5, ApplicationName = "SCCRMonPOS" }.ConnectionString;
        }

        internal static IEnumerable<string> BuildSetupServerCandidates(string server)
        {
            string host = ExtractHostPart(server);
            if (IsLoopbackHost(host) || IsLocalMachineHost(host))
            {
                int slash = server.IndexOf('\\');
                string name = slash >= 0 ? server.Substring(slash + 1) : "MSSQLSERVER";
                foreach (LocalSqlInstance instance in GetLocalSqlInstances())
                    if (string.Equals(instance.InstanceName, name, StringComparison.OrdinalIgnoreCase) && !string.IsNullOrWhiteSpace(instance.TcpPort) && instance.TcpPort != "0")
                        yield return "127.0.0.1," + instance.TcpPort;
            }
            yield return server;
        }

        private IEnumerable<string> BuildServerCandidates()
        {
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

            foreach (string candidate in BuildConfiguredCandidates())
            {
                if (!string.IsNullOrWhiteSpace(candidate) && seen.Add(candidate))
                    yield return candidate;
            }

            foreach (string candidate in BuildLocalDiscoveryCandidates())
            {
                if (!string.IsNullOrWhiteSpace(candidate) && seen.Add(candidate))
                    yield return candidate;
            }
        }

        private IEnumerable<string> BuildConfiguredCandidates()
        {
            yield return _configuredServer;

            string hostPart = ExtractHostPart(_configuredServer);
            if (string.IsNullOrWhiteSpace(hostPart)) yield break;

            if (IsLoopbackHost(hostPart) || IsLocalMachineHost(hostPart))
            {
                yield return @".\SQLEXPRESS";
                yield return Environment.MachineName + @"\SQLEXPRESS";
                yield return @"localhost\SQLEXPRESS";
            }
        }

        private IEnumerable<string> BuildLocalDiscoveryCandidates()
        {
            foreach (LocalSqlInstance instance in GetLocalSqlInstances())
            {
                yield return @".\" + instance.InstanceName;
                yield return Environment.MachineName + @"\" + instance.InstanceName;
                if (!string.IsNullOrWhiteSpace(instance.TcpPort))
                {
                    yield return "127.0.0.1," + instance.TcpPort;
                    yield return "localhost," + instance.TcpPort;
                    yield return Environment.MachineName + "," + instance.TcpPort;
                }
            }
        }

        private static IEnumerable<LocalSqlInstance> GetLocalSqlInstances()
        {
            var instances = new List<LocalSqlInstance>();
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

            foreach (RegistryView view in new[] { RegistryView.Registry64, RegistryView.Registry32 })
            {
                try
                {
                    using (var baseKey = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, view))
                    using (var namesKey = baseKey.OpenSubKey(@"SOFTWARE\Microsoft\Microsoft SQL Server\Instance Names\SQL"))
                    {
                        if (namesKey == null) continue;

                        foreach (string instanceName in namesKey.GetValueNames())
                        {
                            string instanceId = namesKey.GetValue(instanceName) as string;
                            if (string.IsNullOrWhiteSpace(instanceId)) continue;

                            string fingerprint = instanceName + "|" + instanceId;
                            if (!seen.Add(fingerprint)) continue;

                            instances.Add(new LocalSqlInstance
                            {
                                InstanceName = instanceName,
                                TcpPort = ReadInstanceTcpPort(baseKey, instanceId)
                            });
                        }
                    }
                }
                catch
                {
                    // Local discovery is best-effort only.
                }
            }

            return instances;
        }

        private static string ReadInstanceTcpPort(RegistryKey baseKey, string instanceId)
        {
            if (baseKey == null || string.IsNullOrWhiteSpace(instanceId)) return "";

            string keyPath = @"SOFTWARE\Microsoft\Microsoft SQL Server\" +
                             instanceId +
                             @"\MSSQLServer\SuperSocketNetLib\Tcp\IPAll";
            using (var tcpKey = baseKey.OpenSubKey(keyPath))
            {
                if (tcpKey == null) return "";

                string tcpPort = (tcpKey.GetValue("TcpPort") as string ?? "").Trim();
                if (!string.IsNullOrWhiteSpace(tcpPort)) return tcpPort;

                return (tcpKey.GetValue("TcpDynamicPorts") as string ?? "").Trim();
            }
        }

        private static string ExtractHostPart(string server)
        {
            if (string.IsNullOrWhiteSpace(server)) return "";

            int slash = server.IndexOf('\\');
            if (slash >= 0)
                return server.Substring(0, slash).Trim();

            int comma = server.IndexOf(',');
            if (comma >= 0)
                return server.Substring(0, comma).Trim();

            return server.Trim();
        }

        private static bool IsLoopbackHost(string host)
        {
            return string.Equals(host, ".", StringComparison.OrdinalIgnoreCase)
                || string.Equals(host, "(local)", StringComparison.OrdinalIgnoreCase)
                || string.Equals(host, "localhost", StringComparison.OrdinalIgnoreCase)
                || string.Equals(host, "127.0.0.1", StringComparison.OrdinalIgnoreCase);
        }

        private static bool IsLocalMachineHost(string host)
        {
            return string.Equals(host, Environment.MachineName, StringComparison.OrdinalIgnoreCase);
        }

        private void EnsureSaleTables(SqlConnection conn)
        {
            if (_saleTableSets != null && _saleTableSets.Count > 0)
                return;

            if (_terminal == null) throw new InvalidOperationException("ยังไม่กำหนดเครื่องขายสำหรับอ่านบิล");
            _saleTableSets = DiscoverSaleTableSets(conn);
            _saleTableSets.RemoveAll(set => !string.IsNullOrEmpty(set.PosCode) && set.PosCode != _terminal.PosCode);
            RaiseDiagnostic("Sale tables: " + DescribeTableSets(_saleTableSets));
        }

        private static List<SaleTableSet> DiscoverSaleTableSets(SqlConnection conn)
        {
            var discovered = new List<SaleTableSet>();
            var headerTables = new List<string>();

            const string sql = @"
                SELECT name
                FROM sys.tables
                WHERE name LIKE 'TSHD[0-9][0-9][0-9]'
                   OR name = 'TPSTSalHD'
                ORDER BY name";

            using (var cmd = new SqlCommand(sql, conn))
            using (var reader = cmd.ExecuteReader())
            {
                while (reader.Read())
                    headerTables.Add(Str(reader, "name"));
            }

            foreach (string headerTable in headerTables)
            {
                if (headerTable.StartsWith("TSHD", StringComparison.OrdinalIgnoreCase) && headerTable.Length == 7)
                {
                    string suffix = headerTable.Substring(4);
                    string detailTable = "TSDT" + suffix;
                    string paymentTable = "TSRC" + suffix;
                    if (TableExists(conn, detailTable) && TableExists(conn, paymentTable))
                    {
                        discovered.Add(new SaleTableSet
                        {
                            HeaderTable = headerTable,
                            DetailTable = detailTable,
                            PaymentTable = paymentTable,
                            PosCode = suffix
                        });
                    }
                }
                else if (string.Equals(headerTable, "TPSTSalHD", StringComparison.OrdinalIgnoreCase)
                      && TableExists(conn, "TPSTSalDT")
                      && TableExists(conn, "TPSTSalRC"))
                {
                    discovered.Add(new SaleTableSet
                    {
                        HeaderTable = "TPSTSalHD",
                        DetailTable = "TPSTSalDT",
                        PaymentTable = "TPSTSalRC",
                        PosCode = ""
                    });
                }
            }

            return discovered;
        }

        private static bool TableExists(SqlConnection conn, string tableName)
        {
            using (var cmd = new SqlCommand("SELECT OBJECT_ID(@name, 'U')", conn))
            {
                cmd.Parameters.Add("@name", SqlDbType.VarChar, 128).Value = "dbo." + tableName;
                object result = cmd.ExecuteScalar();
                return result != null && result != DBNull.Value;
            }
        }

        private static string DescribeTableSets(List<SaleTableSet> sets)
        {
            if (sets == null || sets.Count == 0)
                return "none";

            var parts = new List<string>();
            foreach (SaleTableSet set in sets)
            {
                string label = string.IsNullOrWhiteSpace(set.PosCode) ? "fallback" : "pos " + set.PosCode;
                parts.Add(label + "=" + set.HeaderTable + "/" + set.DetailTable + "/" + set.PaymentTable);
            }

            return string.Join(", ", parts.ToArray());
        }

        // ── SQL: new receipts since watermark ─────────────────────────────────

        private List<PosReceipt> FetchNewReceipts(SqlConnection conn)
        {
            if (_saleTableSets == null || _saleTableSets.Count == 0)
                return new List<PosReceipt>();

            var sqlParts = new List<string>();
            foreach (SaleTableSet set in _saleTableSets)
            {
                sqlParts.Add(@"
                SELECT '" + set.HeaderTable + @"' AS SourceHeaderTable,
                       '" + set.DetailTable + @"' AS SourceDetailTable,
                       '" + set.PaymentTable + @"' AS SourcePaymentTable,
                       h.FTShdDocNo,    h.FTShdDocType,  h.FTBchCode,
                       h.FTPosCode,     h.FTUsrCode,
                       h.FDShdDocDate,  h.FTShdDocTime,
                       h.FDDateIns,     h.FTTimeIns,
                       h.FCShdGrand,    h.FCShdDis,
                       h.FCShdMnyCsh,   h.FCShdChn,
                       h.FTShdStaRefund, h.FTShdPosCN
                FROM   " + set.HeaderTable + @" h
                WHERE h.FTBchCode = @receiptBranch AND h.FTPosCode = @receiptPos
                  AND h.FTShdStaPaid = '3'");
            }

            string sql = @"
                SELECT *
                FROM (
" + string.Join(@"
                    UNION ALL", sqlParts.ToArray()) + @"
                ) h
                WHERE  (h.FDDateIns  > @ld)
                   OR  (h.FDDateIns  = @ld AND h.FTTimeIns > @lt)
                   OR  (h.FDDateIns  = @ld AND h.FTTimeIns = @lt AND h.FTShdDocNo > @doc)
                ORDER BY h.FDDateIns, h.FTTimeIns, h.FTShdDocNo";

            using (var cmd = new SqlCommand(sql, conn))
            {
                _terminal.AddParameters(cmd);
                cmd.Parameters.Add("@ld", SqlDbType.DateTime).Value   = _watermark.InsertDate;
                cmd.Parameters.Add("@lt", SqlDbType.VarChar, 8).Value = _watermark.InsertTime ?? "";
                cmd.Parameters.Add("@doc", SqlDbType.VarChar, 50).Value = _watermark.DocNo ?? "";

                var list = new List<PosReceipt>();
                using (var r = cmd.ExecuteReader())
                {
                    while (r.Read())
                    {
                        string docType = Str(r, "FTShdDocType");
                        list.Add(new PosReceipt
                        {
                            DocNo         = Str(r,  "FTShdDocNo"),
                            DocType       = docType,
                            IsReturn      = docType == "9",
                            BranchCode    = Str(r,  "FTBchCode"),
                            PosCode       = Str(r,  "FTPosCode"),
                            CashierCode   = Str(r,  "FTUsrCode"),
                            DocDate       = Date(r, "FDShdDocDate"),
                            DocTime       = Str(r,  "FTShdDocTime"),
                            InsertDate    = Date(r, "FDDateIns"),
                            InsertTime    = Str(r,  "FTTimeIns"),
                            GrandTotal    = Dec(r,  "FCShdGrand"),
                            Discount      = Dec(r,  "FCShdDis"),
                            CashAmount    = Dec(r,  "FCShdMnyCsh"),
                            ChangeGiven   = Dec(r,  "FCShdChn"),
                            OriginalDocNo = Str(r,  "FTShdPosCN"),
                            HeaderTable   = Str(r,  "SourceHeaderTable"),
                            DetailTable   = Str(r,  "SourceDetailTable"),
                            PaymentTable  = Str(r,  "SourcePaymentTable"),
                        });
                    }
                }
                return list;
            }
        }

        // ── SQL: refresh mutable header fields for a pending receipt ─────────

        private void RefreshReceiptHeader(SqlConnection conn, PosReceipt receipt)
        {
            _terminal.Require(receipt);
            string sql = @"
                SELECT FCShdGrand, FCShdDis, FCShdMnyCsh, FCShdChn
                FROM   " + GetSafeTableName(receipt.HeaderTable, "TPSTSalHD") + @"
                WHERE  FTShdDocNo = @docNo AND FTBchCode = @receiptBranch AND FTPosCode = @receiptPos";

            using (var cmd = new SqlCommand(sql, conn))
            {
                _terminal.AddParameters(cmd);
                cmd.Parameters.Add("@docNo", SqlDbType.VarChar, 50).Value = receipt.DocNo;
                using (var r = cmd.ExecuteReader())
                {
                    if (r.Read())
                    {
                        receipt.GrandTotal  = Dec(r, "FCShdGrand");
                        receipt.Discount    = Dec(r, "FCShdDis");
                        receipt.CashAmount  = Dec(r, "FCShdMnyCsh");
                        receipt.ChangeGiven = Dec(r, "FCShdChn");
                    }
                }
            }
        }

        // ── SQL: refresh original-bill ref for a pending return ───────────────

        private void RefreshReturnHeader(SqlConnection conn, PosReceipt receipt)
        {
            _terminal.Require(receipt);
            string sql = @"
                SELECT FCShdGrand, FTShdPosCN
                FROM   " + GetSafeTableName(receipt.HeaderTable, "TPSTSalHD") + @"
                WHERE  FTShdDocNo = @docNo AND FTBchCode = @receiptBranch AND FTPosCode = @receiptPos";

            using (var cmd = new SqlCommand(sql, conn))
            {
                _terminal.AddParameters(cmd);
                cmd.Parameters.Add("@docNo", SqlDbType.VarChar, 50).Value = receipt.DocNo;
                using (var r = cmd.ExecuteReader())
                {
                    if (r.Read())
                    {
                        receipt.GrandTotal    = Dec(r, "FCShdGrand");
                        receipt.OriginalDocNo = Str(r, "FTShdPosCN");
                    }
                }
            }
        }

        // ── SQL: line items for one receipt ───────────────────────────────────

        private void FetchLineItems(SqlConnection conn, PosReceipt receipt)
        {
            _terminal.Require(receipt);
            string sql = @"
                SELECT d.FNSdtSeqNo,   d.FTPdtCode,    d.FTPdtName,
                       d.FTSdtBarCode, d.FCSdtQty,     d.FCSdtSetPrice,
                       d.FCSdtNet,     d.FCSdtDis,     d.FTPmhCode,
                       d.FTPunCode,    d.FTSdtUnitName
                FROM   " + GetSafeTableName(receipt.DetailTable, "TPSTSalDT") + @" d
                WHERE  d.FTShdDocNo = @docNo
                  AND d.FTBchCode = @receiptBranch
                  AND EXISTS (SELECT 1 FROM " + GetSafeTableName(receipt.HeaderTable, "TPSTSalHD") + @" h
                      WHERE h.FTShdDocNo = d.FTShdDocNo AND h.FTBchCode = @receiptBranch AND h.FTPosCode = @receiptPos)
                ORDER BY d.FNSdtSeqNo";

            using (var cmd = new SqlCommand(sql, conn))
            {
                _terminal.AddParameters(cmd);
                cmd.Parameters.Add("@docNo", SqlDbType.VarChar, 50).Value = receipt.DocNo;
                using (var r = cmd.ExecuteReader())
                {
                    while (r.Read())
                    {
                        receipt.Items.Add(new PosReceiptItem
                        {
                            Seq           = Int(r, "FNSdtSeqNo"),
                            ProductCode   = Str(r, "FTPdtCode"),
                            ProductName   = Str(r, "FTPdtName"),
                            Barcode       = Str(r, "FTSdtBarCode"),
                            UnitCode      = Str(r, "FTPunCode"),
                            UnitName      = Str(r, "FTSdtUnitName"),
                            Qty           = Dec(r, "FCSdtQty"),
                            UnitPrice     = Dec(r, "FCSdtSetPrice"),
                            NetAmount     = Dec(r, "FCSdtNet"),
                            LineDiscount  = Dec(r, "FCSdtDis"),
                            PromotionCode = Str(r, "FTPmhCode"),
                        });
                    }
                }
            }
        }

        // ── SQL: primary payment method for one receipt ────────────────────────

        private void FetchPayment(SqlConnection conn, PosReceipt receipt)
        {
            _terminal.Require(receipt);
            string sql = @"
                SELECT TOP 1 p.FTRcvCode, p.FTRcvName, p.FTSrcRef
                FROM   " + GetSafeTableName(receipt.PaymentTable, "TPSTSalRC") + @" p
                WHERE  p.FTShdDocNo = @docNo
                  AND EXISTS (SELECT 1 FROM " + GetSafeTableName(receipt.HeaderTable, "TPSTSalHD") + @" h
                      WHERE h.FTShdDocNo = p.FTShdDocNo AND h.FTBchCode = @receiptBranch AND h.FTPosCode = @receiptPos)
                ORDER BY p.FNSrcSeqNo";

            using (var cmd = new SqlCommand(sql, conn))
            {
                _terminal.AddParameters(cmd);
                cmd.Parameters.Add("@docNo", SqlDbType.VarChar, 50).Value = receipt.DocNo;
                using (var r = cmd.ExecuteReader())
                {
                    if (r.Read())
                    {
                        receipt.PaymentCode  = Str(r, "FTRcvCode");
                        receipt.PaymentName  = Str(r, "FTRcvName");
                        receipt.PromptPayRef = Str(r, "FTSrcRef");
                    }
                }
            }
        }

        // ── SqlDataReader helpers ─────────────────────────────────────────────

        private void RaiseDiagnostic(string message)
        {
            if (!_diagnosticsEnabled && (message ?? "").IndexOf("Resolved SQL endpoint", StringComparison.OrdinalIgnoreCase) < 0)
                return;
            WatcherDiagnostic?.Invoke(this, message);
        }

        private void RaisePollDiagnostic(List<PosReceipt> receipts)
        {
            if (!_diagnosticsEnabled) return;

            string newest = receipts.Count == 0
                ? "none"
                : receipts[receipts.Count - 1].DocNo + "@" + receipts[receipts.Count - 1].InsertTime;
            RaiseDiagnostic(
                "Poll summary: watermark=" + (_watermark == null ? "-" : _watermark.Describe()) +
                " | rows=" + receipts.Count +
                " | newest=" + newest +
                " | server=" + (_resolvedServer ?? _configuredServer));
        }

        private static string   Str(SqlDataReader r, string col) { var v = r[col]; return v == DBNull.Value ? "" : v.ToString().Trim(); }
        private static decimal  Dec(SqlDataReader r, string col) { var v = r[col]; return v == DBNull.Value ? 0m : Convert.ToDecimal(v); }
        private static int      Int(SqlDataReader r, string col) { var v = r[col]; return v == DBNull.Value ? 0  : Convert.ToInt32(v); }
        private static DateTime Date(SqlDataReader r, string col){ var v = r[col]; return v == DBNull.Value ? DateTime.Today : (DateTime)v; }
        private static string GetSafeTableName(string tableName, string fallback)
        {
            string value = string.IsNullOrWhiteSpace(tableName) ? fallback : tableName.Trim();
            foreach (char ch in value)
            {
                if (!(char.IsLetterOrDigit(ch) || ch == '_'))
                    return fallback;
            }
            return value;
        }

        // ── Config helpers ────────────────────────────────────────────────────

        private static string Cfg(string key, string def)
        {
            return AppSettingsProvider.Get(key, def);
        }

        private static bool ReadBool(string key, bool def)
        {
            return AppSettingsProvider.GetBool(key, def);
        }

        private static int ReadInt(string key, int def)
        {
            return AppSettingsProvider.GetInt(key, def);
        }

        private sealed class LocalSqlInstance
        {
            public string InstanceName { get; set; }
            public string TcpPort { get; set; }
        }

        private sealed class SaleTableSet
        {
            public string HeaderTable { get; set; }
            public string DetailTable { get; set; }
            public string PaymentTable { get; set; }
            public string PosCode { get; set; }
        }
    }
}
