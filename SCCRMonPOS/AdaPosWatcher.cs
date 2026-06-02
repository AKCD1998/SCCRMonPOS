using System;
using System.Collections.Generic;
using System.Configuration;
using System.Data;
using System.Data.SqlClient;
using System.Threading;
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

        // ── Config ────────────────────────────────────────────────────────────

        private readonly string _connStr;
        private readonly int    _pollMs;
        private readonly bool   _enabled;

        // ── State ─────────────────────────────────────────────────────────────

        private Thread       _thread;
        private volatile bool _running;
        private DateTime     _lastDate;   // watermark date (midnight)
        private string       _lastTime;   // watermark time "HH:MM:SS"
        private bool         _dbOnline;   // tracks last-known connection state

        // ─────────────────────────────────────────────────────────────────────

        public AdaPosWatcher()
        {
            _enabled = ReadBool("AdaPosEnabled", true);

            string server   = Cfg("AdaPosDbServer",   "192.168.0.127,49683");
            string database = Cfg("AdaPosDbName",     "AdaAcc");
            string user     = Cfg("AdaPosDbUser",     "sa");
            string password = Cfg("AdaPosDbPassword", "adasoft");
            _pollMs = ReadInt("AdaPosPollMs", 3000);

            _connStr =
                $"Server={server};Database={database};" +
                $"User Id={user};Password={password};" +
                "Connect Timeout=5;Application Name=SCCRMonPOS;";
        }

        // ── Public API ────────────────────────────────────────────────────────

        public bool IsEnabled => _enabled;

        public void Start()
        {
            if (!_enabled || _thread != null) return;

            // Watermark starts at this moment — historical receipts are ignored
            _lastDate = DateTime.Today;
            _lastTime = DateTime.Now.ToString("HH:mm:ss");

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

        public void Dispose() => Stop();

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
            using (var conn = new SqlConnection(_connStr))
            {
                conn.Open();

                foreach (PosReceipt receipt in FetchNewReceipts(conn))
                {
                    FetchLineItems(conn, receipt);
                    FetchPayment(conn, receipt);

                    // Advance watermark before firing so a handler exception
                    // never causes the same receipt to be processed twice.
                    _lastDate = receipt.InsertDate;
                    _lastTime = receipt.InsertTime;

                    if (receipt.IsReturn)
                        ReturnDetected?.Invoke(this, receipt);
                    else
                        ReceiptCompleted?.Invoke(this, receipt);
                }
            }
        }

        // ── SQL: new receipts since watermark ─────────────────────────────────

        private List<PosReceipt> FetchNewReceipts(SqlConnection conn)
        {
            const string sql = @"
                SELECT h.FTShdDocNo,    h.FTShdDocType,  h.FTBchCode,
                       h.FTPosCode,     h.FTUsrCode,
                       h.FDShdDocDate,  h.FTShdDocTime,
                       h.FDDateIns,     h.FTTimeIns,
                       h.FCShdGrand,    h.FCShdDis,
                       h.FCShdMnyCsh,   h.FCShdChn,
                       h.FTShdStaRefund, h.FTShdPosCN
                FROM   TPSTSalHD h
                WHERE  (h.FDDateIns  > @ld)
                   OR  (h.FDDateIns  = @ld AND h.FTTimeIns > @lt)
                ORDER BY h.FDDateIns, h.FTTimeIns";

            using (var cmd = new SqlCommand(sql, conn))
            {
                cmd.Parameters.Add("@ld", SqlDbType.DateTime).Value   = _lastDate;
                cmd.Parameters.Add("@lt", SqlDbType.VarChar, 8).Value = _lastTime;

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
                        });
                    }
                }
                return list;
            }
        }

        // ── SQL: line items for one receipt ───────────────────────────────────

        private static void FetchLineItems(SqlConnection conn, PosReceipt receipt)
        {
            const string sql = @"
                SELECT d.FNSdtSeqNo,   d.FTPdtCode,    d.FTPdtName,
                       d.FTSdtBarCode, d.FCSdtQty,     d.FCSdtSetPrice,
                       d.FCSdtNet,     d.FCSdtDis,     d.FTPmhCode
                FROM   TPSTSalDT d
                WHERE  d.FTShdDocNo = @docNo
                ORDER BY d.FNSdtSeqNo";

            using (var cmd = new SqlCommand(sql, conn))
            {
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

        private static void FetchPayment(SqlConnection conn, PosReceipt receipt)
        {
            const string sql = @"
                SELECT TOP 1 FTRcvCode, FTRcvName, FTSrcRef
                FROM   TPSTSalRC
                WHERE  FTShdDocNo = @docNo
                ORDER BY FNSrcSeqNo";

            using (var cmd = new SqlCommand(sql, conn))
            {
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

        private static string   Str(SqlDataReader r, string col) { var v = r[col]; return v == DBNull.Value ? "" : v.ToString().Trim(); }
        private static decimal  Dec(SqlDataReader r, string col) { var v = r[col]; return v == DBNull.Value ? 0m : Convert.ToDecimal(v); }
        private static int      Int(SqlDataReader r, string col) { var v = r[col]; return v == DBNull.Value ? 0  : Convert.ToInt32(v); }
        private static DateTime Date(SqlDataReader r, string col){ var v = r[col]; return v == DBNull.Value ? DateTime.Today : (DateTime)v; }

        // ── Config helpers ────────────────────────────────────────────────────

        private static string Cfg(string key, string def) =>
            ConfigurationManager.AppSettings[key] ?? def;

        private static bool ReadBool(string key, bool def)
        {
            string raw = ConfigurationManager.AppSettings[key];
            return bool.TryParse(raw, out bool v) ? v : def;
        }

        private static int ReadInt(string key, int def)
        {
            string raw = ConfigurationManager.AppSettings[key];
            return int.TryParse(raw, out int v) ? v : def;
        }
    }
}
