using System;
using System.Drawing;
using System.Globalization;
using System.Threading.Tasks;
using System.Windows.Forms;
using SCCRMonPOS.Models;

namespace SCCRMonPOS
{
    public partial class MemberClaimForm : Form
    {
        private readonly ApiClient _api;
        private readonly AdaPosWatcher _watcher;
        private readonly int _bahtPerPoint;
        private readonly string _staffCode;

        private PosReceipt _receipt;
        private MemberSearchResult _selectedMember;
        private MemberDetail _selectedMemberDetail;

        // For Visual Studio Designer only — do not call at runtime
        public MemberClaimForm() { InitializeComponent(); }

        public MemberClaimForm(
            ApiClient api,
            AdaPosWatcher watcher,
            int bahtPerPoint,
            string staffCode,
            PosReceipt prefilledReceipt = null)
        {
            _api          = api;
            _watcher      = watcher;
            _bahtPerPoint = bahtPerPoint > 0 ? bahtPerPoint : 10;
            _staffCode    = staffCode ?? "";

            InitializeComponent();
            WireEvents();
            BuildExtraMenu();
            RefreshEmptyStates();

            if (prefilledReceipt != null)
                LoadReceipt(prefilledReceipt);
        }

        private void WireEvents()
        {
            // VS Designer strips ListView column definitions on save — kept here
            if (_lvItems.Columns.Count == 0)
            {
                _lvItems.Columns.Add("รายการ", 100); // width is set dynamically below
                _lvItems.Columns.Add("จำนวน",  52,  HorizontalAlignment.Center);
                _lvItems.Columns.Add("ยอดรวม", 98,  HorizontalAlignment.Right);
            }
            _lvItems.SizeChanged += (s, e) => FitItemsColumn();
            FitItemsColumn();
            _txtReceiptNo.KeyDown    += delegate (object sender, KeyEventArgs e) { if (e.KeyCode == Keys.Enter) { e.SuppressKeyPress = true; _ = LoadReceiptAsync(); } };
            _btnLoadReceipt.Click    += async delegate { await LoadReceiptAsync(); };
            _txtMemberSearch.KeyDown += delegate (object sender, KeyEventArgs e) { if (e.KeyCode == Keys.Enter) { e.SuppressKeyPress = true; _ = SearchMembersAsync(); } };
            _btnSearch.Click         += async delegate { await SearchMembersAsync(); };
            _btnNewMember.Click      += OnNewMemberClick;
            _btnEditMember.Click     += OnEditMemberClick;
            _btnCancel.Click         += delegate { Close(); };
            _btnConfirm.Click        += async delegate { await ConfirmClaimAsync(); };
            _dgvResults.CellDoubleClick  += OnGridDoubleClick;
            _dgvResults.KeyDown          += OnGridKeyDown;
            _dgvResults.SelectionChanged += OnGridSelectionChanged;
            _btnTabHistory.Click += OnComingSoonClick;
            _btnTabMembers.Click += OnComingSoonClick;
            _btnTabReports.Click += OnComingSoonClick;
            _btnTabExtra.Click   += OnExtraMenuClick;
        }

        private void _lvItems_SelectedIndexChanged(object sender, System.EventArgs e) { }



        private void _dgvResults_CellContentClick(object sender, DataGridViewCellEventArgs e) { }
        private void MemberClaimForm_Load(object sender, EventArgs e) { }

        private void FitItemsColumn()
        {
            if (_lvItems.Columns.Count > 0)
                _lvItems.Columns[0].Width = _lvItems.ClientSize.Width - 52 - 98;
        }

        private void BuildExtraMenu()
        {
            _extraMenu = new ContextMenuStrip();
            AddComingSoonMenuItem("จัดการสินค้า");
            AddComingSoonMenuItem("จัดการหมวดสินค้า");
            AddComingSoonMenuItem("จัดการโปรโมชั่น");
            AddComingSoonMenuItem("ตั้งค่าระบบ");
            AddComingSoonMenuItem("สำรองข้อมูล");
            AddComingSoonMenuItem("นำเข้าข้อมูล");
            AddComingSoonMenuItem("จัดการพนักงาน");
            AddComingSoonMenuItem("สิทธิ์การใช้งาน");
            AddComingSoonMenuItem("แจ้งเตือน");
            AddComingSoonMenuItem("ประวัติการใช้งาน");
            AddComingSoonMenuItem("ตั้งค่าการพิมพ์");
            AddComingSoonMenuItem("เชื่อมต่ออุปกรณ์");
        }

