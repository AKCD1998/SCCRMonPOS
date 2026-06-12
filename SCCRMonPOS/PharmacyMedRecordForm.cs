using System;
using System.Drawing;
using System.Text.RegularExpressions;
using System.Windows.Forms;
using SCCRMonPOS.Models;

namespace SCCRMonPOS
{
    public class PharmacyMedRecordForm : Form
    {
        public event Action<PharmacyMedRecord> RecordSaved;

        private readonly string _memberId;
        private readonly PharmacyMedRecord _existing;
        private bool _isPidExpanded;

        private Panel     _pnlPidSection;
        private Panel     _pnlPidHeader;
        private Panel     _pnlPidContent;
        private Label     _lblPidToggle;
        private Label     _lblPidHeaderText;
        private RadioButton _rdPidThai;
        private RadioButton _rdPidNoNationality;
        private RadioButton _rdPidPassport;
        private RadioButton _rdPidOther;
        private TextBox   _txtPidDocumentNumber;

        // 5 — สุขภาพพื้นฐาน
        private TextBox   _txtWeight;
        private TextBox   _txtHeight;
        private TextBox   _txtBpSys;
        private TextBox   _txtBpDia;
        private ComboBox  _cboBloodType;
        private ComboBox  _cboBloodRh;

        // 7 — โรคประจำตัว
        private CheckBox  _chkDiabetes;
        private CheckBox  _chkHypertension;
        private CheckBox  _chkHyperlipidemia;
        private CheckBox  _chkHeartDisease;
        private CheckBox  _chkKidneyDisease;
        private CheckBox  _chkLiverDisease;
        private CheckBox  _chkThyroid;
        private TextBox   _txtOtherConditions;

        // 8 — แพ้ยา/อาหาร
        private TextBox   _txtDrugAllergies;
        private TextBox   _txtFoodAllergies;

        // 9 — ยาที่ใช้ปัจจุบัน
        private TextBox   _txtCurrentMeds;

        // 10 — ประวัติการเจ็บป่วย
        private TextBox   _txtMedHistory;

        // 12 — คัดกรอง
        private CheckBox  _chkSmoking;
        private CheckBox  _chkAlcohol;
        private CheckBox  _chkPregnant;
        private CheckBox  _chkBreastfeeding;

        private Label     _lblStatus;
        private Button    _btnSave;
        private Button    _btnCancel;

        public PharmacyMedRecordForm(string memberId, PharmacyMedRecord existing = null)
        {
            _memberId = memberId;
            _existing = existing;
            BuildUi();
            if (_existing != null) Prefill(_existing);
        }

        private void BuildUi()
        {
            Text            = "SCCRM — เวชระเบียนเภสัชกรรม";
            ClientSize      = new Size(450, 660);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox     = false;
            MinimizeBox     = false;
            TopMost         = true;
            StartPosition   = FormStartPosition.CenterParent;
            ShowInTaskbar   = false;
            BackColor       = Color.White;
            Font            = new Font("Tahoma", 9.5f);

            const int fw = 418; // field width inside scroll panel

            var scroll = new FlowLayoutPanel
            {
                Location      = new Point(0, 0),
                Size          = new Size(450, 608),
                AutoScroll    = true,
                BackColor     = Color.White,
                FlowDirection = FlowDirection.TopDown,
                WrapContents  = false
            };
            scroll.Padding = new Padding(0, 10, 0, 10);

            scroll.Controls.Add(BuildPidSectionPanel(fw));
            scroll.Controls.Add(BuildBasicHealthPanel(fw));
            scroll.Controls.Add(BuildConditionsPanel(fw));
            scroll.Controls.Add(BuildAllergyPanel(fw));
            scroll.Controls.Add(BuildCurrentMedsPanel(fw));
            scroll.Controls.Add(BuildMedicalHistoryPanel(fw));
            scroll.Controls.Add(BuildScreeningPanel(fw));

            // ── Fixed bottom bar ──────────────────────────────────────────
            var bar = new Panel
            {
                Location    = new Point(0, 608),
                Size        = new Size(450, 52),
                BackColor   = Color.FromArgb(248, 249, 252),
                BorderStyle = BorderStyle.FixedSingle
            };

            _lblStatus = new Label
            {
                AutoSize  = false,
                TextAlign = ContentAlignment.MiddleLeft,
                ForeColor = Color.FromArgb(160, 0, 0),
                Bounds    = new Rectangle(12, 12, 200, 28),
                Font      = new Font("Tahoma", 8.5f)
            };

            _btnCancel = new Button
            {
                Text                    = "ยกเลิก",
                Bounds                  = new Rectangle(230, 10, 90, 30),
                UseVisualStyleBackColor = true,
                FlatStyle               = FlatStyle.Flat
            };
            _btnCancel.FlatAppearance.BorderColor = Color.FromArgb(200, 208, 220);
            _btnCancel.Click += (s, e) => Close();

            _btnSave = new Button
            {
                Text      = "บันทึก",
                Bounds    = new Rectangle(330, 10, 100, 30),
                BackColor = Color.FromArgb(16, 74, 132),
                ForeColor = Color.White,
                FlatStyle = FlatStyle.Flat
            };
            _btnSave.FlatAppearance.BorderSize = 0;
            _btnSave.Click += OnSaveClick;

            bar.Controls.AddRange(new Control[] { _lblStatus, _btnCancel, _btnSave });

            Controls.Add(scroll);
            Controls.Add(bar);
        }

