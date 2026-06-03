using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace SCCRMonPOS
{
    /// <summary>
    /// Registers a system-wide hotkey and raises HotKeyPressed when it fires.
    /// Implements IMessageFilter so it intercepts WM_HOTKEY on the UI thread.
    /// </summary>
    public sealed class GlobalHotKeyManager : IMessageFilter, IDisposable
    {
        [DllImport("user32.dll")] private static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);
        [DllImport("user32.dll")] private static extern bool UnregisterHotKey(IntPtr hWnd, int id);

        private const int WM_HOTKEY    = 0x0312;
        private const int HotKeyId     = 0x5343; // "SC" — arbitrary unique id

        public const uint MOD_NONE  = 0;
        public const uint MOD_ALT   = 1;
        public const uint MOD_CTRL  = 2;
        public const uint MOD_SHIFT = 4;
        public const uint MOD_WIN   = 8;

        public event EventHandler HotKeyPressed;

        private bool _registered;
        private bool _filterAdded;

        public bool Register(uint modifiers, uint virtualKey)
        {
            if (_registered) Unregister();

            _registered = RegisterHotKey(IntPtr.Zero, HotKeyId, modifiers, virtualKey);
            if (_registered)
            {
                Application.AddMessageFilter(this);
                _filterAdded = true;
            }
            return _registered;
        }

        public void Unregister()
        {
            if (_filterAdded)
            {
                Application.RemoveMessageFilter(this);
                _filterAdded = false;
            }
            if (_registered)
            {
                UnregisterHotKey(IntPtr.Zero, HotKeyId);
                _registered = false;
            }
        }

        public bool PreFilterMessage(ref Message m)
        {
            if (m.Msg == WM_HOTKEY && m.WParam.ToInt32() == HotKeyId)
            {
                HotKeyPressed?.Invoke(this, EventArgs.Empty);
                return true; // consumed
            }
            return false;
        }

        public void Dispose()
        {
            Unregister();
        }
    }
}
