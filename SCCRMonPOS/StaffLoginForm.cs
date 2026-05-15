using System;
using System.Drawing;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace SCCRMonPOS
{
    /// <summary>
    /// Simple PIN entry dialog shown the first time the app runs (or when the
    /// staff token is missing/revoked).  On success the token is saved via
    /// StaffAuthManager.  On cancel the app exits.
    /// </summary>
    public class StaffLoginForm : Form
    {
        private readonly ApiClient       _api;
        private readonly StaffAuthManager _auth;

        private TextBox  _txtPin;
        private Label    _lblError;
        private Button   _btnLogin;
        private Button   _btnCancel;

        public StaffLoginForm(ApiClient api, StaffAuthManager auth)
        {
            _api  = api;
            _auth = auth;
            BuildUi();
        }

        private void BuildUi()
        {
            Text            = "SCCRM — ยืนยันตัวตนพนักงาน";
            ClientSize      = new Size(340, 190);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox     = false;
            MinimizeBox     = false;
            TopMost         = true;
            StartPosition   = FormStartPosition.CenterScreen;
            Font            = new Font("Tahoma", 9.5f);
            BackColor       = Color.White;

            var lblTitle = new Label
            {
                Text      = "กรุณากรอกรหัส PIN พนักงาน",
                Location  = new Point(20, 20),
                AutoSize  = true,
                Font      = new Font("Tahoma", 10f, FontStyle.Bold)
            };

            var lblDevice = new Label
            {
                Text      = "Device: " + _auth.DeviceName,
                Location  = new Point(20, 48),
                AutoSize  = true,
                ForeColor = Color.Gray
            };

            var lblPinCaption = new Label
            {
                Text     = "PIN :",
                Location = new Point(20, 82),
                AutoSize = true
            };

            _txtPin = new TextBox
            {
                Location      = new Point(70, 79),
                Size          = new Size(160, 23),
                PasswordChar  = '●',
                MaxLength     = 20
            };
            _txtPin.KeyDown += (s, e) =>
            {
                if (e.KeyCode == Keys.Return) { e.SuppressKeyPress = true; PerformLogin(); }
            };

            _lblError = new Label
            {
                Text      = "",
                Location  = new Point(20, 112),
                Size      = new Size(300, 18),
                ForeColor = Color.Crimson
            };

            _btnLogin = new Button
            {
                Text      = "เข้าสู่ระบบ",
                Location  = new Point(140, 145),
                Size      = new Size(90, 30),
                BackColor = Color.FromArgb(0, 120, 215),
                ForeColor = Color.White,
                FlatStyle = FlatStyle.Flat
            };
            _btnLogin.FlatAppearance.BorderSize = 0;
            _btnLogin.Click += (s, e) => PerformLogin();

            _btnCancel = new Button
            {
                Text     = "ยกเลิก",
                Location = new Point(238, 145),
                Size     = new Size(78, 30),
                UseVisualStyleBackColor = true
            };
            _btnCancel.Click += (s, e) => { DialogResult = DialogResult.Cancel; Close(); };

            Controls.AddRange(new Control[]
            {
                lblTitle, lblDevice, lblPinCaption, _txtPin, _lblError, _btnLogin, _btnCancel
            });
        }

        private async void PerformLogin()
        {
            string pin = _txtPin.Text;
            if (string.IsNullOrEmpty(pin))
            {
                _lblError.Text = "กรุณากรอก PIN";
                return;
            }

            _btnLogin.Enabled  = false;
            _btnCancel.Enabled = false;
            _lblError.Text     = "กำลังเชื่อมต่อ…";

            try
            {
                string token = await _api.AuthenticateStaffDeviceAsync(
                    _auth.DeviceId, _auth.DeviceName, pin);
                _auth.SaveToken(token);
                _api.SetStaffToken(token);
                DialogResult = DialogResult.OK;
                Close();
            }
            catch (ApiException ex)
            {
                _lblError.Text     = ex.Message;
                _btnLogin.Enabled  = true;
                _btnCancel.Enabled = true;
                _txtPin.SelectAll();
                _txtPin.Focus();
            }
        }
    }
}
