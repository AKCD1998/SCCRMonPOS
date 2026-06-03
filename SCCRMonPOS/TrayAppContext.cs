using System;
using System.Configuration;
using System.Drawing;
using System.IO;
using System.Windows.Forms;
using SCCRMonPOS.Models;

namespace SCCRMonPOS
{
    /// <summary>
    /// Application context living entirely in the system tray.
    ///
    /// Start-up:
    ///   1. Load auth. If missing/expired, prompt login.
    ///   2. Start AdaPosWatcher silently — caches latest completed receipt.
    ///   3. Register Ctrl+Alt+Q hotkey — opens MemberClaimForm on demand.
    ///
    /// The app never auto-pops any window after a sale. Everything is cashier-triggered.
    /// </summary>
    public class TrayAppContext : ApplicationContext
    {
        private readonly string _dataFolder =
            Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "data");

        private NotifyIcon          _trayIcon;
        private AdaPosWatcher       _watcher;
        private GlobalHotKeyManager _hotKey;
        private ApiClient           _api;
        private StaffAuthManager    _auth;
        private ReceiptWatermarkStore _watermarkStore;
        private readonly bool _watcherDiagnosticsEnabled;
        private readonly string _runtimeLogPath;
        private readonly ReceiptWatermark _initialWatcherWatermark;
        private readonly int _bahtPerPoint;

        // Latest completed receipt — used to pre-fill MemberClaimForm (never auto-shown).
        private PosReceipt      _standingByReceipt;
        private readonly object _receiptLock = new object();
        private MemberClaimForm _activeMemberClaimForm;
        private ToolStripMenuItem _miWatcherStatus;

        // ─────────────────────────────────────────────────────────────────────

        public TrayAppContext()
        {
            Directory.CreateDirectory(_dataFolder);

            string baseUrl = ConfigurationManager.AppSettings["ApiBaseUrl"]
                          ?? "https://sc-official-website.onrender.com";

            _api                      = new ApiClient(baseUrl);
            _api.SetPosApiKey(ConfigurationManager.AppSettings["PosApiKey"] ?? "");
            _auth                     = new StaffAuthManager(_dataFolder);
            _watermarkStore           = new ReceiptWatermarkStore(_dataFolder);
            _watcherDiagnosticsEnabled = ReadBool("WatcherDiagnosticsEnabled", true);
            _bahtPerPoint             = ReadInt("BahtPerPoint", 10);
            _runtimeLogPath           = Path.Combine(_dataFolder, "runtime.log");
            _initialWatcherWatermark  = LoadOrCreateWatcherWatermark();

            LogRuntime("Application starting.");

            if (_auth.HasToken)
                _api.SetStaffToken(_auth.StaffToken);

            InitTrayIcon();

            if (!_auth.HasToken || _api.IsTokenExpired())
            {
                if (_auth.HasToken && _api.IsTokenExpired())
                    _auth.ClearToken();
                ScheduleOnUiThread(PromptStaffLogin);
            }
            else
            {
                InitWatcher();
                _trayIcon.ShowBalloonTip(2000, "SCCRM", "พร้อมใช้งาน — กด Ctrl+Alt+Q เพื่อสะสมแต้ม", ToolTipIcon.Info);
            }
        }

        // ── Staff login ────────────────────────────────────────────────────────

        private void PromptStaffLogin()
        {
            var loginForm = new StaffLoginForm(_api, _auth);
            DialogResult result = loginForm.ShowDialog();

            if (result == DialogResult.OK)
            {
                InitWatcher();
                _trayIcon.ShowBalloonTip(2000, "SCCRM",
                    "เข้าสู่ระบบสำเร็จ — กด Ctrl+Alt+Q เพื่อสะสมแต้ม", ToolTipIcon.Info);
            }
            else
            {
                Application.Exit();
            }
        }

        // ── Tray icon ─────────────────────────────────────────────────────────

