using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace SCCRMonPOS
{
    // Four narrow, per-pixel-alpha, mouse-transparent windows. There is no
    // full-screen input surface above the sales program. Only Close is clickable.
    public sealed class CashierQrOverlay : IDisposable
    {
        private readonly GlowEdge[] _edges;
        private readonly CloseQrButton _close;
        private readonly Timer _animation;
        private double _phase;
        private bool _disposed;

        public CashierQrOverlay(Rectangle screen, Action close)
        {
            int thickness = 16;
            _edges = new[] {
                new GlowEdge(new Rectangle(screen.Left, screen.Top, screen.Width, thickness), 0),
                new GlowEdge(new Rectangle(screen.Left, screen.Bottom - thickness, screen.Width, thickness), 1),
                new GlowEdge(new Rectangle(screen.Left, screen.Top + thickness, thickness, Math.Max(1, screen.Height - 2 * thickness)), 2),
                new GlowEdge(new Rectangle(screen.Right - thickness, screen.Top + thickness, thickness, Math.Max(1, screen.Height - 2 * thickness)), 3)
            };
            int width = Math.Min(310, screen.Width - 32);
            _close = new CloseQrButton(close) { Bounds = new Rectangle(screen.Left + (screen.Width - width) / 2, screen.Top + 8, width, 38) };
            _animation = new Timer { Interval = 80 };
            _animation.Tick += (s, e) => {
                try { _phase += .085; foreach (var edge in _edges) edge.Render(_phase); }
                catch { close(); } // Display changes must not interrupt cashier input.
            };
            try
            {
                foreach (var edge in _edges) { edge.Show(); edge.Render(_phase); }
                _close.Show();
                _animation.Start();
            }
            catch { Dispose(); throw; }
        }

        public void Dispose()
        {
            if (_disposed) return; _disposed = true;
            _animation.Stop(); _animation.Dispose();
            foreach (var edge in _edges) { edge.Close(); edge.Dispose(); }
            _close.Close(); _close.Dispose();
        }

        private sealed class CloseQrButton : Form
        {
            private readonly Action _close;
            protected override bool ShowWithoutActivation { get { return true; } }
            protected override CreateParams CreateParams { get { var cp = base.CreateParams; cp.ExStyle |= 0x08000080; return cp; } }
            public CloseQrButton(Action close)
            {
                _close = close;
                FormBorderStyle = FormBorderStyle.None; TopMost = true; ShowInTaskbar = false; StartPosition = FormStartPosition.Manual;
                BackColor = Color.FromArgb(11, 31, 184); ForeColor = Color.White;
                Cursor = Cursors.Hand; DoubleBuffered = true; Text = "ปิด QR จอลูกค้า";
            }
            protected override void WndProc(ref Message m)
            {
                if (m.Msg == 0x0021) { m.Result = new IntPtr(3); return; } // MA_NOACTIVATE
                base.WndProc(ref m);
            }
            protected override void OnMouseClick(MouseEventArgs e) { base.OnMouseClick(e); if (e.Button == MouseButtons.Left) _close(); }
            protected override void OnPaint(PaintEventArgs e)
            {
                base.OnPaint(e);
                using (var yellow = new Pen(Color.FromArgb(246, 233, 107), 2)) e.Graphics.DrawRectangle(yellow, 1, 1, Width - 3, Height - 3);
                using (var font = new Font("Tahoma", 11f, FontStyle.Bold))
                using (var center = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center })
                    e.Graphics.DrawString("ปิด QR จอลูกค้า  ×", font, Brushes.White, ClientRectangle, center);
            }
        }

        private sealed class GlowEdge : Form
        {
            private readonly int _side;
            private readonly Bitmap _frame;
            private readonly byte[] _pixels;
            protected override bool ShowWithoutActivation { get { return true; } }
            protected override CreateParams CreateParams { get { var cp = base.CreateParams; cp.ExStyle |= 0x080800A0; return cp; } } // layered, transparent, no-activate, tool-window
            public GlowEdge(Rectangle bounds, int side)
            {
                _side = side; StartPosition = FormStartPosition.Manual; Bounds = bounds;
                FormBorderStyle = FormBorderStyle.None; ShowInTaskbar = false; TopMost = true;
                // Set bounds after removing borders so client/outer coordinates agree.
                Bounds = bounds;
                _frame = new Bitmap(bounds.Width, bounds.Height, PixelFormat.Format32bppPArgb);
                _pixels = new byte[bounds.Width * bounds.Height * 4];
            }
            protected override void WndProc(ref Message m)
            {
                if (m.Msg == 0x0084) { m.Result = new IntPtr(-1); return; } // HTTRANSPARENT
                if (m.Msg == 0x0021) { m.Result = new IntPtr(3); return; }
                base.WndProc(ref m);
            }

            public void Render(double phase)
            {
                FillGlow(_frame, _pixels, _side, phase);
                IntPtr desktop = GetDC(IntPtr.Zero), memory = CreateCompatibleDC(desktop), hbitmap = IntPtr.Zero, old = IntPtr.Zero;
                try
                {
                    hbitmap = _frame.GetHbitmap(Color.FromArgb(0)); old = SelectObject(memory, hbitmap);
                    var location = new NativePoint(Left, Top); var origin = new NativePoint(0, 0); var size = new NativeSize(Width, Height);
                    var blend = new Blend { BlendOp = 0, SourceConstantAlpha = 255, AlphaFormat = 1 };
                    if (!UpdateLayeredWindow(Handle, desktop, ref location, ref size, memory, ref origin, 0, ref blend, 2))
                        throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
                }
                finally
                {
                    if (old != IntPtr.Zero) SelectObject(memory, old);
                    if (hbitmap != IntPtr.Zero) DeleteObject(hbitmap);
                    DeleteDC(memory); ReleaseDC(IntPtr.Zero, desktop);
                }
            }

            protected override void Dispose(bool disposing) { if (disposing) _frame?.Dispose(); base.Dispose(disposing); }
        }

        public static Bitmap DrawGlow(Size size, int side, double phase)
        {
            var image = new Bitmap(Math.Max(1, size.Width), Math.Max(1, size.Height), PixelFormat.Format32bppPArgb);
            FillGlow(image, new byte[image.Width * image.Height * 4], side, phase);
            return image;
        }

        private static void FillGlow(Bitmap image, byte[] pixels, int side, double phase)
        {
            bool horizontal = side < 2;
            int depth = horizontal ? image.Height : image.Width;
            int length = horizontal ? image.Width : image.Height;
            var data = image.LockBits(new Rectangle(Point.Empty, image.Size), ImageLockMode.WriteOnly, PixelFormat.Format32bppPArgb);
            try
            {
                for (int p = 0; p < length; p++)
                {
                    double mix = (Math.Sin(phase + (double)p / Math.Max(1, length) * Math.PI * 2) + 1) / 2;
                    int red = (int)(11 + (246 - 11) * mix), green = (int)(31 + (233 - 31) * mix), blue = (int)(184 + (107 - 184) * mix);
                    for (int d = 0; d < depth; d++)
                    {
                        int distance = side == 1 || side == 3 ? depth - 1 - d : d;
                        int alpha = (int)(210 * Math.Pow(1 - (double)distance / depth, 2));
                        int offset = (horizontal ? d : p) * data.Stride + (horizontal ? p : d) * 4;
                        pixels[offset] = (byte)(blue * alpha / 255); pixels[offset + 1] = (byte)(green * alpha / 255);
                        pixels[offset + 2] = (byte)(red * alpha / 255); pixels[offset + 3] = (byte)alpha;
                    }
                }
                Marshal.Copy(pixels, 0, data.Scan0, pixels.Length);
            }
            finally { image.UnlockBits(data); }
        }

        [StructLayout(LayoutKind.Sequential)] private struct NativePoint { public int X, Y; public NativePoint(int x, int y) { X = x; Y = y; } }
        [StructLayout(LayoutKind.Sequential)] private struct NativeSize { public int Width, Height; public NativeSize(int w, int h) { Width = w; Height = h; } }
        [StructLayout(LayoutKind.Sequential, Pack = 1)] private struct Blend { public byte BlendOp, BlendFlags, SourceConstantAlpha, AlphaFormat; }
        [DllImport("user32.dll")] private static extern IntPtr GetDC(IntPtr window);
        [DllImport("user32.dll")] private static extern int ReleaseDC(IntPtr window, IntPtr dc);
        [DllImport("gdi32.dll")] private static extern IntPtr CreateCompatibleDC(IntPtr dc);
        [DllImport("gdi32.dll")] private static extern bool DeleteDC(IntPtr dc);
        [DllImport("gdi32.dll")] private static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);
        [DllImport("gdi32.dll")] private static extern bool DeleteObject(IntPtr obj);
        [DllImport("user32.dll", SetLastError = true)] private static extern bool UpdateLayeredWindow(IntPtr window, IntPtr destination, ref NativePoint location, ref NativeSize size, IntPtr source, ref NativePoint origin, uint key, ref Blend blend, uint flags);
    }
}