        private void OnSaveClick(object sender, EventArgs e)
        {
            string pidDocumentType;
            string pidDocumentNumberRaw;
            string pidDocumentNumberNormalized;
            if (!TryBuildPidFields(out pidDocumentType, out pidDocumentNumberRaw, out pidDocumentNumberNormalized))
                return;

            var rec = new PharmacyMedRecord
            {
                MemberId                    = _memberId,
                PidDocumentType             = pidDocumentType,
                PidDocumentNumberRaw        = pidDocumentNumberRaw,
                PidDocumentNumberNormalized = pidDocumentNumberNormalized,
                WeightKg                    = _txtWeight.Text.Trim(),
                HeightCm                    = _txtHeight.Text.Trim(),
                BpSystolic                  = _txtBpSys.Text.Trim(),
                BpDiastolic = _txtBpDia.Text.Trim(),
                BloodType  = _cboBloodType.SelectedIndex > 0 ? _cboBloodType.Text : "",
                BloodRh    = _cboBloodRh.SelectedIndex > 0 ? _cboBloodRh.Text : "",

                HasDiabetes       = _chkDiabetes.Checked,
                HasHypertension   = _chkHypertension.Checked,
                HasHyperlipidemia = _chkHyperlipidemia.Checked,
                HasHeartDisease   = _chkHeartDisease.Checked,
                HasKidneyDisease  = _chkKidneyDisease.Checked,
                HasLiverDisease   = _chkLiverDisease.Checked,
                HasThyroidDisease = _chkThyroid.Checked,
                OtherConditions   = _txtOtherConditions.Text.Trim(),

                DrugAllergies     = _txtDrugAllergies.Text.Trim(),
                FoodAllergies     = _txtFoodAllergies.Text.Trim(),

                CurrentMedications = _txtCurrentMeds.Text.Trim(),
                MedicalHistory     = _txtMedHistory.Text.Trim(),

                IsSmoker        = _chkSmoking.Checked,
                DrinksAlcohol   = _chkAlcohol.Checked,
                IsPregnant      = _chkPregnant.Checked,
                IsBreastfeeding = _chkBreastfeeding.Checked
            };

            RecordSaved?.Invoke(rec);
            Close();
        }

