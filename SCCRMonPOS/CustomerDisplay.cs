using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Linq;
using System.Windows.Forms;
using System.Xml.Linq;

namespace SCCRMonPOS
{
    public sealed class CustomerDisplayController : IDisposable
    {
        public const string RegistrationUrl = "https://sc-official-website.onrender.com/join";
        private readonly string _settingsPath;
        private CustomerQrForm _window;
        private CashierQrOverlay _overlay;
        public bool IsShowing { get { return _window != null && !_window.IsDisposed; } }
        public string PreferredDevice { get; private set; }

        public CustomerDisplayController(string dataFolder)
        {
            _settingsPath = Path.Combine(dataFolder, "customer-display.xml");
            try { PreferredDevice = (string)XDocument.Load(_settingsPath).Root.Attribute("device"); }
            catch { PreferredDevice = null; }
            Microsoft.Win32.SystemEvents.DisplaySettingsChanged += OnDisplaysChanged;
        }

        public void ShowOn(Screen screen, IWin32Window cashier)
        {
            if (screen == null || screen.DeviceName == Screen.FromHandle(cashier.Handle).DeviceName)
                throw new InvalidOperationException("กรุณาเลือกจอลูกค้าที่แยกจากจอพนักงาน (Windows: ขยายจอภาพ)");
            // Remember a device name, never an array index that changes after reconnect.
            Directory.CreateDirectory(Path.GetDirectoryName(_settingsPath));
            new XDocument(new XElement("display", new XAttribute("device", screen.DeviceName))).Save(_settingsPath);
            PreferredDevice = screen.DeviceName;
            Hide();
            _window = new CustomerQrForm { StartPosition = FormStartPosition.Manual, Bounds = screen.Bounds };
            _window.Show();
            try { _overlay = new CashierQrOverlay(Screen.FromHandle(cashier.Handle).Bounds, Hide); }
            catch { Hide(); throw; }
        }

        public void Hide()
        {
            if (_overlay != null) { _overlay.Dispose(); _overlay = null; }
            if (_window != null) { _window.Close(); _window.Dispose(); _window = null; }
        }

        private void OnDisplaysChanged(object sender, EventArgs e)
        {
            try { if (_window != null && _window.IsHandleCreated) _window.BeginInvoke((Action)Hide); }
            catch (InvalidOperationException) { }
        }

        public void Dispose() { Microsoft.Win32.SystemEvents.DisplaySettingsChanged -= OnDisplaysChanged; Hide(); }
    }

    // No activation: the cashier keeps keyboard/scanner focus while the customer
    // sees the sign. Closing it reveals the existing AdaPos display underneath.
    public sealed class CustomerQrForm : Form
    {
        private readonly Image _qr;
        protected override bool ShowWithoutActivation { get { return true; } }
        protected override CreateParams CreateParams
        {
            get { var cp = base.CreateParams; cp.ExStyle |= 0x08000000; return cp; }
        }

        public CustomerQrForm()
        {
            Text = "SCCRM — สมัครสมาชิก";
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            TopMost = true;
            DoubleBuffered = true;
            BackColor = Color.White;
            using (var stream = typeof(CustomerQrForm).Assembly.GetManifestResourceStream("SCCRMonPOS.RegistrationQr.png"))
            using (var source = Image.FromStream(stream)) _qr = new Bitmap(source);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            var g = e.Graphics;
            int w = ClientSize.Width, h = ClientSize.Height;
            float scale = Math.Min(w / 800f, h / 600f);
            using (var brand = new Font("Tahoma", 24f * scale, FontStyle.Bold))
            using (var heading = new Font("Tahoma", 27f * scale, FontStyle.Bold))
            using (var body = new Font("Tahoma", 15f * scale))
            using (var small = new Font("Tahoma", 10f * scale))
            using (var blue = new SolidBrush(Color.FromArgb(11, 31, 184)))
            using (var dark = new SolidBrush(Color.FromArgb(28, 36, 49)))
            using (var center = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center })
            {
                g.DrawString("ศิริชัยเภสัช · SC PHARMACY", brand, blue, new RectangleF(0, h * .025f, w, h * .09f), center);
                g.DrawString("สแกนเพื่อสมัครสมาชิก", heading, dark, new RectangleF(0, h * .12f, w, h * .10f), center);
                int size = Math.Min((int)(h * .57f), (int)(w * .7f));
                g.InterpolationMode = InterpolationMode.NearestNeighbor;
                g.PixelOffsetMode = PixelOffsetMode.Half;
                g.DrawImage(_qr, new Rectangle((w - size) / 2, (int)(h * .235f), size, size));
                g.DrawString("กรอกชื่อ นามสกุล และเบอร์โทรศัพท์ แล้วกดยืนยัน", body, dark, new RectangleF(0, h * .82f, w, h * .07f), center);
                g.DrawString("เปิดด้วยมือถือได้เลย", body, blue, new RectangleF(0, h * .89f, w, h * .055f), center);
                g.DrawString(CustomerDisplayController.RegistrationUrl, small, dark, new RectangleF(0, h * .95f, w, h * .035f), center);
            }
        }

