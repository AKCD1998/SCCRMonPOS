using System;
using System.Drawing;
using System.Windows.Forms;
using SCCRMonPOS.Models;

namespace SCCRMonPOS
{
    public class PharmacyMedRecordForm : Form
    {
        public event Action<PharmacyMedRecord> RecordSaved;

        private readonly string _memberId;
        private readonly PharmacyMedRecord _existing;

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

            // ── Scrollable content ────────────────────────────────────────
            var scroll = new Panel
            {
                Location   = new Point(0, 0),
                Size       = new Size(450, 608),
                AutoScroll = true,
                BackColor  = Color.White
            };

            int y = 10;

            // ── Section 5: สุขภาพพื้นฐาน ──────────────────────────────────
            y = AddSectionHeader(scroll, "5 — ข้อมูลสุขภาพพื้นฐาน", y);

            AddLabel(scroll, "น้ำหนัก (กก.)", 16, y); y += 20;
            _txtWeight = AddTextBox(scroll, 16, y, 80); y += 30;

            AddLabel(scroll, "ส่วนสูง (ซม.)", 16, y); y += 20;
            _txtHeight = AddTextBox(scroll, 16, y, 80); y += 30;

            AddLabel(scroll, "ความดันโลหิต  (ตัวบน / ตัวล่าง mmHg)", 16, y); y += 20;
            _txtBpSys = AddTextBox(scroll, 16, y, 70);
            var lblSlash = new Label { Text = "/", Bounds = new Rectangle(92, y + 3, 16, 20), Font = new Font("Tahoma", 11f) };
            scroll.Controls.Add(lblSlash);
            _txtBpDia = AddTextBox(scroll, 110, y, 70); y += 30;

            AddLabel(scroll, "หมู่เลือด", 16, y); y += 20;
            _cboBloodType = new ComboBox
            {
                Bounds        = new Rectangle(16, y, 80, 24),
                DropDownStyle = ComboBoxStyle.DropDownList
            };
            _cboBloodType.Items.AddRange(new object[] { "-", "A", "B", "AB", "O" });
            _cboBloodType.SelectedIndex = 0;
            scroll.Controls.Add(_cboBloodType);

            _cboBloodRh = new ComboBox
            {
                Bounds        = new Rectangle(104, y, 60, 24),
                DropDownStyle = ComboBoxStyle.DropDownList
            };
            _cboBloodRh.Items.AddRange(new object[] { "-", "+", "−" });
            _cboBloodRh.SelectedIndex = 0;
            scroll.Controls.Add(_cboBloodRh);
            y += 36;

            // ── Section 7: โรคประจำตัว ────────────────────────────────────
            y = AddSectionHeader(scroll, "7 — โรคประจำตัว (Past Medical History)", y);

            _chkDiabetes       = AddCheckBox(scroll, "เบาหวาน",          16,      y);
            _chkHypertension   = AddCheckBox(scroll, "ความดันโลหิตสูง",   160,     y); y += 26;
            _chkHyperlipidemia = AddCheckBox(scroll, "ไขมันในเลือดสูง",   16,      y);
            _chkHeartDisease   = AddCheckBox(scroll, "โรคหัวใจ",          160,     y); y += 26;
            _chkKidneyDisease  = AddCheckBox(scroll, "โรคไต",             16,      y);
            _chkLiverDisease   = AddCheckBox(scroll, "โรคตับ",            160,     y); y += 26;
            _chkThyroid        = AddCheckBox(scroll, "ไทรอยด์",           16,      y); y += 30;

            AddLabel(scroll, "อื่นๆ (ระบุ)", 16, y); y += 20;
            _txtOtherConditions = AddTextBox(scroll, 16, y, fw, 50, multiline: true); y += 60;

            // ── Section 8: แพ้ยา/อาหาร ───────────────────────────────────
            y = AddSectionHeader(scroll, "8 — ประวัติแพ้ยาและอาหาร (Allergy History)", y);

            AddLabel(scroll, "ยาที่แพ้ (ชื่อยา / รหัสสินค้า)", 16, y); y += 20;
            _txtDrugAllergies = AddTextBox(scroll, 16, y, fw, 60, multiline: true); y += 70;

            AddLabel(scroll, "อาหารที่แพ้", 16, y); y += 20;
            _txtFoodAllergies = AddTextBox(scroll, 16, y, fw, 50, multiline: true); y += 60;

            // ── Section 9: ยาที่ใช้ปัจจุบัน ──────────────────────────────
            y = AddSectionHeader(scroll, "9 — ประวัติการใช้ยาปัจจุบัน (Medication History)", y);

            AddLabel(scroll, "รายการยา (ชื่อยา / ขนาด / ความถี่)", 16, y); y += 20;
            _txtCurrentMeds = AddTextBox(scroll, 16, y, fw, 70, multiline: true); y += 80;

            // ── Section 10: ประวัติการเจ็บป่วย ───────────────────────────
            y = AddSectionHeader(scroll, "10 — ประวัติการเจ็บป่วย (Medical History)", y);

            _txtMedHistory = AddTextBox(scroll, 16, y, fw, 70, multiline: true); y += 80;

            // ── Section 12: การคัดกรอง ────────────────────────────────────
            y = AddSectionHeader(scroll, "12 — ข้อมูลการคัดกรอง (Screening)", y);

            _chkSmoking       = AddCheckBox(scroll, "สูบบุหรี่",    16,  y);
            _chkAlcohol       = AddCheckBox(scroll, "ดื่มแอลกอฮอล์", 160, y); y += 28;
            _chkPregnant      = AddCheckBox(scroll, "ตั้งครรภ์",    16,  y);
            _chkBreastfeeding = AddCheckBox(scroll, "ให้นมบุตร",    160, y); y += 28;

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
            var rec = new PharmacyMedRecord
            {
                MemberId   = _memberId,
                WeightKg   = _txtWeight.Text.Trim(),
                HeightCm   = _txtHeight.Text.Trim(),
                BpSystolic = _txtBpSys.Text.Trim(),
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

        private int AddSectionHeader(Panel parent, string text, int y)
        {
            var bg = new Panel
            {
                Bounds    = new Rectangle(0, y, 450, 26),
                BackColor = Color.FromArgb(235, 242, 252)
            };
            var lbl = new Label
            {
                Text      = text,
                AutoSize  = false,
                Bounds    = new Rectangle(12, 4, 420, 18),
                Font      = new Font("Tahoma", 9f, FontStyle.Bold),
                ForeColor = Color.FromArgb(18, 92, 191)
            };
            bg.Controls.Add(lbl);
            parent.Controls.Add(bg);
            return y + 34;
        }

        private void AddLabel(Panel parent, string text, int x, int y)
        {
            parent.Controls.Add(new Label
            {
                Text     = text,
                Bounds   = new Rectangle(x, y, 350, 18),
                ForeColor = Color.FromArgb(60, 60, 60)
            });
        }

        private TextBox AddTextBox(Panel parent, int x, int y, int w, int h = 24, bool multiline = false)
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

        private CheckBox AddCheckBox(Panel parent, string text, int x, int y)
        {
            var cb = new CheckBox
            {
                Text   = text,
                Bounds = new Rectangle(x, y, 140, 22)
            };
            parent.Controls.Add(cb);
            return cb;
        }
    }
}