        private void AddComingSoonMenuItem(string text)
        {
            var item = new ToolStripMenuItem(text + " - Coming soon");
            item.Click += OnComingSoonClick;
            _extraMenu.Items.Add(item);
        }

        private void OnExtraMenuClick(object sender, EventArgs e)
        {
            var source = sender as Control;
            if (source != null)
                _extraMenu.Show(source, new Point(0, source.Height));
        }

        private void OnComingSoonClick(object sender, EventArgs e)
        {
            MessageBox.Show(
                "Coming soon",
                "SCCRM",
                MessageBoxButtons.OK,
                MessageBoxIcon.Information);
        }

        private void LoadReceipt(PosReceipt receipt)
        {
            _receipt = receipt;
            _txtReceiptNo.Text = receipt.DocNo ?? "";
            PopulateItemsList(receipt);
            ShowMemberSummary(_selectedMember);
            UpdateConfirmButton();
        }

        private async Task LoadReceiptAsync()
        {
            string docNo = _txtReceiptNo.Text.Trim();
            if (string.IsNullOrWhiteSpace(docNo))
            {
                SetStatus("กรุณาใส่เลขที่ใบเสร็จ", true);
                return;
            }

            SetStatus("กำลังโหลดข้อมูลบิล...", false, Color.DimGray);
            SetUiBusy(true);

            PosReceipt receipt = null;
            await Task.Run(delegate { receipt = _watcher != null ? _watcher.LoadReceiptByDocNo(docNo) : null; });

            SetUiBusy(false);

            if (receipt == null)
            {
                SetStatus("ไม่พบบิลนี้ กรุณาตรวจสอบเลขที่ใบเสร็จอีกครั้ง", true);
                _receipt = null;
                _lvItems.Items.Clear();
                _lblTotal.Text = "ยอดรวม: -";
                _lblPreviewPoints.Text = "แต้มที่จะได้รับ: -";
                RefreshEmptyStates();
                UpdateConfirmButton();
                return;
            }

            LoadReceipt(receipt);
            SetStatus("", false);
        }

        private void PopulateItemsList(PosReceipt receipt)
        {
            _lvItems.Items.Clear();

            if (receipt != null && receipt.Items != null)
            {
                foreach (PosReceiptItem item in receipt.Items)
                {
                    bool excluded = IsExcludedFromPoints(item.ProductName);
                    var row = new ListViewItem(TruncateName(item.ProductName ?? item.ProductCode ?? "-"));
                    row.SubItems.Add(item.Qty.ToString("0.##", CultureInfo.InvariantCulture));
                    row.SubItems.Add(item.NetAmount.ToString("N2", CultureInfo.InvariantCulture));
                    if (excluded)
                    {
                        row.ForeColor = Color.Firebrick;
                        row.BackColor = Color.FromArgb(255, 235, 235);
                    }
                    _lvItems.Items.Add(row);
                }
            }

            decimal eligibleTotal = CalcEligibleTotal(receipt);
            decimal grandTotal = receipt != null ? receipt.GrandTotal : 0m;
            _lblTotal.Text = grandTotal > 0
                ? "ยอดรวม: " + grandTotal.ToString("N2", CultureInfo.InvariantCulture)
                : "ยอดรวม: -";
            int pts = CalcPoints(eligibleTotal);
            _lblPreviewPoints.Text = pts > 0
                ? "แต้มที่จะได้รับ: " + pts.ToString(CultureInfo.InvariantCulture)
                : "แต้มที่จะได้รับ: -";
            RefreshEmptyStates();
        }

