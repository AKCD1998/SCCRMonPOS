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
    public partial class NewMemberForm : Form
    {
        private readonly ApiClient    _api;
        private readonly MemberDetail _existing;   // null = create mode
        private bool IsEditMode { get { return _existing != null; } }

        public event Action<MemberSearchResult> MemberSaved;
        public MemberDetail SavedDetail { get; private set; }

        private Models.PharmacyMedRecord _medRecord;
        private string _savedMemberId;
        private PharmacyMedRecordForm _medRecordForm;

        // For Visual Studio Designer only — do not call at runtime
        public NewMemberForm() { InitializeComponent(); WireEvents(); }

        // ── Create mode ───────────────────────────────────────────────────────
        public NewMemberForm(ApiClient api) : this(api, null) { }

        // ── Edit mode ─────────────────────────────────────────────────────────
        public NewMemberForm(ApiClient api, MemberDetail existing)
        {
            _api      = api;
            _existing = existing;
            _medRecord = existing != null ? existing.PharmacyMedRecord : null;
            InitializeComponent();
            WireEvents();
            AddMedRecordButton();
            if (IsEditMode) ApplyEditModeStyle();
            if (IsEditMode) Prefill(existing);
        }

        private void AddMedRecordButton()
        {
            // Leave enough room on the right for the longer med-record button label
            lblTitle.Bounds    = new Rectangle(20, 12, 170, 28);
            lblTitle.TextAlign = System.Drawing.ContentAlignment.MiddleLeft;

            var btn = new Button
            {
                Text      = "เพิ่มข้อมูลเวชระเบียน/ขย.10-ขย.11",
                Bounds    = new Rectangle(192, 12, 208, 26),
                FlatStyle = FlatStyle.Flat,
                BackColor = Color.FromArgb(243, 248, 255),
                ForeColor = Color.FromArgb(18, 92, 191),
                Font      = new Font("Tahoma", 8f),
                Anchor    = AnchorStyles.Top | AnchorStyles.Right
            };
            btn.FlatAppearance.BorderColor = Color.FromArgb(18, 92, 191);
            btn.Click += OnMedRecordClick;
            Controls.Add(btn);
            btn.BringToFront();
        }

        private void OnMedRecordClick(object sender, EventArgs e)
        {
            var screen = System.Windows.Forms.Screen.FromControl(this).WorkingArea;

            // If already open, re-snap both windows and focus the med record form
            if (_medRecordForm != null && !_medRecordForm.IsDisposed)
            {
                SnapSideBySide(screen);
                _medRecordForm.Focus();
                return;
            }

            string memberId = _existing?.Id ?? _savedMemberId ?? "";
            _medRecordForm = new PharmacyMedRecordForm(memberId, _medRecord);
            _medRecordForm.RecordSaved += rec => _medRecord = rec;
            _medRecordForm.StartPosition = FormStartPosition.Manual;

            SnapSideBySide(screen);
            _medRecordForm.Show(this);
        }

        private void SnapSideBySide(System.Drawing.Rectangle screen)
        {
            // Snap this form to the left, med record form to the right
            int gap    = 10;
            int leftX  = screen.Left + 20;
            int rightX = leftX + this.Width + gap;
            int thisY  = screen.Top + Math.Max(0, (screen.Height - this.Height) / 2);
            int medY   = screen.Top + Math.Max(0, (screen.Height - (_medRecordForm?.Height ?? 660)) / 2);

            this.Location = new System.Drawing.Point(leftX, thisY);
            if (_medRecordForm != null && !_medRecordForm.IsDisposed)
                _medRecordForm.Location = new System.Drawing.Point(rightX, medY);
        }

        private void WireEvents()
        {
            _chkDobUnknown.CheckedChanged += (s, e) => _dtpDob.Enabled = !_chkDobUnknown.Checked;
            _btnCancel.Click += (s, e) => { DialogResult = DialogResult.Cancel; Close(); };
            _btnSave.Click   += async (s, e) => await SaveAsync();
        }

        private void ApplyEditModeStyle()
        {
            Text           = "SCCRM — แก้ไขข้อมูลสมาชิก";
            lblTitle.Text  = "แก้ไขข้อมูลสมาชิก";
            _btnSave.Text  = "บันทึกการแก้ไข";
            _btnSave.BackColor = Color.FromArgb(140, 80, 0);
        }

        private void Prefill(MemberDetail m)
        {
            _txtName.Text  = m.DisplayName ?? "";
            _txtPhone.Text = m.Phone       ?? "";
            _txtEmail.Text = m.Email       ?? "";
            _txtRemark.Text = m.Remark     ?? "";

            if (string.Equals(m.Sex, "1", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(m.Sex, "male", StringComparison.OrdinalIgnoreCase))
                _rdMale.Checked = true;
            else if (string.Equals(m.Sex, "2", StringComparison.OrdinalIgnoreCase) ||
                     string.Equals(m.Sex, "female", StringComparison.OrdinalIgnoreCase))
                _rdFemale.Checked = true;
            else
                _rdUnspecified.Checked = true;

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

            string sex = _rdMale.Checked ? "male" : (_rdFemale.Checked ? "female" : "");
            string dob = _chkDobUnknown.Checked ? null : _dtpDob.Value.ToString("yyyy-MM-dd");

            var request = new CreateMemberRequest
            {
                Name = name,
                Phone = phone,
                Email = _txtEmail.Text.Trim(),
                Sex = sex,
                Dob = dob,
                Remark = _txtRemark.Text.Trim(),
                PharmacyMedRecord = _medRecord
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

            if (IsEditMode)
            {
                SavedDetail = new MemberDetail
                {
                    Id = _existing.Id,
                    DisplayName = name,
                    FirstName = _existing.FirstName,
                    LastName = _existing.LastName,
                    Phone = phone,
                    Email = _txtEmail.Text.Trim(),
                    MemberCode = _existing.MemberCode,
                    CurrentPoints = _existing.CurrentPoints,
                    Sex = sex,
                    Dob = dob,
                    Remark = _txtRemark.Text.Trim(),
                    ThaiId = _existing.ThaiId,
                    PharmacyMedRecord = _medRecord
                };
            }
            else
            {
                _savedMemberId = result != null ? result.Id : null;
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
