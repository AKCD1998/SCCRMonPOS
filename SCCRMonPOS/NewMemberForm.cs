using System;
using System.Drawing;
using System.Globalization;
using System.Text.RegularExpressions;
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
        private bool _saving;
        private const string PhoneHint = "กรอกมือถือไทย 10 หลัก ขึ้นต้น 06, 08 หรือ 09";

        public event Action<MemberSearchResult> MemberSaved;
        public MemberDetail SavedDetail { get; private set; }
        internal MemberSearchResult SavedMember { get; private set; }
        private readonly string _registrationRequestId = Guid.NewGuid().ToString("D");

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
            if (existing == null || existing.PharmacyMedRecordAvailable) AddMedRecordButton();
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
            _txtPhone.TextChanged += (s, e) => ValidateRegistrationPhone();
            if (!IsEditMode)
            {
                lblPhone.Width = 380;
                lblPhone.Text = "มือถือไทย 10 หลัก (06 / 08 / 09) *";
                _txtPhone.MaxLength = 40;
                ValidateRegistrationPhone();
            }
        }

        internal static string NormalizeRegistrationPhone(string value)
        {
            if (value == null || value.Length > 40) return null;
            string phone = Regex.Replace(value, "[๐-๙]", match => ((char)('0' + match.Value[0] - '๐')).ToString());
            if (!Regex.IsMatch(phone, @"\A[0-9+\s()-]+\z")) return null;
            phone = Regex.Replace(phone, @"[\s()-]", "");
            if (phone.StartsWith("+66", StringComparison.Ordinal)) phone = "0" + phone.Substring(3);
            else if (phone.StartsWith("0066", StringComparison.Ordinal)) phone = "0" + phone.Substring(4);
            return Regex.IsMatch(phone, @"\A0[689][0-9]{8}\z") ? phone : null;
        }

        private void ValidateRegistrationPhone()
        {
            if (IsEditMode) return;
            bool valid = NormalizeRegistrationPhone(_txtPhone.Text) != null;
            _btnSave.Enabled = !_saving && valid;
            if (_saving) return;
            if (!valid) SetStatus(PhoneHint, _txtPhone.Text.Length > 0);
            else if (_lblStatus.Text == PhoneHint) SetStatus("", false);
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
            if (!string.IsNullOrWhiteSpace(m.Dob) &&
                DateTime.TryParseExact(m.Dob, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out dob) &&
                dob >= _dtpDob.MinDate && dob <= _dtpDob.MaxDate)
            {
                _chkDobUnknown.Checked = false;
                _dtpDob.Value          = dob;
                _dtpDob.Enabled        = true;
            }
        }

        private async Task SaveAsync()
        {
            if (_saving) return;
            string name  = _txtName.Text.Trim();
            string phone = _txtPhone.Text.Trim();

            if (string.IsNullOrWhiteSpace(name))  { SetStatus("กรุณาใส่ชื่อ-นามสกุล", true);  return; }
            if (string.IsNullOrWhiteSpace(phone)) { SetStatus("กรุณาใส่เบอร์โทรศัพท์", true); return; }
            if (!IsEditMode)
            {
                phone = NormalizeRegistrationPhone(phone);
                if (phone == null) { SetStatus(PhoneHint, true); _txtPhone.Focus(); return; }
                _txtPhone.Text = phone;
            }
            if (_medRecordForm != null && !_medRecordForm.IsDisposed)
            {
                SetStatus("กรุณากดใช้ข้อมูลนี้หรือยกเลิกในหน้าเวชระเบียนก่อน", true);
                _medRecordForm.Activate();
                return;
            }

            SetStatus(IsEditMode ? "กำลังบันทึกการแก้ไข…" : "กำลังบันทึก…", false, Color.DimGray);
            _saving = true;
            _btnSave.Enabled = false;

            var request = BuildRequest();

            MemberSearchResult result = null;
            string errorMsg = null;
            try
            {
                result = IsEditMode
                    ? await _api.UpdateMemberAsync(_existing.Id, request)
                    : await RegisterMemberAsync(request);
            }
            catch (Exception ex) { errorMsg = ex.Message; }

            if (errorMsg != null || result == null)
            {
                _saving = false;
                _btnSave.Enabled = true;
                ValidateRegistrationPhone();
                if (errorMsg != null) SetStatus(MapError(errorMsg), true);
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
                    CurrentPoints = result.CurrentPoints,
                    PointsAvailable = result.PointsAvailable,
                    PointsSource = result.PointsSource, PointsStatus=result.PointsStatus,
                    PointsObservedAt=result.PointsObservedAt, BalanceExact=result.BalanceExact,
                    PharmacyMedRecordAvailable = result.PharmacyMedRecordAvailable,
                    Sex = request.Sex,
                    Dob = request.Dob,
                    Remark = _txtRemark.Text.Trim(),
                    ThaiId = _existing.ThaiId,
                    PharmacyMedRecord = _medRecord
                };
            }
            else
            {
                _savedMemberId = result != null ? result.Id : null;
            }

            SavedMember = result;
            MemberSaved?.Invoke(result);
            DialogResult = DialogResult.OK;
            Close();
        }

        private bool CanShowRegistrationQuestion()
        {
            var cashier = Owner as MemberClaimForm;
            return Visible && WindowState != FormWindowState.Minimized && cashier?.IsParkedForSales?.Invoke() != true;
        }

        private async Task<MemberSearchResult> RegisterMemberAsync(CreateMemberRequest request)
        {
            SetStatus("กำลังตรวจว่าเคยสมัครไว้หรือยัง…", false, Color.DimGray);
            var options = await _api.GetRegistrationOptionsAsync(request, _registrationRequestId);
            string action = options.CompletedAction ?? "new", candidateId = null;
            if (string.IsNullOrWhiteSpace(options.CompletedMemberId) && options.Candidates.Length > 0)
            {
                if (!CanShowRegistrationQuestion()) { SetStatus("พบชื่อที่ใช้เบอร์นี้ กดบันทึกอีกครั้งเมื่อพร้อมเลือก", false); return null; }
                using (var question = new RegistrationMatchForm(options.Candidates))
                {
                    if (question.ShowDialog(this) != DialogResult.OK) { SetStatus("แก้ข้อมูลแล้วกดบันทึกอีกครั้งได้เลย", false); return null; }
                    action = question.UseExisting ? "existing" : "new";
                    candidateId = question.SelectedCandidateId;
                }
            }
            SetStatus("กำลังบันทึกข้อมูลที่เลือก…", false, Color.DimGray);
            var result = await _api.ConfirmMemberRegistrationAsync(request, options, action, candidateId);
            if (action == "existing" && _medRecord != null)
            {
                var detail = await _api.GetMemberAsync(result.Id);
                detail.PharmacyMedRecord = _medRecord;
                if (!CanShowRegistrationQuestion()) { SetStatus("เลือกชื่อเดิมแล้ว กดบันทึกอีกครั้งเพื่อดูข้อมูลเวชระเบียนที่กรอกไว้", false); return null; }
                using (var edit = new NewMemberForm(_api, detail))
                {
                    if (edit.ShowDialog(this) != DialogResult.OK) return null;
                    result = edit.SavedMember;
                    SavedDetail = edit.SavedDetail;
                }
            }
            return result;
        }

        internal CreateMemberRequest BuildRequest()
        {
            return new CreateMemberRequest
            {
                Name = _txtName.Text.Trim(), Phone = _txtPhone.Text.Trim(), Email = _txtEmail.Text.Trim(),
                Sex = _rdMale.Checked ? "male" : (_rdFemale.Checked ? "female" : ""),
                // The API date is Gregorian ISO regardless of the Windows display calendar.
                Dob = _chkDobUnknown.Checked ? null : _dtpDob.Value.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
                Remark = _txtRemark.Text.Trim(), PharmacyMedRecord = _medRecord
            };
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