        private async Task SearchMembersAsync()
        {
            string q = _txtMemberSearch.Text.Trim();
            if (string.IsNullOrWhiteSpace(q))
            {
                SetStatus("กรุณากรอกข้อมูลสำหรับค้นหาสมาชิก", true);
                return;
            }

            SetStatus("กำลังค้นหาสมาชิก...", false, Color.DimGray);
            SetUiBusy(true);
            _dgvResults.Rows.Clear();
            ClearMemberSelection();

            MemberSearchResult[] results = null;
            string errorMsg = null;
            try
            {
                results = await _api.SearchMembersAsync(q);
            }
            catch (Exception ex)
            {
                errorMsg = ex.Message;
            }
            finally
            {
                SetUiBusy(false);
            }

            if (errorMsg != null)
            {
                SetStatus("เชื่อมต่อเซิร์ฟเวอร์ไม่สำเร็จ: " + errorMsg, true);
                RefreshEmptyStates();
                UpdateConfirmButton();
                return;
            }

            if (results == null || results.Length == 0)
            {
                SetStatus("ไม่พบข้อมูลสมาชิก", true);
                RefreshEmptyStates();
                UpdateConfirmButton();
                return;
            }

            foreach (MemberSearchResult m in results)
            {
                _dgvResults.Rows.Add(
                    m.Id,
                    m.MemberCode ?? "",
                    m.DisplayName ?? "-",
                    m.Phone ?? "",
                    m.CurrentPoints.ToString(CultureInfo.InvariantCulture));
            }

            SetStatus("", false);
            RefreshEmptyStates();
        }

        private void OnGridDoubleClick(object sender, DataGridViewCellEventArgs e)
        {
            if (e.RowIndex >= 0)
                SelectMemberAtRow(e.RowIndex);
        }

        private void OnGridKeyDown(object sender, KeyEventArgs e)
        {
            if (e.KeyCode == Keys.Enter && _dgvResults.CurrentRow != null)
            {
                e.SuppressKeyPress = true;
                SelectMemberAtRow(_dgvResults.CurrentRow.Index);
            }
        }

        private void OnGridSelectionChanged(object sender, EventArgs e)
        {
            if (_dgvResults.SelectedRows.Count == 1)
                SelectMemberAtRow(_dgvResults.SelectedRows[0].Index);
        }

        private void SelectMemberAtRow(int rowIndex)
        {
            if (rowIndex < 0 || rowIndex >= _dgvResults.Rows.Count)
                return;

            DataGridViewRow row = _dgvResults.Rows[rowIndex];
            int points;

            _selectedMember = new MemberSearchResult
            {
                Id = row.Cells["Id"].Value != null ? row.Cells["Id"].Value.ToString() : "",
                DisplayName = row.Cells["DisplayName"].Value != null ? row.Cells["DisplayName"].Value.ToString() : "",
                Phone = row.Cells["Phone"].Value != null ? row.Cells["Phone"].Value.ToString() : "",
                MemberCode = row.Cells["MemberCode"].Value != null ? row.Cells["MemberCode"].Value.ToString() : "",
                CurrentPoints = int.TryParse(row.Cells["Points"].Value != null ? row.Cells["Points"].Value.ToString() : "0", out points) ? points : 0
            };
            _selectedMemberDetail = null;

            ShowMemberSummary(_selectedMember);
            UpdateConfirmButton();
        }

        private void ClearMemberSelection()
        {
            _selectedMember = null;
            _selectedMemberDetail = null;
            ShowMemberSummary(null);
            UpdateConfirmButton();
        }

        private void ShowMemberSummary(MemberSearchResult member)
        {
            if (member == null)
            {
                _pnlMemberSummary.Visible = false;
                _btnEditMember.Visible = false;
                return;
            }

            int pts = _receipt != null ? CalcPoints(CalcEligibleTotal(_receipt)) : 0;
            _lblMemberName.Text = member.DisplayName + (string.IsNullOrWhiteSpace(member.Phone) ? "" : " | " + member.Phone);
            _lblMemberPoints.Text = "แต้มปัจจุบัน: " + member.CurrentPoints.ToString(CultureInfo.InvariantCulture) +
                                    (pts > 0 ? " -> " + (member.CurrentPoints + pts).ToString(CultureInfo.InvariantCulture) + " หลังสะสม" : "");
            _pnlMemberSummary.Visible = true;
            _btnEditMember.Visible = true;
        }

