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
    public partial class StaffLoginForm : Form
    {
        private readonly ApiClient        _api;
        private readonly StaffAuthManager _auth;

        // For Visual Studio Designer only — do not call at runtime
        public StaffLoginForm() { InitializeComponent(); }

        public StaffLoginForm(ApiClient api, StaffAuthManager auth)
        {
            _api  = api;
            _auth = auth;
            InitializeComponent();
            lblDevice.Text = "Device: " + _auth.DeviceName;
            _txtPin.KeyDown  += (s, e) => { if (e.KeyCode == Keys.Return) { e.SuppressKeyPress = true; PerformLogin(); } };
            _btnLogin.Click  += (s, e) => PerformLogin();
            _btnCancel.Click += (s, e) => { DialogResult = DialogResult.Cancel; Close(); };
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