        private void Prefill(PharmacyMedRecord r)
        {
            _txtWeight.Text  = r.WeightKg   ?? "";
            _txtHeight.Text  = r.HeightCm   ?? "";
            _txtBpSys.Text   = r.BpSystolic  ?? "";
            _txtBpDia.Text   = r.BpDiastolic ?? "";

            if (!string.IsNullOrWhiteSpace(r.PidDocumentType) ||
                !string.IsNullOrWhiteSpace(r.PidDocumentNumberRaw) ||
                !string.IsNullOrWhiteSpace(r.PidDocumentNumberNormalized))
            {
                SetPidExpanded(true);
            }

            switch (r.PidDocumentType)
            {
                case "THAI_ID":
                case "สัญชาติไทย":
                    _rdPidThai.Checked = true;
                    break;
                case "ALIEN_ID":
                case "ไม่มีสัญชาติไทย":
                    _rdPidNoNationality.Checked = true;
                    break;
                case "PASSPORT":
                case "พาสปอร์ต":
                    _rdPidPassport.Checked = true;
                    break;
                case "OTHER":
                case "อื่น ๆ":
                case "อื่นๆ":
                    _rdPidOther.Checked = true;
                    break;
            }
            _txtPidDocumentNumber.Text = r.PidDocumentNumberRaw ?? r.PidDocumentNumberNormalized ?? "";

            int btIdx = _cboBloodType.Items.IndexOf(r.BloodType ?? "");
            _cboBloodType.SelectedIndex = btIdx >= 0 ? btIdx : 0;
            int rhIdx = _cboBloodRh.Items.IndexOf(r.BloodRh ?? "");
            _cboBloodRh.SelectedIndex = rhIdx >= 0 ? rhIdx : 0;

            _chkDiabetes.Checked       = r.HasDiabetes;
            _chkHypertension.Checked   = r.HasHypertension;
            _chkHyperlipidemia.Checked = r.HasHyperlipidemia;
            _chkHeartDisease.Checked   = r.HasHeartDisease;
            _chkKidneyDisease.Checked  = r.HasKidneyDisease;
            _chkLiverDisease.Checked   = r.HasLiverDisease;
            _chkThyroid.Checked        = r.HasThyroidDisease;
            _txtOtherConditions.Text   = r.OtherConditions ?? "";

            _txtDrugAllergies.Text  = r.DrugAllergies      ?? "";
            _txtFoodAllergies.Text  = r.FoodAllergies       ?? "";
            _txtCurrentMeds.Text    = r.CurrentMedications  ?? "";
            _txtMedHistory.Text     = r.MedicalHistory      ?? "";

            _chkSmoking.Checked       = r.IsSmoker;
            _chkAlcohol.Checked       = r.DrinksAlcohol;
            _chkPregnant.Checked      = r.IsPregnant;
            _chkBreastfeeding.Checked = r.IsBreastfeeding;
        }

        // ── UI builder helpers ────────────────────────────────────────────

        private Panel BuildPidSectionPanel(int fieldWidth)
        {
            _pnlPidSection = CreateSectionPanel(430, 34);
            _pnlPidHeader = CreateSectionHeaderPanel("ยา ขย.10/ขย.11", true, Color.FromArgb(184, 32, 32));
            _pnlPidHeader.BackColor = Color.FromArgb(255, 234, 234);
            _pnlPidHeader.Cursor = Cursors.Hand;
            _pnlPidHeader.Click += (s, e) => TogglePidSection();
            foreach (Control child in _pnlPidHeader.Controls)
            {
                child.Cursor = Cursors.Hand;
                child.Click += (s, e) => TogglePidSection();
            }

            _lblPidHeaderText = _pnlPidHeader.Controls.Count > 0 ? _pnlPidHeader.Controls[0] as Label : null;
            if (_lblPidHeaderText != null)
                _lblPidHeaderText.ForeColor = Color.FromArgb(184, 32, 32);

            _lblPidToggle = new Label
            {
                Text = "+",
                AutoSize = false,
                Bounds = new Rectangle(392, 4, 20, 18),
                TextAlign = ContentAlignment.MiddleCenter,
                Font = new Font("Tahoma", 11f, FontStyle.Bold),
                ForeColor = Color.FromArgb(184, 32, 32)
            };
            _pnlPidHeader.Controls.Add(_lblPidToggle);

            _pnlPidContent = new Panel
            {
                Bounds = new Rectangle(0, 34, 430, 150),
                BackColor = Color.White,
                Visible = false
            };

            var group = new GroupBox
            {
                Text = "รหัส PID / เลขเอกสารประจำตัว",
                Bounds = new Rectangle(16, 0, 398, 140)
            };

            _rdPidThai = new RadioButton { Text = "สัญชาติไทย", Bounds = new Rectangle(16, 24, 140, 22) };
            _rdPidNoNationality = new RadioButton { Text = "ไม่มีสัญชาติไทย", Bounds = new Rectangle(200, 24, 150, 22) };
            _rdPidPassport = new RadioButton { Text = "พาสปอร์ต", Bounds = new Rectangle(16, 50, 140, 22) };
            _rdPidOther = new RadioButton { Text = "อื่น ๆ", Bounds = new Rectangle(200, 50, 100, 22) };
            _txtPidDocumentNumber = AddTextBox(group, 16, 84, 360);

            group.Controls.AddRange(new Control[]
            {
                _rdPidThai,
                _rdPidNoNationality,
                _rdPidPassport,
                _rdPidOther
            });

            _pnlPidContent.Controls.Add(group);
            _pnlPidSection.Controls.Add(_pnlPidHeader);
            _pnlPidSection.Controls.Add(_pnlPidContent);
            return _pnlPidSection;
        }

