using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

namespace SCCRMonPOS
{
    // Its own STA/message queue: never own this toolbar by a cashier HWND,
    // attach input queues, or Invoke back onto the possibly blocked UI thread.
    internal sealed class CashierWindowGuard : IDisposable
    {
        private sealed class Root
        {
            public IntPtr Handle;
            public uint ThreadId;
            public long LastPulse;
            public IntPtr[] ParkedWindows;
        }

        private readonly ConcurrentDictionary<IntPtr, Root> _roots = new ConcurrentDictionary<IntPtr, Root>();
        private readonly uint _processId = (uint)Process.GetCurrentProcess().Id;
        private readonly Thread _thread;
        private volatile bool _running;
        private volatile bool _stop;
        private IntPtr _buttonHandle;
        private IntPtr _target;
        internal bool Running { get { return _running; } }
        internal string Failure { get; private set; }
        internal IntPtr ButtonHandle { get { return Interlocked.CompareExchange(ref _buttonHandle, IntPtr.Zero, IntPtr.Zero); } }

        public CashierWindowGuard()
        {
            using (var ready = new ManualResetEvent(false))
            {
                _thread = new Thread(() => Run(ready)) { IsBackground = true, Name = "SCCRM window safety" };
                _thread.SetApartmentState(ApartmentState.STA);
                _thread.Start();
                if (!ready.WaitOne(2000)) _stop = true;
            }
        }

        // Call on the cashier UI thread before showing a root form. Owned
        // registration, history, medical and PIN dialogs are discovered natively.
        public void Protect(Form form)
        {
            IntPtr registered = IntPtr.Zero;
            System.Windows.Forms.Timer heartbeat = null;
            Action register = () => {
                if (!_running) { form.TopMost = false; return; } // fail open if the guard could not start
                registered = form.Handle;
                uint pid;
                uint threadId = GetWindowThreadProcessId(registered, out pid);
                if (pid != _processId) return;
                var root = new Root { Handle = registered, ThreadId = threadId, LastPulse = Stopwatch.GetTimestamp() };
                _roots[registered] = root;
                heartbeat = new System.Windows.Forms.Timer { Interval = 250 };
                heartbeat.Tick += (s, e) => Interlocked.Exchange(ref root.LastPulse, Stopwatch.GetTimestamp());
                heartbeat.Start();
            };
            form.HandleCreated += (s, e) => register();
            form.HandleDestroyed += (s, e) => { heartbeat?.Dispose(); heartbeat = null; Root ignored; _roots.TryRemove(registered, out ignored); };
            form.Activated += (s, e) => Restore(form);
            var member = form as MemberClaimForm;
            if (member != null) member.IsParkedForSales = () => { Root root; return _roots.TryGetValue(registered, out root) && Volatile.Read(ref root.ParkedWindows) != null; };
            if (form.IsHandleCreated) register();
        }

        private void Run(ManualResetEvent ready)
        {
            try
            {
                using (var button = new BackToSaleButton(() => { foreach (var root in _roots.Values) Park(root.Handle); }))
                using (var timer = new System.Windows.Forms.Timer { Interval = 250 })
                using (var context = new ApplicationContext())
                {
                    Interlocked.Exchange(ref _buttonHandle, button.Handle);
                    _running = true;
                    try { ready.Set(); } catch (ObjectDisposedException) { _stop = true; }
                    timer.Tick += (s, e) => {
                        try
                        {
                            if (_stop) { button.Hide(); context.ExitThread(); return; }
                            Poll(button);
                        }
                        catch (Exception ex) { Failure = ex.GetType().Name + ": " + ex.Message; foreach (var root in _roots.Values) Park(root.Handle); context.ExitThread(); }
                    };
                    timer.Start();
                    Application.Run(context);
                }
            }
            catch (Exception ex) { Failure = ex.GetType().Name + ": " + ex.Message; try { ready.Set(); } catch (ObjectDisposedException) { } }
            finally
            {
                _running = false;
                Interlocked.Exchange(ref _buttonHandle, IntPtr.Zero);
                // A failed safety thread must not leave a topmost cashier pane
                // blocking sales. This does not cancel work or terminate apps.
                foreach (var root in _roots.Values) Park(root.Handle);
            }
        }

        private void Poll(BackToSaleButton button)
        {
            Root selected = null;
            foreach (var root in _roots.Values)
            {
                if (!IsOurWindow(root.Handle, root.ThreadId) || !IsWindowVisible(root.Handle) || IsIconic(root.Handle))
                    continue;
                if (Volatile.Read(ref root.ParkedWindows) != null) continue;
                // A UI timer supplies the heartbeat. Do not send synchronous
                // messages to a frozen thread (shared input queues can ignore
                // SendMessageTimeout's timeout).
                if ((Stopwatch.GetTimestamp() - Interlocked.Read(ref root.LastPulse)) / (double)Stopwatch.Frequency >= 5)
                { Park(root.Handle); continue; }
                selected = root;
            }
            _target = selected == null ? IntPtr.Zero : selected.Handle;
            if (_target == IntPtr.Zero) { button.Hide(); return; }

            NativeRect rect;
            if (!GetWindowRect(_target, out rect)) { button.Hide(); return; }
            var bounds = Rectangle.FromLTRB(rect.Left, rect.Top, rect.Right, rect.Bottom);
            // Offscreen fixtures stay offscreen; real cashiers get one consistent
            // button at the top-right of the monitor containing the member pane.
            var area = bounds.IntersectsWith(SystemInformation.VirtualScreen)
                ? Screen.FromRectangle(bounds).WorkingArea : bounds;
            button.Bounds = new Rectangle(area.Right - 204, area.Top + 8, 196, 36);
            if (!button.Visible) button.Show();
            SetWindowPos(button.Handle, new IntPtr(-1), 0, 0, 0, 0, 0x13); // TOPMOST without activation
        }