        private void OnNewMemberClick(object sender, EventArgs e)
        {
            if (_api.IsTokenExpired())
            {
                SetStatus("หมดอายุการเข้าสู่ระบบ", true);
                return;
            }

            var form = new NewMemberForm(_api);
            form.MemberSaved += delegate (MemberSearchResult created)
            {
                _dgvResults.Rows.Clear();
                _dgvResults.Rows.Add(
                    created.Id,
                    created.MemberCode ?? "",
                    created.DisplayName ?? "-",
                    created.Phone ?? "",
                    created.CurrentPoints.ToString(CultureInfo.InvariantCulture));
                SelectMemberAtRow(0);
                _txtMemberSearch.Text = !string.IsNullOrWhiteSpace(created.Phone) ? created.Phone : (created.DisplayName ?? "");
                SetStatus("เพิ่มสมาชิกใหม่สำเร็จ", false, Color.FromArgb(24, 140, 52));
                RefreshEmptyStates();
            };
            form.ShowDialog(this);
        }

        private async void OnEditMemberClick(object sender, EventArgs e)
        {
            if (_selectedMember == null)
                return;

            if (_api.IsTokenExpired())
            {
                SetStatus("หมดอายุการเข้าสู่ระบบ", true);
                return;
            }

            string required = System.Configuration.ConfigurationManager.AppSettings["StaffEditPin"] ?? "123123";
            if (!PromptPin("ใส่รหัสผ่านเพื่อแก้ไขข้อมูล", required))
                return;

            SetStatus("กำลังโหลดข้อมูลสมาชิก…", false, System.Drawing.Color.DimGray);
            SetUiBusy(true);

            MemberDetail detail = null;
            string loadError = null;
            try
            {
                detail = await _api.GetMemberAsync(_selectedMember.Id);
                detail = MergeMemberDetail(detail, _selectedMember);
                _selectedMemberDetail = detail;
            }
            catch (Exception ex)
            {
                loadError = ex.Message;
                if (_selectedMemberDetail != null &&
                    string.Equals(_selectedMemberDetail.Id, _selectedMember.Id, StringComparison.Ordinal))
                {
                    detail = MergeMemberDetail(_selectedMemberDetail, _selectedMember);
                }
            }
            finally
            {
                SetUiBusy(false);
            }

            if (detail == null)
            {
                SetStatus("โหลดข้อมูลสมาชิกไม่สำเร็จ: " + (loadError ?? "ไม่ทราบสาเหตุ"), true);
                return;
            }

            SetStatus("", false);

            var form = new NewMemberForm(_api, detail);
            form.MemberSaved += delegate (MemberSearchResult updated)
            {
                _selectedMember = updated;
                _selectedMemberDetail = form.SavedDetail != null
                    ? MergeMemberDetail(form.SavedDetail, updated)
                    : MergeMemberDetail(_selectedMemberDetail, updated);
                ShowMemberSummary(updated);

                foreach (DataGridViewRow row in _dgvResults.Rows)
                {
                    if ((row.Cells["Id"].Value != null ? row.Cells["Id"].Value.ToString() : "") == updated.Id)
                    {
                        row.Cells["MemberCode"].Value = updated.MemberCode;
                        row.Cells["DisplayName"].Value = updated.DisplayName;
                        row.Cells["Phone"].Value = updated.Phone;
                        row.Cells["Points"].Value = updated.CurrentPoints.ToString(CultureInfo.InvariantCulture);
                        break;
                    }
                }

                SetStatus("แก้ไขข้อมูลสมาชิกสำเร็จ", false, Color.FromArgb(24, 140, 52));
                RefreshEmptyStates();
            };
            form.ShowDialog(this);
        }

        private static bool PromptPin(string prompt, string requiredPin)
        {
            DialogResult result = DialogResult.None;

            var dlg = new Form
            {
                Text = "SCCRM - ยืนยันตัวตน",
                ClientSize = new Size(320, 138),
                FormBorderStyle = FormBorderStyle.FixedDialog,
                MaximizeBox = false,
                MinimizeBox = false,
                TopMost = true,
                StartPosition = FormStartPosition.CenterParent,
                ShowInTaskbar = false,
                BackColor = Color.White
            };

            var lbl = new Label
            {
                Text = prompt,
                Bounds = new Rectangle(16, 16, 286, 20)
            };
            var txt = new TextBox
            {
                Bounds = new Rectangle(16, 44, 286, 24),
                UseSystemPasswordChar = true,
                MaxLength = 20
            };
            var btnOk = new Button
            {
                Text = "ยืนยัน",
                Bounds = new Rectangle(136, 86, 76, 28),
                DialogResult = DialogResult.OK
            };
            var btnCancel = new Button
            {
                Text = "ยกเลิก",
                Bounds = new Rectangle(226, 86, 76, 28),
                DialogResult = DialogResult.Cancel
            };

            dlg.AcceptButton = btnOk;
            dlg.CancelButton = btnCancel;
            dlg.Controls.AddRange(new Control[] { lbl, txt, btnOk, btnCancel });

            result = dlg.ShowDialog();
            bool ok = result == DialogResult.OK && txt.Text == requiredPin;
            dlg.Dispose();

            if (!ok && result == DialogResult.OK)
            {
                MessageBox.Show(
                    "รหัสผ่านไม่ถูกต้อง",
                    "SCCRM",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Warning);
            }

            return ok;
        }