        private void InitTrayIcon()
        {
            _miWatcherStatus = new ToolStripMenuItem("AdaPos DB: รอเชื่อมต่อ…")
            {
                Enabled = false
            };

            var menu = new ContextMenuStrip();
            menu.Items.Add("สะสมแต้ม (Ctrl+Alt+Q)", null, (s, e) => OpenMemberClaimForm());
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(_miWatcherStatus);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("เปลี่ยน PIN / Device", null, OnReAuthenticate);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("ออกจากโปรแกรม",        null, OnExit);

            _trayIcon = new NotifyIcon
            {
                Icon             = BuildTrayIcon(),
                ContextMenuStrip = menu,
                Text             = "SCCRM — POS Companion",
                Visible          = true
            };

            _trayIcon.DoubleClick += (s, e) => OpenMemberClaimForm();
        }

        // ── AdaPos DB watcher ──────────────────────────────────────────────────

        private void InitWatcher()
        {
            if (_watcher != null) return;
            _watcher = new AdaPosWatcher(_initialWatcherWatermark, _watcherDiagnosticsEnabled);
            if (!_watcher.IsEnabled)
            {
                LogRuntime("AdaPos watcher is disabled by config.");
                return;
            }

            _watcher.ReceiptCompleted    += OnReceiptCompleted;
            _watcher.ReturnDetected      += OnReturnDetected;
            _watcher.WatcherConnected    += OnWatcherConnected;
            _watcher.WatcherDisconnected += OnWatcherDisconnected;
            _watcher.WatcherDiagnostic   += (s, msg) => LogRuntime(msg);
            _watcher.Start();
            LogRuntime("AdaPos watcher started.");

            RegisterHotKey();
        }

        // Called from the watcher background thread — cache only, no auto-popup.
        private void OnReceiptCompleted(object sender, PosReceipt receipt)
        {
            LogRuntime(
                "Receipt detected: doc=" + (receipt?.DocNo ?? "-") +
                ", branch=" + (receipt?.BranchCode ?? "-") +
                ", total=" + (receipt == null ? "-" : receipt.GrandTotal.ToString("F2")));

            AdvanceWatermark(receipt);

            lock (_receiptLock)
                _standingByReceipt = receipt;
        }

        private void OnReturnDetected(object sender, PosReceipt receipt)
        {
            LogRuntime("Return detected: doc=" + (receipt?.DocNo ?? "-"));
            AdvanceWatermark(receipt);
            lock (_receiptLock)
                _standingByReceipt = null;
        }

        private void AdvanceWatermark(PosReceipt receipt)
        {
            if (receipt == null) return;
            try
            {
                ReceiptWatermark wm = ReceiptWatermark.FromReceipt(receipt);
                _watermarkStore.Save(wm);
                _watcher?.AcknowledgeReceipt(receipt);
            }
            catch (Exception ex)
            {
                LogRuntime("Watermark advance failed: " + ex.Message);
            }
        }

        private void OnWatcherConnected(object sender, EventArgs e)
        {
            LogRuntime("AdaPos watcher connected.");
            ScheduleOnUiThread(() =>
            {
                if (_miWatcherStatus != null)
                    _miWatcherStatus.Text = "AdaPos DB: เชื่อมต่อแล้ว ✓";
            });
        }

        private void OnWatcherDisconnected(object sender, string errorMessage)
        {
            LogRuntime("AdaPos watcher disconnected: " + (errorMessage ?? "?"));
            lock (_receiptLock) _standingByReceipt = null;
            ScheduleOnUiThread(() =>
            {
                if (_miWatcherStatus != null)
                    _miWatcherStatus.Text = "AdaPos DB: ขาดการเชื่อมต่อ ⚠";
            });
        }

        // ── Hotkey ─────────────────────────────────────────────────────────────

        private void RegisterHotKey()
        {
            uint modifiers  = (uint)ReadInt("ClaimQrHotKeyModifiers",  3);    // Ctrl+Alt
            uint virtualKey = (uint)ReadHex("ClaimQrHotKeyVirtualKey", 0x51); // Q

            _hotKey = new GlobalHotKeyManager();
            if (_hotKey.Register(modifiers, virtualKey))
            {
                _hotKey.HotKeyPressed += (s, e) => OpenMemberClaimForm();
                LogRuntime("Hotkey registered (Ctrl+Alt+Q).");
            }
            else
            {
                LogRuntime("Hotkey could not be registered (conflict?).");
                _hotKey.Dispose();
                _hotKey = null;
            }
        }

