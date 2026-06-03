using System;
using System.Drawing;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace SCCRMonPOS
{
    /// <summary>
    /// Create or edit a CRM member.
    /// Pass an existing MemberDetail to enter edit mode; leave null for create mode.
    /// On success fires MemberSaved with the resulting MemberSearchResult.
    /// </summary>
    public sealed class NewMemberForm : Form
    {
        private readonly ApiClient    _api;
        private readonly MemberDetail _existing;   // null = create mode
        private bool IsEditMode { get { return _existing != null; } }

        public event Action<MemberSearchResult> MemberSaved;

        private TextBox        _txtName;
        private TextBox        _txtPhone;
        private TextBox        _txtEmail;
        private RadioButton    _rdMale;
        private RadioButton    _rdFemale;
        private RadioButton    _rdUnspecified;
        private DateTimePicker _dtpDob;
        private CheckBox       _chkDobUnknown;
        private TextBox        _txtRemark;
        private Label          _lblStatus;
        private Button         _btnSave;
        private Button         _btnCancel;

        // ── Create mode ───────────────────────────────────────────────────────
        public NewMemberForm(ApiClient api) : this(api, null) { }

        // ── Edit mode ─────────────────────────────────────────────────────────
        public NewMemberForm(ApiClient api, MemberDetail existing)
        {
            _api      = api;
            _existing = existing;
            BuildUi();
            if (IsEditMode) Prefill(existing);
        }

        private void BuildUi()
        {
            SuspendLayout();

            Text            = IsEditMode ? "SCCRM — แก้ไขข้อมูลสมาชิก" : "SCCRM — เพิ่มสมาชิกใหม่";
            ClientSize      = new Size(420, 490);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox     = false;
            MinimizeBox     = false;
            TopMost         = true;
            StartPosition   = FormStartPosition.CenterParent;
            ShowInTaskbar   = false;
            BackColor       = Color.White;
            Font            = new Font("Tahoma", 9.5f);

            int x = 20, w = 380;

            var lblTitle = new Label
            {
                Text      = IsEditMode ? "แก้ไขข้อมูลสมาชิก" : "เพิ่มสมาชิกใหม่",
                AutoSize  = false,
                TextAlign = ContentAlignment.MiddleCenter,
                Font      = new Font("Tahoma", 13f, FontStyle.Bold),
                ForeColor = Color.FromArgb(16, 74, 132),
                Bounds    = new Rectangle(x, 12, w, 28)
            };

            var lblName = new Label { Text = "ชื่อ-นามสกุล *", Bounds = new Rectangle(x, 52, 140, 20) };
            _txtName = new TextBox { Bounds = new Rectangle(x, 72, w, 24), MaxLength = 200 };

            var lblPhone = new Label { Text = "เบอร์โทรศัพท์ *", Bounds = new Rectangle(x, 106, 140, 20) };
            _txtPhone = new TextBox { Bounds = new Rectangle(x, 126, 200, 24), MaxLength = 20 };

            var lblEmail = new Label { Text = "อีเมล", Bounds = new Rectangle(x, 160, 80, 20) };
            _txtEmail = new TextBox { Bounds = new Rectangle(x, 180, w, 24), MaxLength = 100 };

            var lblSex = new Label { Text = "เพศ", Bounds = new Rectangle(x, 214, 60, 20) };
            _rdMale        = new RadioButton { Text = "ชาย",     Bounds = new Rectangle(x,       234, 70, 22), Checked = true };
            _rdFemale      = new RadioButton { Text = "หญิง",    Bounds = new Rectangle(x + 74,  234, 70, 22) };
            _rdUnspecified = new RadioButton { Text = "ไม่ระบุ", Bounds = new Rectangle(x + 148, 234, 80, 22) };

            var lblDob = new Label { Text = "วันเกิด", Bounds = new Rectangle(x, 266, 80, 20) };
            _dtpDob = new DateTimePicker
            {
                Bounds = new Rectangle(x, 286, 200, 24),
                Format = DateTimePickerFormat.Short,
                Value  = DateTime.Today.AddYears(-25)
            };
            _chkDobUnknown = new CheckBox
            {
                Text    = "ไม่ทราบ",
                Bounds  = new Rectangle(x + 210, 287, 80, 22),
                Checked = true
            };
            _chkDobUnknown.CheckedChanged += (s, e) => _dtpDob.Enabled = !_chkDobUnknown.Checked;
            _dtpDob.Enabled = false;

            var lblRmk = new Label { Text = "หมายเหตุ", Bounds = new Rectangle(x, 320, 100, 20) };
            _txtRemark = new TextBox { Bounds = new Rectangle(x, 340, w, 22), MaxLength = 200 };

            _lblStatus = new Label
            {
                AutoSize  = false,
                TextAlign = ContentAlignment.MiddleCenter,
                Font      = new Font("Tahoma", 9f),
                ForeColor = Color.FromArgb(120, 120, 120),
                Bounds    = new Rectangle(x, 374, w, 22),
                Text      = "* จำเป็นต้องกรอก"
            };

            _btnCancel = new Button
            {
                Text                  = "ยกเลิก",
                Bounds                = new Rectangle(x, 406, 100, 32),
                UseVisualStyleBackColor = true
            };
            _btnCancel.Click += (s, e) => { DialogResult = DialogResult.Cancel; Close(); };

            string saveLabel = IsEditMode ? "บันทึกการแก้ไข" : "บันทึกสมาชิก";
            _btnSave = new Button
            {
                Text      = saveLabel,
                Bounds    = new Rectangle(x + w - 144, 406, 148, 32),
                BackColor = IsEditMode ? Color.FromArgb(140, 80, 0) : Color.FromArgb(16, 74, 132),
                ForeColor = Color.White,
                FlatStyle = FlatStyle.Flat
            };
            _btnSave.FlatAppearance.BorderSize = 0;
            _btnSave.Click += async (s, e) => await SaveAsync();

            AcceptButton = _btnSave;
            CancelButton = _btnCancel;

            Controls.AddRange(new Control[]
            {
                lblTitle,
                lblName, _txtName,
                lblPhone, _txtPhone,
                lblEmail, _txtEmail,
                lblSex, _rdMale, _rdFemale, _rdUnspecified,
                lblDob, _dtpDob, _chkDobUnknown,
                lblRmk, _txtRemark,
                _lblStatus,
                _btnCancel, _btnSave
            });

            ResumeLayout(false);
        }

        private void Prefill(MemberDetail m)
        {
            _txtName.Text  = m.DisplayName ?? "";
            _txtPhone.Text = m.Phone       ?? "";
            _txtEmail.Text = m.Email       ?? "";
            _txtRemark.Text = m.Remark     ?? "";

            if (m.Sex == "1")      _rdMale.Checked        = true;
            else if (m.Sex == "2") _rdFemale.Checked      = true;
            else                   _rdUnspecified.Checked = true;

            DateTime dob;
            if (!string.IsNullOrWhiteSpace(m.Dob) && DateTime.TryParse(m.Dob, out dob))
            {
                _chkDobUnknown.Checked = false;
                _dtpDob.Value          = dob;
                _dtpDob.Enabled        = true;
            }
        }

        private async Task SaveAsync()
        {
            string name  = _txtName.Text.Trim();
            string phone = _txtPhone.Text.Trim();

            if (string.IsNullOrWhiteSpace(name))  { SetStatus("กรุณาใส่ชื่อ-นามสกุล", true);  return; }
            if (string.IsNullOrWhiteSpace(phone)) { SetStatus("กรุณาใส่เบอร์โทรศัพท์", true); return; }

            SetStatus(IsEditMode ? "กำลังบันทึกการแก้ไข…" : "กำลังบันทึก…", false, Color.DimGray);
            _btnSave.Enabled = false;

            string sex = _rdMale.Checked ? "1" : (_rdFemale.Checked ? "2" : "");
            string dob = _chkDobUnknown.Checked ? null : _dtpDob.Value.ToString("yyyy-MM-dd");

            var request = new CreateMemberRequest
            {
                Name   = name,
                Phone  = phone,
                Email  = _txtEmail.Text.Trim(),
                Sex    = sex,
                Dob    = dob,
                Remark = _txtRemark.Text.Trim()
            };

            MemberSearchResult result = null;
            string errorMsg = null;
            try
            {
                result = IsEditMode
                    ? await _api.UpdateMemberAsync(_existing.Id, request)
                    : await _api.CreateMemberAsync(request);
            }
            catch (Exception ex) { errorMsg = ex.Message; }

            if (errorMsg != null)
            {
                SetStatus(MapError(errorMsg), true);
                _btnSave.Enabled = true;
                return;
            }

            MemberSaved?.Invoke(result);
            DialogResult = DialogResult.OK;
            Close();
        }

        private void SetStatus(string text, bool isError, Color? color = null)
        {
            _lblStatus.ForeColor = color ?? (isError ? Color.FromArgb(160, 0, 0) : Color.FromArgb(120, 120, 120));
            _lblStatus.Text = text;
        }

        private static string MapError(string raw)
        {
            if (raw == null) return "ข้อผิดพลาดที่ไม่ทราบสาเหตุ";
            if (raw.IndexOf("duplicate", StringComparison.OrdinalIgnoreCase) >= 0 ||
                raw.IndexOf("already",   StringComparison.OrdinalIgnoreCase) >= 0)
                return "เบอร์โทรหรืออีเมลนี้มีในระบบแล้ว";
            if (raw.IndexOf("phone", StringComparison.OrdinalIgnoreCase) >= 0)
                return "รูปแบบเบอร์โทรไม่ถูกต้อง";
            return raw;
        }
    }
}