        private Panel BuildBasicHealthPanel(int fieldWidth)
        {
            var panel = CreateSectionPanel(430, 240);
            int y = AddSectionHeader(panel, "ข้อมูลสุขภาพพื้นฐาน", 0);

            AddLabel(panel, "น้ำหนัก (กก.)", 16, y); y += 20;
            _txtWeight = AddTextBox(panel, 16, y, 80); y += 30;

            AddLabel(panel, "ส่วนสูง (ซม.)", 16, y); y += 20;
            _txtHeight = AddTextBox(panel, 16, y, 80); y += 30;

            AddLabel(panel, "ความดันโลหิต  (ตัวบน / ตัวล่าง mmHg)", 16, y); y += 20;
            _txtBpSys = AddTextBox(panel, 16, y, 70);
            var lblSlash = new Label { Text = "/", Bounds = new Rectangle(92, y + 3, 16, 20), Font = new Font("Tahoma", 11f) };
            panel.Controls.Add(lblSlash);
            _txtBpDia = AddTextBox(panel, 110, y, 70); y += 30;

            AddLabel(panel, "หมู่เลือด", 16, y); y += 20;
            _cboBloodType = new ComboBox
            {
                Bounds = new Rectangle(16, y, 80, 24),
                DropDownStyle = ComboBoxStyle.DropDownList
            };
            _cboBloodType.Items.AddRange(new object[] { "-", "A", "B", "AB", "O" });
            _cboBloodType.SelectedIndex = 0;
            panel.Controls.Add(_cboBloodType);

            _cboBloodRh = new ComboBox
            {
                Bounds = new Rectangle(104, y, 60, 24),
                DropDownStyle = ComboBoxStyle.DropDownList
            };
            _cboBloodRh.Items.AddRange(new object[] { "-", "+", "−" });
            _cboBloodRh.SelectedIndex = 0;
            panel.Controls.Add(_cboBloodRh);
            return panel;
        }

        private Panel BuildConditionsPanel(int fieldWidth)
        {
            var panel = CreateSectionPanel(430, 215);
            int y = AddSectionHeader(panel, "โรคประจำตัว (Past Medical History)", 0);

            _chkDiabetes = AddCheckBox(panel, "เบาหวาน", 16, y);
            _chkHypertension = AddCheckBox(panel, "ความดันโลหิตสูง", 160, y); y += 26;
            _chkHyperlipidemia = AddCheckBox(panel, "ไขมันในเลือดสูง", 16, y);
            _chkHeartDisease = AddCheckBox(panel, "โรคหัวใจ", 160, y); y += 26;
            _chkKidneyDisease = AddCheckBox(panel, "โรคไต", 16, y);
            _chkLiverDisease = AddCheckBox(panel, "โรคตับ", 160, y); y += 26;
            _chkThyroid = AddCheckBox(panel, "ไทรอยด์", 16, y); y += 30;

            AddLabel(panel, "อื่นๆ (ระบุ)", 16, y); y += 20;
            _txtOtherConditions = AddTextBox(panel, 16, y, fieldWidth, 50, multiline: true);
            return panel;
        }