        protected override void OnResize(EventArgs e) { base.OnResize(e); Invalidate(); }
        protected override void Dispose(bool disposing) { if (disposing) _qr?.Dispose(); base.Dispose(disposing); }
    }

    public sealed class RegistrationChoiceForm : Form
    {
        public bool DisplayedQr { get; private set; }
        public RegistrationChoiceForm(CustomerDisplayController display, Control cashier)
        {
            Text = "สมัครสมาชิก";
            Font = new Font("Tahoma", 10f);
            ClientSize = new Size(450, 315);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false; MinimizeBox = false;
            StartPosition = FormStartPosition.CenterParent;
            BackColor = Color.White;
            var title = new Label { Text = "เลือกวิธีสมัครสมาชิก", Bounds = new Rectangle(20, 15, 410, 30), Font = new Font(Font, FontStyle.Bold) };
            var staff = new Button { Text = "1. พนักงานสมัครให้", Bounds = new Rectangle(20, 52, 410, 42), DialogResult = DialogResult.OK };
            var label = new Label { Text = "2. ลูกค้าสแกน QR สมัครเอง — เลือกจอลูกค้า", Bounds = new Rectangle(20, 111, 410, 26) };
            var screens = Screen.AllScreens.Where(s => s.DeviceName != Screen.FromControl(cashier).DeviceName).ToArray();
            var list = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList, Bounds = new Rectangle(20, 143, 410, 30) };
            foreach (var screen in screens) list.Items.Add(screen.DeviceName + "  (" + screen.Bounds.Width + " × " + screen.Bounds.Height + ")");
            int preferred = Array.FindIndex(screens, s => s.DeviceName == display.PreferredDevice);
            if (screens.Length > 0) list.SelectedIndex = preferred >= 0 ? preferred : 0;
            var show = new Button { Text = "แสดง QR บนจอลูกค้า", Bounds = new Rectangle(20, 186, 250, 40), Enabled = screens.Length > 0 };
            var hide = new Button { Text = "ปิด QR", Bounds = new Rectangle(280, 186, 150, 40) };
            var help = new Label { Text = screens.Length > 0 ? "QR จะอยู่จนพนักงานกดปิด QR" : "ไม่พบจอลูกค้า กรุณาตั้งค่า Windows ให้ขยายจอภาพ", Bounds = new Rectangle(20, 237, 410, 28) };
            var close = new Button { Text = "กลับ", Bounds = new Rectangle(330, 275, 100, 30), DialogResult = DialogResult.Cancel };
            show.Click += (s, e) => {
                try
                {
                    display.ShowOn(screens[list.SelectedIndex], Owner ?? (IWin32Window)this);
                    DisplayedQr = true;
                    DialogResult = DialogResult.Cancel;
                    Close();
                }
                catch (Exception error) { MessageBox.Show(this, error.Message, "SCCRM", MessageBoxButtons.OK, MessageBoxIcon.Information); }
            };
            hide.Click += (s, e) => display.Hide();
            Controls.AddRange(new Control[] { title, staff, label, list, show, hide, help, close });
            CancelButton = close;
        }
    }
}