        private bool IsOurWindow(IntPtr window, uint threadId)
        {
            uint pid;
            return window != IntPtr.Zero && GetWindowThreadProcessId(window, out pid) == threadId && pid == _processId;
        }

        internal void Park(IntPtr rootHandle)
        {
            Root root;
            if (!_roots.TryGetValue(rootHandle, out root) || !IsOurWindow(root.Handle, root.ThreadId)) return;
            var owned = new List<IntPtr>();
            EnumWindows((window, param) => {
                if (window == root.Handle || !IsOurWindow(window, root.ThreadId)) return true;
                var owner = window;
                for (int count = 0; count < 32 && owner != IntPtr.Zero; count++)
                {
                    owner = GetWindow(owner, 4); // GW_OWNER; no cross-thread managed calls
                    if (owner == root.Handle) { owned.Add(window); break; }
                }
                return true;
            }, IntPtr.Zero);
            var windows = owned.Concat(new[] { root.Handle }).ToArray();
            Interlocked.CompareExchange(ref root.ParkedWindows, windows, null);
            foreach (var window in windows)
                if (IsOurWindow(window, root.ThreadId) && IsWindowVisible(window) && !IsIconic(window))
                    SetWindowPos(window, new IntPtr(1), 0, 0, 0, 0, 0x413); // BOTTOM, NOACTIVATE/NOSENDCHANGING/NOMOVE/NOSIZE
        }

        // Called only on the responsive cashier thread after an explicit tray,
        // hotkey/taskbar activation. Raise the same group, keeping an open modal
        // and its unsaved input intact. A heartbeat recovery never calls this.
        public void Restore(Form form)
        {
            Root root;
            if (!_roots.TryGetValue(form.Handle, out root)) return;
            var windows = Interlocked.Exchange(ref root.ParkedWindows, null);
            if (windows == null) return;
            foreach (var window in windows.Reverse())
                if (IsOurWindow(window, root.ThreadId)) SetWindowPos(window, new IntPtr(-1), 0, 0, 0, 0, 0x413);
        }

        public void Dispose()
        {
            _stop = true;
            if (Thread.CurrentThread != _thread) _thread.Join(2000);
        }

        internal sealed class BackToSaleButton : Form
        {
            private readonly Action _park;
            public BackToSaleButton(Action park)
            {
                _park = park;
                FormBorderStyle = FormBorderStyle.None; ShowInTaskbar = false;
                StartPosition = FormStartPosition.Manual; Size = new Size(196, 36);
                Location = new Point(-12000, -12000);
                BackColor = Color.FromArgb(11, 31, 184); ForeColor = Color.White;
                Font = new Font("Tahoma", 9f, FontStyle.Bold); Cursor = Cursors.Hand;
                Text = "SCCRM · กลับไปขาย"; AccessibleName = Text; AccessibleRole = AccessibleRole.PushButton;
            }
            protected override bool ShowWithoutActivation { get { return true; } }
            // Native TOPMOST avoids Form.TopMost's activating SetWindowPos call
            // during handle creation. This queue must stay independent.
            protected override CreateParams CreateParams { get { var cp = base.CreateParams; cp.ExStyle |= 0x08000088; return cp; } }
            protected override void WndProc(ref Message message)
            {
                if (message.Msg == 0x0021) { message.Result = new IntPtr(3); return; } // MA_NOACTIVATE
                base.WndProc(ref message);
            }
            protected override void OnMouseUp(MouseEventArgs e) { base.OnMouseUp(e); if (e.Button == MouseButtons.Left) { _park(); Hide(); } }
            protected override void OnPaint(PaintEventArgs e)
            {
                base.OnPaint(e);
                TextRenderer.DrawText(e.Graphics, Text, Font, ClientRectangle, ForeColor, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
                using (var yellow = new SolidBrush(Color.FromArgb(246, 233, 107))) e.Graphics.FillRectangle(yellow, 0, Height - 3, Width, 3);
            }
        }

        [StructLayout(LayoutKind.Sequential)] private struct NativeRect { public int Left, Top, Right, Bottom; }
        private delegate bool EnumWindowCallback(IntPtr window, IntPtr parameter);
        [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowCallback callback, IntPtr parameter);
        [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
        [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr window, out NativeRect rectangle);
        [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr window, uint command);
        [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
        [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr window);
        [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
    }
}
