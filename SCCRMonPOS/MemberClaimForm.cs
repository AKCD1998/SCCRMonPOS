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
        private readonly CustomerDisplayController _customerDisplay;
        private readonly bool _ownsCustomerDisplay;
        private LinkLabel _updateNotice;
        private int? _centralQuotePoints;
        private bool _quoteLoading;
        private bool _uiBusy;
        private bool _claimCompleted;
        private ReceiptClaimStatus _receiptClaimStatus;
        private bool _receiptStatusVerified, _receiptStatusChecking, _receiptStatusError;
        private int _receiptStatusGeneration;
        private Task _receiptStatusCheckTask;
        private Label _receiptStatusLabel;
        private ToolTip _receiptStatusTip;
        private Timer _promotionTimer;
        internal Func<bool> IsParkedForSales;

        public void ShowUpdateNotice(string version, Action openUpdates)
        {
            if (_updateNotice != null) { Controls.Remove(_updateNotice); _updateNotice.Dispose(); _updateNotice = null; }
            if (string.IsNullOrWhiteSpace(version)) return;
            _updateNotice = new LinkLabel {
                Text = "มีอัปเดต " + version + " — กดดูรายละเอียดเมื่อสะดวก",
                Bounds = new Rectangle(16, ClientSize.Height - 30, ClientSize.Width - 32, 22),
                Anchor = AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Bottom
            };
            _updateNotice.LinkClicked += (s, e) => { Close(); openUpdates(); };
            Controls.Add(_updateNotice);
        }

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
            PosReceipt prefilledReceipt = null,
            CustomerDisplayController customerDisplay = null)
        {
            _api          = api;
            _watcher      = watcher;
            _bahtPerPoint = bahtPerPoint > 0 ? bahtPerPoint : 10;
            _staffCode    = staffCode ?? "";
            _ownsCustomerDisplay = customerDisplay == null;
            _customerDisplay = customerDisplay ?? new CustomerDisplayController(System.IO.Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "data"));

            InitializeComponent();
            AddReceiptStatusLabel();
            Text += " — " + (_watcher?.TerminalDescription ?? "ยังไม่กำหนดเครื่องขาย");
            WireEvents();
            BuildExtraMenu();
            RefreshEmptyStates();
            FormClosed += (s, e) => { ++_receiptStatusGeneration; _receiptStatusTip?.Dispose(); if (_promotionTimer != null) _promotionTimer.Dispose(); if (_ownsCustomerDisplay) _customerDisplay.Dispose(); };
            _promotionTimer = new Timer { Interval = 30000 };
            _promotionTimer.Tick += async (s, e) => {
                await RefreshCentralQuoteAsync();
                if (!_uiBusy && !_claimCompleted && _receiptClaimStatus?.Claimed != true) await RefreshReceiptClaimStatusAsync();
            };
            _promotionTimer.Start();

            if (prefilledReceipt != null)
                LoadReceipt(prefilledReceipt);
        }

        private void AddReceiptStatusLabel()
        {
            int scale = Math.Max(96, DeviceDpi);
            int height = 20 * scale / 96, margin = 2 * scale / 96;
            _receiptStatusLabel = new Label {
                Name = "ReceiptClaimStatus", AutoEllipsis = true, TextAlign = ContentAlignment.MiddleLeft,
                Padding = new Padding(4, 0, 4, 0), Visible = false,
                Bounds = new Rectangle(_pnlDivider.Left, _pnlDivider.Top - height - margin, _pnlDivider.Width, height),
                Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right
            };
            _receiptStatusTip = new ToolTip();
            Controls.Add(_receiptStatusLabel);
            _receiptStatusLabel.BringToFront();
        }

        private void InvalidateReceiptClaimStatus()
        {
            ++_receiptStatusGeneration;
            _receiptStatusCheckTask = null;
            _receiptClaimStatus = null;
            _receiptStatusVerified = _receiptStatusChecking = _receiptStatusError = false;
            _claimCompleted = false;
        }

        private Task RefreshReceiptClaimStatusAsync()
        {
            if (_receipt == null || IsDisposed) return Task.CompletedTask;
            if (_receiptStatusCheckTask != null && !_receiptStatusCheckTask.IsCompleted) return _receiptStatusCheckTask;
            var receipt = _receipt;
            int generation = ++_receiptStatusGeneration;
            _receiptStatusVerified = false; _receiptStatusChecking = true; _receiptStatusError = false;
            RenderReceiptClaimStatus();
            return _receiptStatusCheckTask = CheckReceiptClaimStatusAsync(receipt, generation);
        }

        private async Task CheckReceiptClaimStatusAsync(PosReceipt receipt, int generation)
        {
            try {
                var status = await _api.GetReceiptClaimStatusAsync(receipt.BranchCode, receipt.DocNo);
                if (IsDisposed || generation != _receiptStatusGeneration || !ReferenceEquals(receipt, _receipt)) return;
                _receiptClaimStatus = status; _receiptStatusVerified = true;
            }
            catch {
                if (IsDisposed || generation != _receiptStatusGeneration || !ReferenceEquals(receipt, _receipt)) return;
                _receiptClaimStatus = null; _receiptStatusError = true;
            }
            finally {
                if (!IsDisposed && generation == _receiptStatusGeneration && ReferenceEquals(receipt, _receipt)) {
                    _receiptStatusChecking = false; RenderReceiptClaimStatus();
                }
            }
        }

        private void RenderReceiptClaimStatus()
        {
            if (_receiptStatusLabel == null || IsDisposed) return;
            bool claimed = _receiptClaimStatus?.Claimed == true;
            _receiptStatusLabel.Visible = _receipt != null;
            _receiptStatusLabel.Text = _receiptStatusChecking ? "กำลังตรวจสอบสถานะบิล…" :
                _receiptStatusError ? "ตรวจสถานะบิลไม่ได้ — กดโหลดบิลเพื่อลองใหม่" :
                claimed ? "บันทึกแล้ว · สมาชิก: " + (string.IsNullOrWhiteSpace(_receiptClaimStatus.MemberName) ? "ไม่ได้ระบุชื่อ" : _receiptClaimStatus.MemberName) +
                    (string.IsNullOrWhiteSpace(_receiptClaimStatus.MemberCode) ? "" : " (" + _receiptClaimStatus.MemberCode + ")") :
                _receiptStatusVerified ? "ยังไม่ได้บันทึกให้สมาชิก" : "กำลังตรวจสอบสถานะบิล…";
            _receiptStatusLabel.ForeColor = _receiptStatusError ? Color.Firebrick : claimed ? Color.FromArgb(24, 110, 52) : Color.FromArgb(18, 74, 132);
            _receiptStatusLabel.BackColor = _receiptStatusError ? Color.FromArgb(255, 235, 235) : claimed ? Color.FromArgb(233, 247, 237) : Color.FromArgb(243, 248, 255);
            _receiptStatusTip.SetToolTip(_receiptStatusLabel, _receiptStatusLabel.Text);
            _btnConfirm.Text = claimed ? "บันทึกแล้ว" : "ยืนยันบิล / สะสมแต้ม";
            UpdateConfirmButton();
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
            _btnTabHistory.Click += OnHistoryClick;
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
            _extraMenu.Items.Add("โปรโมชั่นสะสมแต้มส่วนกลาง", null, (s, e) => CentralPromotions.OpenPortal(_receipt?.BranchCode));
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

        private void OnHistoryClick(object sender, EventArgs e)
        {
            // Opens directly; if a member is already selected we pre-load their history,
            // otherwise the form's own search box is used to find one.
            string memberId   = _selectedMember != null ? _selectedMember.Id : null;
            string memberName = _selectedMember != null ? _selectedMember.DisplayName : null;

            using (var form = new PurchaseHistoryForm(_api, memberId, memberName))
            {
                form.ShowDialog(this);
            }
        }

        private void LoadReceipt(PosReceipt receipt)
        {
            InvalidateReceiptClaimStatus();
            if (_watcher == null || !_watcher.OwnsReceipt(receipt))
            {
                _receipt = null;
                PopulateItemsList(null);
                RenderReceiptClaimStatus();
                SetStatus("บิลไม่ตรงกับสาขา / เครื่องขายนี้ จึงไม่สามารถเลือกบิลได้", true);
                UpdateConfirmButton();
                return;
            }
            _receipt = receipt;
            _centralQuotePoints = null;
            _txtReceiptNo.Text = receipt.DocNo ?? "";
            PopulateItemsList(receipt);
            ShowMemberSummary(_selectedMember);
            UpdateConfirmButton();
            _ = RefreshReceiptClaimStatusAsync();
            _ = RefreshCentralQuoteAsync();
        }

        private async Task RefreshCentralQuoteAsync()
        {
            if (_receipt == null || _quoteLoading || IsDisposed) return;
            var receipt = _receipt;
            _quoteLoading = true;
            try
            {
                var quote = await CentralPromotions.QuoteAsync(CalcEligibleTotal(receipt), receipt.BranchCode);
                if (IsDisposed || !ReferenceEquals(receipt, _receipt)) return;
                _centralQuotePoints = quote.AwardedPoints;
                _lblPreviewPoints.Text = "แต้มตามโปรส่วนกลาง: " + quote.AwardedPoints.ToString(CultureInfo.InvariantCulture);
            }
            catch
            {
                if (IsDisposed || !ReferenceEquals(receipt, _receipt)) return;
                _centralQuotePoints = null;
                _lblPreviewPoints.Text = "ตรวจสอบโปรไม่ได้ — คิดแต้มจริงเมื่อยืนยัน";
            }
            finally { _quoteLoading = false; }
            if (!IsDisposed) ShowMemberSummary(_selectedMember);
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
                SetStatus("ไม่พบบิลของเครื่องขายนี้ กรุณาตรวจเลขบิลและเครื่องที่ออกบิล", true);
                _receipt = null;
                InvalidateReceiptClaimStatus();
                RenderReceiptClaimStatus();
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
            _lblPreviewPoints.Text = "กำลังตรวจสอบโปรส่วนกลาง…";
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
                AddMemberRow(m);
            }

            SetStatus("", false);
            RefreshEmptyStates();
        }

        private void AddMemberRow(MemberSearchResult member)
        {
            var row = new DataGridViewRow();
            row.CreateCells(_dgvResults, member.Id, member.MemberCode ?? "", member.DisplayName ?? "-", member.Phone ?? "",
                member.PointsAvailable ? member.CurrentPoints.ToString(CultureInfo.InvariantCulture) : "ยังไม่เปิดใช้");
            // Automatic first-row selection fires synchronously during Add.
            // Attach the capabilities before that event can select the member.
            row.Tag = member;
            _dgvResults.Rows.Add(row);
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

            _selectedMember = row.Tag as MemberSearchResult ?? new MemberSearchResult
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

            int pts = _centralQuotePoints ?? 0;
            _lblMemberName.Text = member.DisplayName + (string.IsNullOrWhiteSpace(member.Phone) ? "" : " | " + member.Phone);
            if (!member.PointsAvailable)
            {
                _lblMemberPoints.Text = "ระบบแต้มยังไม่เปิดใช้ — สมัคร ค้นหา และแก้ไขสมาชิกได้";
                _pnlMemberSummary.Visible = true;
                _btnEditMember.Visible = true;
                return;
            }
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

            using (var choice = new RegistrationChoiceForm(_customerDisplay, this))
            {
                var result = choice.ShowDialog(this);
                if (choice.DisplayedQr) { WindowState = FormWindowState.Minimized; return; }
                if (result != DialogResult.OK) return;
            }

            var form = new NewMemberForm(_api);
            form.MemberSaved += delegate (MemberSearchResult created)
            {
                _dgvResults.Rows.Clear();
                AddMemberRow(created);
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

            string required = AppSettingsProvider.Get("StaffEditPin", "123123");
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

            // A completed background load must not open a dialog over sales
            // after the cashier/independent guard has parked this window.
            if (IsDisposed || WindowState == FormWindowState.Minimized || IsParkedForSales?.Invoke() == true) return;

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
                        row.Cells["Points"].Value = updated.PointsAvailable ? updated.CurrentPoints.ToString(CultureInfo.InvariantCulture) : "ยังไม่เปิดใช้";
                        row.Tag = updated;
                        break;
                    }
                }

                SetStatus("แก้ไขข้อมูลสมาชิกสำเร็จ", false, Color.FromArgb(24, 140, 52));
                RefreshEmptyStates();
            };
            form.ShowDialog(this);
        }

        private bool PromptPin(string prompt, string requiredPin)
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

            // Keep PIN with its owner so the independent guard can park both.
            result = dlg.ShowDialog(this);
            bool ok = result == DialogResult.OK && txt.Text == requiredPin;
            dlg.Dispose();

            if (!ok && result == DialogResult.OK)
            {
                MessageBox.Show(
                    this,
                    "รหัสผ่านไม่ถูกต้อง",
                    "SCCRM",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Warning);
            }

            return ok;
        }

        private async Task ConfirmClaimAsync()
        {
            if (!CanConfirm())
                return;

            SetStatus("กำลังบันทึกบิลและแต้ม...", false, Color.DimGray);
            SetUiBusy(true);

            LoyaltyClaimResponse response = null;
            string errorMsg = null;
            try
            {
                // The display is advisory; recheck before submitting as well.
                // The database unique constraint remains the final race guard.
                await RefreshReceiptClaimStatusAsync();
                if (!_receiptStatusVerified || _receiptClaimStatus?.Claimed != false) {
                    SetStatus(_receiptStatusVerified ? "บิลนี้บันทึกให้สมาชิกแล้ว" : "ตรวจสถานะบิลไม่ได้ กรุณากดโหลดบิลเพื่อลองใหม่", !_receiptStatusVerified);
                    return;
                }
                response = await _api.SubmitLoyaltyClaimAsync(BuildClaimRequest());
            }
            catch (ApiException ex)
            {
                errorMsg = MapApiError(ex.Message);
                InvalidateReceiptClaimStatus();
                await RefreshReceiptClaimStatusAsync();
            }
            catch (Exception ex)
            {
                errorMsg = "เชื่อมต่อเซิร์ฟเวอร์ไม่สำเร็จ: " + ex.Message;
                InvalidateReceiptClaimStatus();
                await RefreshReceiptClaimStatusAsync();
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

            _claimCompleted = true;
            _receiptStatusVerified = true;
            _receiptClaimStatus = new ReceiptClaimStatus { Claimed = true, BranchCode = _receipt.BranchCode, ReceiptNo = _receipt.DocNo,
                ClaimId = response.ClaimId, MemberId = _selectedMember.Id,
                MemberName = string.IsNullOrWhiteSpace(response.MemberName) ? _selectedMember.DisplayName : response.MemberName,
                MemberCode = _selectedMember.MemberCode };
            RenderReceiptClaimStatus();
            ShowSuccess(response);
        }

        private LoyaltyClaimRequest BuildClaimRequest()
        {
            if (_watcher == null || !_watcher.OwnsReceipt(_receipt))
                throw new InvalidOperationException("บิลไม่ตรงกับสาขา / เครื่องขายนี้ จึงบันทึกให้สมาชิกไม่ได้");
            LoyaltyClaimItem[] items = new LoyaltyClaimItem[_receipt.Items != null ? _receipt.Items.Count : 0];
            if (_receipt.Items != null)
            {
                for (int i = 0; i < _receipt.Items.Count; i++)
                {
                    PosReceiptItem src = _receipt.Items[i];
                    items[i] = new LoyaltyClaimItem
                    {
                        Seq = src.Seq,
                        Barcode = src.Barcode,
                        LineDiscount = src.LineDiscount,
                        PromotionCode = src.PromotionCode,
                        UnitCode = src.UnitCode,
                        UnitName = src.UnitName,
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
                ReceiptTotalAmount = _receipt.GrandTotal,
                ReceiptDiscount = _receipt.Discount,
                PosCode = _receipt.PosCode,
                ReceiptCashierCode = _receipt.CashierCode,
                PreviewPoints = _centralQuotePoints ?? CalcPoints(eligibleTotal),
                MemberId = _selectedMember.Id,
                Items = items
            };
        }

        private void ShowSuccess(LoyaltyClaimResponse response)
        {
            _promotionTimer?.Stop();
            _lblStatus.ForeColor = Color.FromArgb(24, 140, 52);
            _lblStatus.Text = "บันทึกบิลสำเร็จ ได้รับ " + response.AwardedPoints.ToString(CultureInfo.InvariantCulture) +
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
            _uiBusy = busy;
            _txtReceiptNo.Enabled = !busy;
            _txtMemberSearch.Enabled = !busy;
            _dgvResults.Enabled = !busy;
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
            return !_uiBusy && !_claimCompleted && _receiptStatusVerified && !_receiptStatusChecking && _receiptClaimStatus?.Claimed == false &&
                _receipt != null && !_receipt.IsReturn && _receipt.DocType != "9" &&
                _watcher != null && _watcher.OwnsReceipt(_receipt) &&
                !string.IsNullOrWhiteSpace(_receipt.DocNo) && !string.IsNullOrWhiteSpace(_receipt.BranchCode) &&
                _receipt.GrandTotal > 0m && _receipt.Items != null && _receipt.Items.Count > 0 &&
                _selectedMember != null && _selectedMember.PointsAvailable;
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
                PointsAvailable = detail?.PointsAvailable ?? summary?.PointsAvailable ?? true,
                PharmacyMedRecordAvailable = detail?.PharmacyMedRecordAvailable ?? summary?.PharmacyMedRecordAvailable ?? true,
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
