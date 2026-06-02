using System;
using System.Configuration;
using System.Drawing;
using System.IO;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace SCCRMonPOS
{
    /// <summary>
    /// Application context living entirely in the system tray.
    /// No main window — the app is headless until a barcode is scanned or the
    /// operator right-clicks the tray icon.
    ///
    /// Start-up sequence:
    ///   1. Load auth (StaffAuthManager) — DPAPI-encrypted token from disk.
    ///   2. If token present and not expired: init scanner, drain offline queue.
    ///   3. If token missing or expired: prompt PIN entry before starting scanner.
    /// </summary>
    public class TrayAppContext : ApplicationContext
    {
        private readonly string _dataFolder =
            Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "data");

        private NotifyIcon          _trayIcon;
        private ScannerInputService _scanner;
        private AdaPosWatcher       _watcher;
        private ApiClient           _api;
        private ProductEligibilityClient _productEligibility;
        private StaffAuthManager    _auth;
        private TransactionRepository _txRepo;
        private OfflineQueue          _offlineQueue;
        private readonly bool _requireProductScreening;

        // Only one member-point popup may be open at a time
        private MemberPointForm _activeForm;

        // Most-recently completed AdaPos receipt, waiting for a CRM barcode scan.
        // Written from the watcher background thread; read on the UI thread — guarded by _receiptLock.
        private PosReceipt        _standingByReceipt;
        private readonly object   _receiptLock = new object();

        // Tray menu items
        private ToolStripMenuItem _miSyncPending;
        private ToolStripMenuItem _miWatcherStatus;

        // ────────────────────────────────────────────────────────────────────
        public TrayAppContext()
        {
            Directory.CreateDirectory(_dataFolder);

            string baseUrl = ConfigurationManager.AppSettings["ApiBaseUrl"]
                          ?? "https://sc-official-website.onrender.com";
            string productEligibilityBaseUrl = ConfigurationManager.AppSettings["ProductEligibilityApiBaseUrl"] ?? "";
            string productEligibilityApiKey  = ConfigurationManager.AppSettings["ProductEligibilityApiKey"] ?? "";

            _api                     = new ApiClient(baseUrl);
            _productEligibility      = new ProductEligibilityClient(productEligibilityBaseUrl, productEligibilityApiKey);
            _auth                    = new StaffAuthManager(_dataFolder);
            _txRepo                  = new TransactionRepository(_dataFolder);
            _offlineQueue            = new OfflineQueue(_dataFolder);
            _requireProductScreening = ReadBool("RequireProductScreeningForPoints", true);

            if (_auth.HasToken)
                _api.SetStaffToken(_auth.StaffToken);

            InitTrayIcon();

            if (!_auth.HasToken || _api.IsTokenExpired())
            {
                // First run, or token missing/expired — prompt before going live
                if (_auth.HasToken && _api.IsTokenExpired())
                    _auth.ClearToken();  // discard the stale token

                ScheduleOnUiThread(PromptStaffLogin);
            }
            else
            {
                InitScanner();
                InitWatcher();
                UpdateSyncMenuItem();
                _trayIcon.ShowBalloonTip(2000, "SCCRM", "พร้อมรับการสแกนบาร์โค้ด", ToolTipIcon.Info);

                // Silently retry any queued earn requests from a previous offline session
                if (_offlineQueue.Count > 0)
                    _ = DrainOfflineQueueAsync(silent: true);
            }
        }

        // ── Staff login ────────────────────────────────────────────────────────

        private void PromptStaffLogin()
        {
            var loginForm = new StaffLoginForm(_api, _auth);
            DialogResult result = loginForm.ShowDialog();

            if (result == DialogResult.OK)
            {
                InitScanner();
                InitWatcher();
                UpdateSyncMenuItem();
                _trayIcon.ShowBalloonTip(2000, "SCCRM",
                    "เข้าสู่ระบบสำเร็จ — พร้อมรับการสแกน", ToolTipIcon.Info);

                if (_offlineQueue.Count > 0)
                    _ = DrainOfflineQueueAsync(silent: false);
            }
            else
            {
                // Operator cancelled — exit immediately
                Application.Exit();
            }
        }

        // ── Tray icon ─────────────────────────────────────────────────────────

        private void InitTrayIcon()
        {
            _miSyncPending = new ToolStripMenuItem("รายการรอส่ง (0)", null, OnSyncPending)
            {
                Enabled = false
            };

            _miWatcherStatus = new ToolStripMenuItem("AdaPos DB: รอเชื่อมต่อ…")
            {
                Enabled = false
            };

            var menu = new ContextMenuStrip();
            menu.Items.Add("เปิดหน้าต่างค้นหาสมาชิก", null, OnOpenSearchWindow);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(_miSyncPending);
            menu.Items.Add(_miWatcherStatus);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("เปลี่ยน PIN / Device",     null, OnReAuthenticate);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("ออกจากโปรแกรม",            null, OnExit);

            _trayIcon = new NotifyIcon
            {
                Icon             = BuildTrayIcon(),
                ContextMenuStrip = menu,
                Text             = "SCCRM — POS Companion",
                Visible          = true
            };

            _trayIcon.DoubleClick += (s, e) => OnOpenSearchWindow(s, e);
        }

        // ── Scanner ────────────────────────────────────────────────────────────

        private void InitScanner()
        {
            if (_scanner != null) return;
            _scanner = new ScannerInputService();
            _scanner.PointScanDetected  += OnPointScan;
            _scanner.RedeemScanDetected += OnRedeemScan;
            _scanner.Start();
        }

        // ── AdaPos DB watcher ──────────────────────────────────────────────────

        private void InitWatcher()
        {
            if (_watcher != null) return;
            _watcher = new AdaPosWatcher();
            if (!_watcher.IsEnabled) return;

            _watcher.ReceiptCompleted    += OnReceiptCompleted;
            _watcher.ReturnDetected      += OnReturnDetected;
            _watcher.WatcherConnected    += OnWatcherConnected;
            _watcher.WatcherDisconnected += OnWatcherDisconnected;
            _watcher.Start();
        }

        // Called from the watcher background thread — only update in-memory state here.
        private void OnReceiptCompleted(object sender, PosReceipt receipt)
        {
            lock (_receiptLock)
                _standingByReceipt = receipt;
        }

        private void OnReturnDetected(object sender, PosReceipt receipt)
        {
            // Overwrite standing-by with the return so it doesn't trigger loyalty on a refund
            lock (_receiptLock)
                _standingByReceipt = null;

            ScheduleOnUiThread(() =>
                _trayIcon.ShowBalloonTip(4000, "SCCRM — คืนสินค้า",
                    $"ตรวจพบรายการคืนสินค้า {receipt.DocNo}\n" +
                    $"อ้างอิงบิลเดิม: {receipt.OriginalDocNo}\n" +
                    "กรุณาตรวจสอบแต้มใน CRM",
                    ToolTipIcon.Warning));
        }

        private void OnWatcherConnected(object sender, EventArgs e)
        {
            ScheduleOnUiThread(() =>
            {
                if (_miWatcherStatus != null)
                    _miWatcherStatus.Text = "AdaPos DB: เชื่อมต่อแล้ว ✓";
            });
        }

        private void OnWatcherDisconnected(object sender, string errorMessage)
        {
            lock (_receiptLock)
                _standingByReceipt = null;

            ScheduleOnUiThread(() =>
            {
                if (_miWatcherStatus != null)
                    _miWatcherStatus.Text = "AdaPos DB: ขาดการเชื่อมต่อ ⚠";
                _trayIcon.ShowBalloonTip(4000, "SCCRM — AdaPos DB",
                    "ขาดการเชื่อมต่อกับฐานข้อมูล AdaPos\nจะลองเชื่อมต่อใหม่อัตโนมัติ",
                    ToolTipIcon.Warning);
            });
        }

        // ── Scanner events ─────────────────────────────────────────────────────

        private void OnPointScan(object sender, string scanToken)
        {
            ScheduleOnUiThread(() =>
            {
                // Pre-check expiry before opening the form
                if (_api.IsTokenExpired())
                {
                    _trayIcon.ShowBalloonTip(3000, "SCCRM",
                        "หมดอายุการเข้าสู่ระบบ กรุณายืนยันตัวตนพนักงานอีกครั้ง",
                        ToolTipIcon.Warning);
                    HandleSessionExpired();
                    return;
                }
                OpenPointForm(scanToken);
            });
        }

        private void OnRedeemScan(object sender, string scanToken)
        {
            _trayIcon.ShowBalloonTip(
                3000, "SCCRM",
                "การแลกแต้มยังไม่รองรับในเวอร์ชันนี้",
                ToolTipIcon.Warning);
        }

        // ── Tray menu handlers ─────────────────────────────────────────────────

        private void OnOpenSearchWindow(object sender, EventArgs e)
        {
            if (_activeForm != null && !_activeForm.IsDisposed)
            {
                _activeForm.BringToFront();
                _activeForm.Activate();
                return;
            }

            if (_api.IsTokenExpired())
            {
                _trayIcon.ShowBalloonTip(3000, "SCCRM",
                    "หมดอายุการเข้าสู่ระบบ กรุณายืนยันตัวตนพนักงานก่อน",
                    ToolTipIcon.Warning);
                HandleSessionExpired();
                return;
            }

            OpenPointForm(string.Empty);
        }

        private void OnSyncPending(object sender, EventArgs e)
        {
            if (_offlineQueue.Count == 0)
            {
                MessageBox.Show("ไม่มีรายการรอส่ง", "SCCRM", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            _ = DrainOfflineQueueAsync(silent: false);
        }

        private void OnReAuthenticate(object sender, EventArgs e)
        {
            _auth.ClearToken();
            _scanner?.Stop();
            _scanner?.Dispose();
            _scanner = null;
            _watcher?.Stop();
            _watcher?.Dispose();
            _watcher = null;
            lock (_receiptLock) _standingByReceipt = null;
            PromptStaffLogin();
        }

        private void OnExit(object sender, EventArgs e)
        {
            _scanner?.Stop();
            _watcher?.Stop();
            _trayIcon.Visible = false;
            Application.Exit();
        }

        // ── Token expiry recovery ──────────────────────────────────────────────

        /// <summary>
        /// Called when MemberPointForm fires SessionExpired or when a pre-check
        /// detects an expired token before opening the form.
        /// </summary>
        private void HandleSessionExpired()
        {
            _auth.ClearToken();
            _scanner?.Stop();
            _scanner?.Dispose();
            _scanner = null;
            _watcher?.Stop();
            _watcher?.Dispose();
            _watcher = null;
            lock (_receiptLock) _standingByReceipt = null;
            PromptStaffLogin();
        }

        // ── Offline queue ──────────────────────────────────────────────────────

        private async Task DrainOfflineQueueAsync(bool silent)
        {
            if (_api.IsTokenExpired()) return;

            try
            {
                DrainResult r = await _offlineQueue.DrainAsync(_api);

                UpdateSyncMenuItem();

                if (!silent || r.Submitted > 0)
                {
                    string msg = r.Submitted > 0
                        ? $"ส่งรายการค้าง {r.Submitted} รายการเรียบร้อย" +
                          (r.Failed > 0 ? $"\nยังค้างอยู่ {r.Failed} รายการ" : "")
                        : $"มีรายการค้าง {r.Failed} รายการ ส่งไม่สำเร็จ กรุณาลองใหม่";

                    _trayIcon.ShowBalloonTip(
                        4000, "SCCRM — รายการค้าง",
                        msg,
                        r.Failed == 0 ? ToolTipIcon.Info : ToolTipIcon.Warning);
                }
            }
            catch { /* drain errors are non-fatal */ }
        }

        private void UpdateSyncMenuItem()
        {
            if (_miSyncPending == null) return;
            int count = _offlineQueue.Count;
            _miSyncPending.Text    = $"รายการรอส่ง ({count})";
            _miSyncPending.Enabled = count > 0;
        }

        // ── Helpers ────────────────────────────────────────────────────────────

        private void OpenPointForm(string scanToken)
        {
            if (_activeForm != null && !_activeForm.IsDisposed)
                return;

            // Consume the standing-by receipt — cleared so the next sale starts fresh
            PosReceipt receipt;
            lock (_receiptLock)
            {
                receipt = _standingByReceipt;
                _standingByReceipt = null;
            }

            _activeForm = new MemberPointForm(
                scanToken, _api, _txRepo, _offlineQueue, _productEligibility,
                _requireProductScreening, receipt);
            _activeForm.SessionExpired += (s, e) =>
            {
                // MemberPointForm already closed itself; now handle re-auth
                ScheduleOnUiThread(HandleSessionExpired);
            };
            _activeForm.FormClosed += (s, e) =>
            {
                _activeForm = null;
                UpdateSyncMenuItem();   // refresh in case something was queued
            };
            _activeForm.Show();
            _activeForm.BringToFront();
        }

        private static void ScheduleOnUiThread(Action action)
        {
            var t = new Timer { Interval = 1 };
            t.Tick += (s, e) =>
            {
                t.Stop();
                t.Dispose();
                action();
            };
            t.Start();
        }

        private static bool ReadBool(string key, bool defaultValue)
        {
            string raw = ConfigurationManager.AppSettings[key];
            bool parsed;
            return bool.TryParse(raw, out parsed) ? parsed : defaultValue;
        }

        private static Icon BuildTrayIcon()
        {
            using (var bmp = new Bitmap(16, 16))
            using (var g   = Graphics.FromImage(bmp))
            {
                g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
                g.Clear(Color.Transparent);
                g.FillEllipse(new SolidBrush(Color.FromArgb(11, 31, 184)), 0, 0, 15, 15);
                g.DrawString("S",
                    new Font("Arial", 8f, FontStyle.Bold),
                    Brushes.White,
                    new PointF(1.5f, 0.5f));
                IntPtr hIcon = bmp.GetHicon();
                return (Icon)Icon.FromHandle(hIcon).Clone();
            }
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                _scanner?.Dispose();
                _watcher?.Dispose();
                _trayIcon?.Dispose();
            }
            base.Dispose(disposing);
        }
    }
}