        // ── MemberClaimForm ────────────────────────────────────────────────────

        private void OpenMemberClaimForm()
        {
            if (_activeMemberClaimForm != null && !_activeMemberClaimForm.IsDisposed)
            {
                if (_activeMemberClaimForm.WindowState == FormWindowState.Minimized)
                    _activeMemberClaimForm.WindowState = FormWindowState.Normal;
                _activeMemberClaimForm.BringToFront();
                _activeMemberClaimForm.Activate();
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

            PosReceipt prefill;
            lock (_receiptLock) prefill = _standingByReceipt;

            _activeMemberClaimForm = new MemberClaimForm(
                _api, _watcher, _bahtPerPoint, _auth.DeviceId, prefill);

            _activeMemberClaimForm.FormClosed += (s, e) =>
            {
                _activeMemberClaimForm = null;
            };

            _activeMemberClaimForm.Show();
            _activeMemberClaimForm.BringToFront();
        }

        // ── Tray menu handlers ─────────────────────────────────────────────────

        private void OnReAuthenticate(object sender, EventArgs e)
        {
            _auth.ClearToken();
            _watcher?.Stop();
            _watcher?.Dispose();
            _watcher = null;
            lock (_receiptLock) _standingByReceipt = null;
            PromptStaffLogin();
        }

        private void OnExit(object sender, EventArgs e)
        {
            _watcher?.Stop();
            _hotKey?.Dispose();
            _trayIcon.Visible = false;
            Application.Exit();
        }

        // ── Session expiry ─────────────────────────────────────────────────────

        private void HandleSessionExpired()
        {
            _auth.ClearToken();
            _watcher?.Stop();
            _watcher?.Dispose();
            _watcher = null;
            lock (_receiptLock) _standingByReceipt = null;
            PromptStaffLogin();
        }

        // ── Watermark ─────────────────────────────────────────────────────────

        private ReceiptWatermark LoadOrCreateWatcherWatermark()
        {
            ReceiptWatermark loaded = _watermarkStore.Load();
            if (loaded != null)
            {
                LogRuntime("Loaded watermark: " + loaded.Describe());
                return loaded;
            }
            ReceiptWatermark seeded = ReceiptWatermark.Create(DateTime.Today, DateTime.Now.ToString("HH:mm:ss"), "");
            _watermarkStore.Save(seeded);
            LogRuntime("Created initial watermark: " + seeded.Describe());
            return seeded;
        }

        // ── Utilities ─────────────────────────────────────────────────────────

        private static void ScheduleOnUiThread(Action action)
        {
            var t = new Timer { Interval = 1 };
            t.Tick += (s, e) => { t.Stop(); t.Dispose(); action(); };
            t.Start();
        }

        private void LogRuntime(string message)
        {
            try
            {
                string line = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " | " + message;
                File.AppendAllText(_runtimeLogPath, line + Environment.NewLine);
            }
            catch { }
        }

        private static bool ReadBool(string key, bool defaultValue)
        {
            string raw = ConfigurationManager.AppSettings[key];
            bool parsed;
            return bool.TryParse(raw, out parsed) ? parsed : defaultValue;
        }

        private static int ReadInt(string key, int defaultValue)
        {
            string raw = ConfigurationManager.AppSettings[key];
            int parsed;
            return int.TryParse(raw, out parsed) ? parsed : defaultValue;
        }

        private static int ReadHex(string key, int defaultValue)
        {
            string raw = ConfigurationManager.AppSettings[key];
            if (string.IsNullOrWhiteSpace(raw)) return defaultValue;
            raw = raw.Trim();
            if (raw.StartsWith("0x", StringComparison.OrdinalIgnoreCase))
                raw = raw.Substring(2);
            int result;
            return int.TryParse(raw, System.Globalization.NumberStyles.HexNumber, null, out result) ? result : defaultValue;
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
                _watcher?.Dispose();
                _hotKey?.Dispose();
                _trayIcon?.Dispose();
                _activeMemberClaimForm?.Dispose();
            }
            base.Dispose(disposing);
        }
    }
}
