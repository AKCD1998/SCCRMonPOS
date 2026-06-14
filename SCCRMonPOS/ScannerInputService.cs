using System;
using System.Configuration;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

namespace SCCRMonPOS
{
    /// <summary>
    /// Installs a WH_KEYBOARD_LL (low-level global keyboard) hook to detect
    /// barcode / QR scanner input regardless of which window has focus.
    ///
    /// How scanner detection works
    /// ──────────────────────────
    /// Barcode scanners emulate a keyboard but type characters far faster than
    /// any human (typically all chars within 30–80 ms total).  We exploit this:
    ///   • If more than ScannerMaxIntervalMs have passed since the last keystroke
    ///     we flush/reset the buffer (the user is typing normally).
    ///   • When Enter is received the buffer is evaluated against known prefixes.
    ///   • If a prefix matches an event is raised on the same thread (UI thread).
    ///   • All keystrokes are passed to the next hook — we never block the POS app.
    ///
    /// Must be created and Start()ed from the main UI thread (the thread that runs
    /// Application.Run), because WH_KEYBOARD_LL is dispatched via that thread's
    /// message loop.
    /// </summary>
    public class ScannerInputService : IDisposable
    {
        // ── Win32 constants ──────────────────────────────────────────────────
        private const int WH_KEYBOARD_LL = 13;
        private const int WM_KEYDOWN     = 0x0100;
        private const int WM_SYSKEYDOWN  = 0x0104;

        // ── Scan prefix constants ────────────────────────────────────────────
        public const string PrefixPoint  = "SCM-POINT-v1-";
        public const string PrefixRedeem = "SCM-REDEEM-v1-";

        // ── Configuration (read from App.config, with safe defaults) ─────────
        private readonly int _maxIntervalMs;
        private readonly int _minScanLength;

        // ── Hook state ───────────────────────────────────────────────────────
        private IntPtr _hookId = IntPtr.Zero;

        // Keep a field reference so the delegate is not garbage-collected while
        // the hook is active — this is a common source of random crashes.
        private readonly LowLevelKeyboardProc _procRef;

        // ── Scanner buffer ───────────────────────────────────────────────────
        private readonly StringBuilder _buffer = new StringBuilder(64);
        private DateTime _lastKeyAt = DateTime.MinValue;

        // ── Events ───────────────────────────────────────────────────────────
        /// <summary>Raised when a full SCM-POINT-v1-{token} scan is detected.</summary>
        public event EventHandler<string> PointScanDetected;

        /// <summary>Raised when a full SCM-REDEEM-v1-{token} scan is detected (Phase 2).</summary>
        public event EventHandler<string> RedeemScanDetected;

        /// <summary>
        /// Raised for any complete scan that does NOT match a known SCM prefix.
        /// Subscribers can use this to implement barcode-alias lookups or pass-through logging.
        /// The event argument is the raw scanned string (no transformation applied).
        /// </summary>
        public event EventHandler<string> RawScanDetected;

        // ────────────────────────────────────────────────────────────────────
        public ScannerInputService()
        {
            _maxIntervalMs = ReadInt("ScannerMaxIntervalMs", 100);
            _minScanLength = ReadInt("ScannerMinLength", 10);
            _procRef = HookCallback;   // capture once; prevents GC during hook lifetime
        }

        // ── Public API ───────────────────────────────────────────────────────

        /// <summary>
        /// Installs the global keyboard hook.
        /// Call from the main UI thread after the message loop has started
        /// (e.g., inside the ApplicationContext constructor is fine).
        /// </summary>
        public void Start()
        {
            if (_hookId != IntPtr.Zero) return;  // already running

            using (var proc = Process.GetCurrentProcess())
            using (var mod  = proc.MainModule)
            {
                _hookId = SetWindowsHookEx(
                    WH_KEYBOARD_LL,
                    _procRef,
                    GetModuleHandle(mod.ModuleName),
                    0);
            }

            if (_hookId == IntPtr.Zero)
            {
                int err = Marshal.GetLastWin32Error();
                MessageBox.Show(
                    "ไม่สามารถติดตั้ง keyboard hook ได้ (error " + err + ")\n" +
                    "การสแกนบาร์โค้ดจะไม่ทำงานโดยอัตโนมัติ\n\n" +
                    "ลองรันโปรแกรมในฐานะ Administrator",
                    "SCCRM — คำเตือน",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Warning);
            }
        }

        /// <summary>Removes the hook. Safe to call even if Start() was never called.</summary>
        public void Stop()
        {
            if (_hookId == IntPtr.Zero) return;
            UnhookWindowsHookEx(_hookId);
            _hookId = IntPtr.Zero;
        }

        public void Dispose() { Stop(); }

        // ── Hook callback ────────────────────────────────────────────────────

        private IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam)
        {
            // nCode < 0  →  we must pass without processing (Win32 rule)
            if (nCode >= 0 &&
                (wParam == (IntPtr)WM_KEYDOWN || wParam == (IntPtr)WM_SYSKEYDOWN))
            {
                var kb = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
                ProcessVirtualKey(kb.vkCode);
            }

            // ALWAYS call next hook — we must never swallow keystrokes
            return CallNextHookEx(_hookId, nCode, wParam, lParam);
        }