        private async Task ConfirmClaimAsync()
        {
            if (_receipt == null || _selectedMember == null)
                return;

            SetStatus("กำลังบันทึกการสะสมแต้ม...", false, Color.DimGray);
            SetUiBusy(true);

            LoyaltyClaimResponse response = null;
            string errorMsg = null;
            try
            {
                response = await _api.SubmitLoyaltyClaimAsync(BuildClaimRequest());
            }
            catch (ApiException ex)
            {
                errorMsg = MapApiError(ex.Message);
            }
            catch (Exception ex)
            {
                errorMsg = "เชื่อมต่อเซิร์ฟเวอร์ไม่สำเร็จ: " + ex.Message;
            }
            finally
            {
                SetUiBusy(false);
            }

            if (errorMsg != null)
            {
                SetStatus(errorMsg, true);
                return;
            }

            ShowSuccess(response);
        }

        private LoyaltyClaimRequest BuildClaimRequest()
        {
            LoyaltyClaimItem[] items = new LoyaltyClaimItem[_receipt.Items != null ? _receipt.Items.Count : 0];
            if (_receipt.Items != null)
            {
                for (int i = 0; i < _receipt.Items.Count; i++)
                {
                    PosReceiptItem src = _receipt.Items[i];
                    items[i] = new LoyaltyClaimItem
                    {
                        ProductCode = src.ProductCode ?? "",
                        ProductName = src.ProductName ?? "",
                        Qty = src.Qty,
                        UnitPrice = src.UnitPrice,
                        LineTotal = src.NetAmount
                    };
                }
            }

            decimal eligibleTotal = CalcEligibleTotal(_receipt);

            return new LoyaltyClaimRequest
            {
                ReceiptNo = _receipt.DocNo,
                BranchCode = _receipt.BranchCode,
                CashierStaffCode = _staffCode,
                SoldAt = FormatSoldAt(_receipt),
                TotalAmount = eligibleTotal,
                PreviewPoints = CalcPoints(eligibleTotal),
                MemberId = _selectedMember.Id,
                Items = items
            };
        }

        private void ShowSuccess(LoyaltyClaimResponse response)
        {
            _lblStatus.ForeColor = Color.FromArgb(24, 140, 52);
            _lblStatus.Text = "สะสมแต้มสำเร็จ ได้รับ " + response.AwardedPoints.ToString(CultureInfo.InvariantCulture) +
                              " แต้ม | ยอดรวม " + response.NewPointsBalance.ToString(CultureInfo.InvariantCulture) + " แต้ม";
            _btnConfirm.Enabled = false;
            _btnCancel.Text = "ปิด";

            var timer = new Timer { Interval = 5000 };
            timer.Tick += delegate
            {
                timer.Stop();
                timer.Dispose();
                if (!IsDisposed)
                    Close();
            };
            timer.Start();
        }

        private void SetUiBusy(bool busy)
        {
            _btnLoadReceipt.Enabled = !busy;
            _btnSearch.Enabled = !busy;
            _btnNewMember.Enabled = !busy;
            _btnEditMember.Enabled = !busy;
            _btnConfirm.Enabled = !busy && CanConfirm();
            Cursor = busy ? Cursors.WaitCursor : Cursors.Default;
        }

        private void UpdateConfirmButton()
        {
            _btnConfirm.Enabled = CanConfirm();
        }

        private bool CanConfirm()
        {
            return _receipt != null && CalcEligibleTotal(_receipt) > 0m && _selectedMember != null;
        }