        private Panel BuildAllergyPanel(int fieldWidth)
        {
            var panel = CreateSectionPanel(430, 194);
            int y = AddSectionHeader(panel, "ประวัติแพ้ยาและอาหาร (Allergy History)", 0);

            AddLabel(panel, "ยาที่แพ้ (ชื่อยา / รหัสสินค้า)", 16, y); y += 20;
            _txtDrugAllergies = AddTextBox(panel, 16, y, fieldWidth, 60, multiline: true); y += 70;

            AddLabel(panel, "อาหารที่แพ้", 16, y); y += 20;
            _txtFoodAllergies = AddTextBox(panel, 16, y, fieldWidth, 50, multiline: true);
            return panel;
        }

        private Panel BuildCurrentMedsPanel(int fieldWidth)
        {
            var panel = CreateSectionPanel(430, 145);
            int y = AddSectionHeader(panel, "ประวัติการใช้ยาปัจจุบัน (Medication History)", 0);

            AddLabel(panel, "รายการยา (ชื่อยา / ขนาด / ความถี่)", 16, y); y += 20;
            _txtCurrentMeds = AddTextBox(panel, 16, y, fieldWidth, 70, multiline: true);
            return panel;
        }

        private Panel BuildMedicalHistoryPanel(int fieldWidth)
        {
            var panel = CreateSectionPanel(430, 122);
            int y = AddSectionHeader(panel, "ประวัติการเจ็บป่วย (Medical History)", 0);
            _txtMedHistory = AddTextBox(panel, 16, y, fieldWidth, 70, multiline: true);
            return panel;
        }

        private Panel BuildScreeningPanel(int fieldWidth)
        {
            var panel = CreateSectionPanel(430, 92);
            int y = AddSectionHeader(panel, "ข้อมูลการคัดกรอง (Screening)", 0);

            _chkSmoking = AddCheckBox(panel, "สูบบุหรี่", 16, y);
            _chkAlcohol = AddCheckBox(panel, "ดื่มแอลกอฮอล์", 160, y); y += 28;
            _chkPregnant = AddCheckBox(panel, "ตั้งครรภ์", 16, y);
            _chkBreastfeeding = AddCheckBox(panel, "ให้นมบุตร", 160, y);
            return panel;
        }

        private Panel CreateSectionPanel(int width, int height)
        {
            return new Panel
            {
                Width = width,
                Height = height,
                BackColor = Color.White,
                Margin = new Padding(0, 0, 0, 10)
            };
        }

        private Panel CreateSectionHeaderPanel(string text, bool fullWidth = false, Color? textColor = null)
        {
            var bg = new Panel
            {
                Bounds = new Rectangle(0, 0, fullWidth ? 430 : 450, 26),
                BackColor = Color.FromArgb(235, 242, 252)
            };
            var lbl = new Label
            {
                Text = text,
                AutoSize = false,
                Bounds = new Rectangle(12, 4, 360, 18),
                Font = new Font("Tahoma", 9f, FontStyle.Bold),
                ForeColor = textColor ?? Color.FromArgb(18, 92, 191)
            };
            bg.Controls.Add(lbl);
            return bg;
        }

        private int AddSectionHeader(Panel parent, string text, int y)
        {
            var bg = CreateSectionHeaderPanel(text);
            bg.Location = new Point(0, y);
            parent.Controls.Add(bg);
            return y + 34;
        }

        private void AddLabel(Control parent, string text, int x, int y)
        {
            parent.Controls.Add(new Label
            {
                Text     = text,
                Bounds   = new Rectangle(x, y, 350, 18),
                ForeColor = Color.FromArgb(60, 60, 60)
            });
        }