        private void ProcessVirtualKey(uint vk)
        {
            var now     = DateTime.UtcNow;
            double gap  = (_lastKeyAt == DateTime.MinValue)
                              ? 0
                              : (now - _lastKeyAt).TotalMilliseconds;

            // Long pause → user is typing normally; discard stale partial buffer
            if (gap > _maxIntervalMs && _buffer.Length > 0)
                _buffer.Clear();

            _lastKeyAt = now;

            switch (vk)
            {
                case (uint)Keys.Return:
                    // Enter — evaluate and always clear the buffer
                    EvaluateBuffer();
                    _buffer.Clear();
                    break;

                case (uint)Keys.Back:
                    if (_buffer.Length > 0)
                        _buffer.Remove(_buffer.Length - 1, 1);
                    break;

                case (uint)Keys.Escape:
                case (uint)Keys.Tab:
                    // Abort any partially built buffer
                    _buffer.Clear();
                    break;

                default:
                    char c = VkToChar(vk);
                    if (c != '\0') _buffer.Append(c);
                    break;
            }
        }

        private void EvaluateBuffer()
        {
            string scan = _buffer.ToString();
            if (scan.Length < _minScanLength) return;

            if (scan.StartsWith(PrefixPoint, StringComparison.OrdinalIgnoreCase))
            {
                string token = scan.Substring(PrefixPoint.Length).Trim();
                if (token.Length > 0)
                    PointScanDetected?.Invoke(this, token);
            }
            else if (scan.StartsWith(PrefixRedeem, StringComparison.OrdinalIgnoreCase))
            {
                string token = scan.Substring(PrefixRedeem.Length).Trim();
                if (token.Length > 0)
                    RedeemScanDetected?.Invoke(this, token);
            }
            else
            {
                // No SCM prefix — fire RawScanDetected so callers can do
                // alias lookups (e.g. legacy EAN barcodes on old member cards).
                // If nobody is subscribed, the scan is silently discarded and
                // the POS application is never disturbed.
                RawScanDetected?.Invoke(this, scan);
            }
        }

        // ── VK → char conversion ─────────────────────────────────────────────

        /// <summary>
        /// Converts a virtual-key code to a Unicode character.
        /// GetKeyboardState is unreliable inside WH_KEYBOARD_LL callbacks, so we
        /// build the modifier state from GetAsyncKeyState instead.
        /// </summary>
        private static char VkToChar(uint vk)
        {
            byte[] keyState = new byte[256];

            // Shift, Ctrl, Alt — use async variant which is accurate in LL hooks
            if ((GetAsyncKeyState(0x10) & 0x8000) != 0) keyState[0x10] = 0x80;
            if ((GetAsyncKeyState(0x11) & 0x8000) != 0) keyState[0x11] = 0x80;
            if ((GetAsyncKeyState(0x12) & 0x8000) != 0) keyState[0x12] = 0x80;
            // CapsLock toggle state
            if ((GetKeyState(0x14) & 0x0001) != 0) keyState[0x14] = 0x01;

            uint scanCode = MapVirtualKey(vk, 0 /* MAPVK_VK_TO_VSC */);
            var  sb       = new StringBuilder(4);

            int result = ToUnicode(vk, scanCode, keyState, sb, sb.Capacity, 0);
            return (result == 1) ? sb[0] : '\0';
        }

        // ── P/Invoke declarations ─────────────────────────────────────────────

        private delegate IntPtr LowLevelKeyboardProc(int nCode, IntPtr wParam, IntPtr lParam);

        [StructLayout(LayoutKind.Sequential)]
        private struct KBDLLHOOKSTRUCT
        {
            public uint   vkCode;
            public uint   scanCode;
            public uint   flags;
            public uint   time;
            public IntPtr dwExtraInfo;
        }

        [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
        private static extern IntPtr SetWindowsHookEx(
            int idHook, LowLevelKeyboardProc lpfn, IntPtr hMod, uint dwThreadId);

        [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool UnhookWindowsHookEx(IntPtr hhk);

        [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
        private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

        [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
        private static extern IntPtr GetModuleHandle(string lpModuleName);

        [DllImport("user32.dll")]
        private static extern bool GetKeyboardState(byte[] lpKeyState);

        [DllImport("user32.dll")]
        private static extern short GetAsyncKeyState(int vKey);

        [DllImport("user32.dll")]
        private static extern short GetKeyState(int nVirtKey);

        [DllImport("user32.dll")]
        private static extern uint MapVirtualKey(uint uCode, uint uMapType);

        [DllImport("user32.dll")]
        private static extern int ToUnicode(
            uint wVirtKey, uint wScanCode, byte[] lpKeyState,
            [Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pwszBuff,
            int cchBuff, uint wFlags);

        // ── Helpers ──────────────────────────────────────────────────────────

        private static int ReadInt(string key, int defaultValue)
        {
            return AppSettingsProvider.GetInt(key, defaultValue);
        }
    }
}