        private void RefreshEmptyStates()
        {
            _lblItemsEmpty.Visible = _lvItems.Items.Count == 0;
            _lblMembersEmpty.Visible = _dgvResults.Rows.Count == 0;
        }

        private void SetStatus(string text, bool isError, Color? color = null)
        {
            _lblStatus.ForeColor = color ?? (isError ? Color.FromArgb(180, 38, 38) : Color.FromArgb(70, 70, 70));
            _lblStatus.Text = text;
        }

        private static MemberDetail MergeMemberDetail(MemberDetail detail, MemberSearchResult summary)
        {
            if (detail == null && summary == null)
                return null;

            return new MemberDetail
            {
                Id            = !string.IsNullOrWhiteSpace(detail?.Id) ? detail.Id : summary?.Id,
                DisplayName   = !string.IsNullOrWhiteSpace(detail?.DisplayName) ? detail.DisplayName : summary?.DisplayName,
                FirstName     = detail?.FirstName,
                LastName      = detail?.LastName,
                Phone         = !string.IsNullOrWhiteSpace(detail?.Phone) ? detail.Phone : summary?.Phone,
                Email         = !string.IsNullOrWhiteSpace(detail?.Email) ? detail.Email : summary?.Email,
                MemberCode    = !string.IsNullOrWhiteSpace(detail?.MemberCode) ? detail.MemberCode : summary?.MemberCode,
                CurrentPoints = detail != null && detail.CurrentPoints > 0 ? detail.CurrentPoints : (summary != null ? summary.CurrentPoints : 0),
                Sex           = detail?.Sex,
                Dob           = detail?.Dob,
                Remark        = detail?.Remark,
                ThaiId        = detail?.ThaiId,
                PharmacyMedRecord = detail?.PharmacyMedRecord
            };
        }

        private int CalcPoints(decimal amount)
        {
            return (int)Math.Floor(amount / _bahtPerPoint);
        }

        private static bool IsExcludedFromPoints(string productName)
        {
            return (productName ?? "").StartsWith("เภสัช", StringComparison.Ordinal);
        }

        private static decimal CalcEligibleTotal(PosReceipt receipt)
        {
            if (receipt == null || receipt.Items == null)
                return 0m;

            decimal total = 0m;
            foreach (PosReceiptItem item in receipt.Items)
            {
                if (!IsExcludedFromPoints(item.ProductName))
                    total += item.NetAmount;
            }
            return total;
        }

        private static string TruncateName(string text)
        {
            if (string.IsNullOrEmpty(text))
                return "";
            return text.Length > 38 ? text.Substring(0, 35) + "..." : text;
        }

        private static string FormatSoldAt(PosReceipt receipt)
        {
            try
            {
                DateTime local = receipt.DocDate;
                TimeSpan time;

                if (TimeSpan.TryParse(receipt.DocTime ?? "", out time))
                    local = local.Date.Add(time);
                else if (TimeSpan.TryParse(receipt.InsertTime ?? "", out time))
                    local = receipt.InsertDate.Date.Add(time);

                local = DateTime.SpecifyKind(local, DateTimeKind.Unspecified);
                return new DateTimeOffset(local, TimeZoneInfo.Local.GetUtcOffset(local))
                    .ToString("yyyy-MM-ddTHH:mm:sszzz", CultureInfo.InvariantCulture);
            }
            catch
            {
                return DateTime.Now.ToString("yyyy-MM-ddTHH:mm:sszzz");
            }
        }

        private static string MapApiError(string raw)
        {
            if (raw == null)
                return "เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุ";
            if (raw.IndexOf("already claimed", StringComparison.OrdinalIgnoreCase) >= 0 ||
                raw.IndexOf("already_claimed", StringComparison.OrdinalIgnoreCase) >= 0 ||
                raw.IndexOf("duplicate", StringComparison.OrdinalIgnoreCase) >= 0 ||
                raw.IndexOf("HTTP 409", StringComparison.OrdinalIgnoreCase) >= 0)
                return "บิลนี้ถูกสะสมแต้มไปแล้ว";
            if (raw.IndexOf("not found", StringComparison.OrdinalIgnoreCase) >= 0)
                return "ไม่พบข้อมูลที่ใช้สำหรับสะสมแต้ม";
            return raw;
        }
    }
}