        private TextBox AddTextBox(Control parent, int x, int y, int w, int h = 24, bool multiline = false)
        {
            var tb = new TextBox
            {
                Bounds      = new Rectangle(x, y, w, h),
                Multiline   = multiline,
                ScrollBars  = multiline ? ScrollBars.Vertical : ScrollBars.None,
                BorderStyle = BorderStyle.FixedSingle
            };
            parent.Controls.Add(tb);
            return tb;
        }

        private CheckBox AddCheckBox(Control parent, string text, int x, int y)
        {
            var cb = new CheckBox
            {
                Text   = text,
                Bounds = new Rectangle(x, y, 140, 22)
            };
            parent.Controls.Add(cb);
            return cb;
        }

        private void TogglePidSection()
        {
            SetPidExpanded(!_isPidExpanded);
        }

        private void SetPidExpanded(bool expanded)
        {
            _isPidExpanded = expanded;
            _pnlPidContent.Visible = expanded;
            _pnlPidSection.Height = expanded ? 190 : 34;
            _lblPidToggle.Text = expanded ? "−" : "+";
        }

        private bool TryBuildPidFields(out string documentType, out string rawValue, out string normalizedValue)
        {
            documentType = "";
            rawValue = "";
            normalizedValue = "";
            _lblStatus.Text = "";

            if (!_isPidExpanded)
                return true;

            documentType = GetSelectedPidDocumentType();
            rawValue = _txtPidDocumentNumber.Text;
            normalizedValue = rawValue == null ? "" : rawValue.Trim();

            if (string.IsNullOrWhiteSpace(documentType))
            {
                SetStatus("กรุณาเลือกประเภทเอกสาร PID", true);
                return false;
            }

            if (string.IsNullOrWhiteSpace(normalizedValue))
            {
                SetStatus("กรุณากรอกรหัส PID / เลขเอกสารประจำตัว", true);
                return false;
            }

            if (documentType == "สัญชาติไทย")
            {
                if (!Regex.IsMatch(normalizedValue, @"^\d{13}$") || !IsValidThaiNationalId(normalizedValue))
                {
                    SetStatus("เลขบัตรประชาชนต้องเป็น 13 หลักและตรวจสอบไม่ผ่าน", true);
                    return false;
                }
            }
            else if (documentType == "ไม่มีสัญชาติไทย")
            {
                if (!Regex.IsMatch(normalizedValue, @"^\d{13}$"))
                {
                    SetStatus("เอกสารสำหรับผู้ไม่มีสัญชาติไทยต้องเป็นตัวเลข 13 หลัก", true);
                    return false;
                }
            }
            else if (documentType == "พาสปอร์ต")
            {
                normalizedValue = normalizedValue.ToUpperInvariant();
                if (!Regex.IsMatch(normalizedValue, @"^[A-Z0-9]+$"))
                {
                    SetStatus("พาสปอร์ตต้องเป็นตัวอักษรอังกฤษพิมพ์ใหญ่และตัวเลขเท่านั้น", true);
                    return false;
                }
            }

            return true;
        }

        private void SetStatus(string text, bool isError)
        {
            _lblStatus.ForeColor = isError ? Color.FromArgb(160, 0, 0) : Color.FromArgb(120, 120, 120);
            _lblStatus.Text = text;
        }

        private string GetSelectedPidDocumentType()
        {
            if (_rdPidThai.Checked) return _rdPidThai.Text;
            if (_rdPidNoNationality.Checked) return _rdPidNoNationality.Text;
            if (_rdPidPassport.Checked) return _rdPidPassport.Text;
            if (_rdPidOther.Checked) return _rdPidOther.Text;
            return "";
        }

        private static bool IsValidThaiNationalId(string value)
        {
            if (string.IsNullOrWhiteSpace(value) || value.Length != 13)
                return false;

            int sum = 0;
            for (int i = 0; i < 12; i++)
                sum += (value[i] - '0') * (13 - i);

            int checkDigit = (11 - (sum % 11)) % 10;
            return checkDigit == (value[12] - '0');
        }
    }
}
