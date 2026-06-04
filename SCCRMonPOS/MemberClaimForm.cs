using System;
using System.Drawing;
using System.Globalization;
using System.Threading.Tasks;
using System.Windows.Forms;
using SCCRMonPOS.Models;

namespace SCCRMonPOS
{
    public sealed class MemberClaimForm : Form
    {
        private readonly ApiClient _api;
        private readonly AdaPosWatcher _watcher;
        private readonly int _bahtPerPoint;
        private readonly string _staffCode;

        private PosReceipt _receipt;
        private MemberSearchResult _selectedMember;

        private TextBox _txtReceiptNo;
        private Button _btnLoadReceipt;
        private ListView _lvItems;
        private ImageList _lvItemsRowSizer;
        private Label _lblItemsEmpty;
        private Panel _itemsHost;
        private Label _lblTotal;
        private Label _lblPreviewPoints;
        private TextBox _txtMemberSearch;
        private Button _btnSearch;
        private Button _btnNewMember;
        private DataGridView _dgvResults;
        private Label _lblMembersEmpty;
        private Panel _membersHost;
        private Panel _pnlMemberSummary;
        private Label _lblMemberName;
        private Label _lblMemberPoints;
        private Label _lblStatus;
        private Button _btnConfirm;
        private Button _btnCancel;
        private Button _btnEditMember;
        private ContextMenuStrip _extraMenu;

        public MemberClaimForm(
            ApiClient api,
            AdaPosWatcher watcher,
            int bahtPerPoint,
            string staffCode,
            PosReceipt prefilledReceipt = null)
        {
            _api = api;
            _watcher = watcher;
            _bahtPerPoint = bahtPerPoint > 0 ? bahtPerPoint : 10;
            _staffCode = staffCode ?? "";

            BuildUi();

            if (prefilledReceipt != null)
                LoadReceipt(prefilledReceipt);
        }

        private void BuildUi()
        {
            SuspendLayout();

            Text = "SCCRM - สะสมแต้ม";
            ClientSize = new Size(780, 590);
            MinimumSize = new Size(760, 560);
            FormBorderStyle = FormBorderStyle.Sizable;
            MaximizeBox = true;
            MinimizeBox = true;
            TopMost = true;
            StartPosition = FormStartPosition.CenterScreen;
            ShowInTaskbar = false;
            BackColor = Color.White;
            Font = new Font("Tahoma", 8.75f);
            AutoScaleMode = AutoScaleMode.Dpi;

            const int left = 16;
            const int contentWidth = 748;

            var title = new Label
            {
                Text = "สะสมแต้ม CRM",
                Font = new Font("Tahoma", 15f, FontStyle.Bold),
                ForeColor = Color.FromArgb(18, 92, 191),
                TextAlign = ContentAlignment.MiddleCenter,
                Bounds = new Rectangle(left, 14, contentWidth, 30),
                Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right
            };

            var navPanel = new Panel
            {
                Bounds = new Rectangle(left, 50, contentWidth, 34),
                BackColor = Color.White,
                Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right
            };
            navPanel.Controls.Add(CreateTabButton("บันทึกสะสมแต้ม", 0, true, null));
            navPanel.Controls.Add(CreateTabButton("ประวัติการสะสม", 1, false, OnComingSoonClick));
            navPanel.Controls.Add(CreateTabButton("สมาชิก", 2, false, OnComingSoonClick));
            navPanel.Controls.Add(CreateTabButton("รายงาน", 3, false, OnComingSoonClick));

            var btnExtra = CreateTabButton("เมนูเพิ่มเติม", 4, false, OnExtraMenuClick);
            btnExtra.BackColor = Color.FromArgb(18, 92, 191);
            btnExtra.ForeColor = Color.White;
            btnExtra.FlatAppearance.BorderColor = Color.FromArgb(18, 92, 191);
            navPanel.Controls.Add(btnExtra);

            BuildExtraMenu();

            var sectionReceipt = CreateSectionLabel("เลขที่ใบเสร็จ", left, 96);
            _txtReceiptNo = new TextBox
            {
                Bounds = new Rectangle(left, 120, 500, 28),
                Font = new Font("Tahoma", 10f),
                BorderStyle = BorderStyle.FixedSingle,
                Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right
            };
            _txtReceiptNo.KeyDown += delegate (object sender, KeyEventArgs e)
            {
                if (e.KeyCode == Keys.Enter)
                {
                    e.SuppressKeyPress = true;
                    _ = LoadReceiptAsync();
                }
            };

            _btnLoadReceipt = new Button
            {
                Text = "โหลด",
                Bounds = new Rectangle(left + contentWidth - 88, 120, 88, 28),
                Font = new Font("Tahoma", 9f),
                FlatStyle = FlatStyle.Flat,
                BackColor = Color.White,
                Anchor = AnchorStyles.Top | AnchorStyles.Right
            };
            _btnLoadReceipt.FlatAppearance.BorderColor = Color.FromArgb(200, 208, 220);
            _btnLoadReceipt.Click += async delegate { await LoadReceiptAsync(); };

            var sectionItems = CreateSectionLabel("รายการสินค้า", left, 158);

            _itemsHost = new Panel
            {
                Bounds = new Rectangle(left, 186, contentWidth, 72),
                BorderStyle = BorderStyle.FixedSingle,
                BackColor = Color.White,
                Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right
            };

            _lvItemsRowSizer = new ImageList();
            _lvItemsRowSizer.ImageSize = new Size(1, 14);
            _lvItemsRowSizer.ColorDepth = ColorDepth.Depth8Bit;

            _lvItems = new ListView
            {
                Bounds = new Rectangle(0, 0, contentWidth, 72),
                View = View.Details,
                FullRowSelect = true,
                GridLines = true,
                HeaderStyle = ColumnHeaderStyle.Nonclickable,
                MultiSelect = false,
                BorderStyle = BorderStyle.None,
                Font = new Font("Tahoma", 7.5f),
                SmallImageList = _lvItemsRowSizer
            };
            _lvItems.Columns.Add("รายการ", 574);
            _lvItems.Columns.Add("จำนวน", 52, HorizontalAlignment.Center);
            _lvItems.Columns.Add("ยอดรวม", 98, HorizontalAlignment.Right);

            _lblItemsEmpty = new Label
            {
                Text = "ยังไม่มีข้อมูลสินค้า",
                AutoSize = false,
                ForeColor = Color.FromArgb(160, 167, 180),
                Font = new Font("Tahoma", 8.5f),
                TextAlign = ContentAlignment.MiddleCenter,
                Bounds = new Rectangle(0, 22, contentWidth, 18),
                BackColor = Color.Transparent
            };
            _itemsHost.Controls.Add(_lvItems);
            _itemsHost.Controls.Add(_lblItemsEmpty);

            _lblTotal = new Label
            {
                Text = "ยอดรวม: -",
                AutoSize = false,
                TextAlign = ContentAlignment.MiddleRight,
                Font = new Font("Tahoma", 10.5f, FontStyle.Bold),
                ForeColor = Color.FromArgb(32, 32, 32),
                Bounds = new Rectangle(left + contentWidth - 180, 264, 180, 18),
                Anchor = AnchorStyles.Top | AnchorStyles.Right
            };

            _lblPreviewPoints = new Label
            {
                Text = "แต้มที่จะได้รับ: -",
                AutoSize = false,
                TextAlign = ContentAlignment.MiddleRight,
                Font = new Font("Tahoma", 10.5f, FontStyle.Bold),
                ForeColor = Color.FromArgb(24, 140, 52),
                Bounds = new Rectangle(left + contentWidth - 180, 284, 180, 18),
                Anchor = AnchorStyles.Top | AnchorStyles.Right
            };

            var divider = new Panel
            {
                Bounds = new Rectangle(left, 308, contentWidth, 1),
                BackColor = Color.FromArgb(220, 225, 232),
                Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right
            };

            var sectionSearch = CreateSectionLabel("ค้นหาสมาชิก (เบอร์โทร / ชื่อ / อีเมล)", left, 320);
            _txtMemberSearch = new TextBox
            {
                Bounds = new Rectangle(left, 344, 410, 26),
                Font = new Font("Tahoma", 9.5f),
                BorderStyle = BorderStyle.FixedSingle,
                Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right
            };
            _txtMemberSearch.KeyDown += delegate (object sender, KeyEventArgs e)
            {
                if (e.KeyCode == Keys.Enter)
                {
                    e.SuppressKeyPress = true;
                    _ = SearchMembersAsync();
                }
            };

            _btnSearch = new Button
            {
                Text = "ค้นหา",
                Bounds = new Rectangle(left + contentWidth - 184, 344, 80, 26),
                Font = new Font("Tahoma", 9f),
                FlatStyle = FlatStyle.Flat,
                BackColor = Color.White,
                Anchor = AnchorStyles.Top | AnchorStyles.Right
            };
            _btnSearch.FlatAppearance.BorderColor = Color.FromArgb(200, 208, 220);
            _btnSearch.Click += async delegate { await SearchMembersAsync(); };

            _btnNewMember = new Button
            {
                Text = "+ สมาชิกใหม่",
                Bounds = new Rectangle(left + contentWidth - 96, 344, 96, 26),
                Font = new Font("Tahoma", 9f, FontStyle.Bold),
                FlatStyle = FlatStyle.Flat,
                BackColor = Color.FromArgb(24, 140, 52),
                ForeColor = Color.White,
                Anchor = AnchorStyles.Top | AnchorStyles.Right
            };
            _btnNewMember.FlatAppearance.BorderSize = 0;
            _btnNewMember.Click += OnNewMemberClick;

            _membersHost = new Panel
            {
                Bounds = new Rectangle(left, 382, contentWidth, 52),
                BorderStyle = BorderStyle.FixedSingle,
                BackColor = Color.White,
                Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Bottom
            };

            _dgvResults = new DataGridView
            {
                Bounds = new Rectangle(0, 0, contentWidth, 42),
                ReadOnly = true,
                AllowUserToAddRows = false,
                AllowUserToDeleteRows = false,
                AllowUserToResizeRows = false,
                MultiSelect = false,
                SelectionMode = DataGridViewSelectionMode.FullRowSelect,
                RowHeadersVisible = false,
                AutoSizeColumnsMode = DataGridViewAutoSizeColumnsMode.Fill,
                BackgroundColor = Color.White,
                BorderStyle = BorderStyle.None,
                ColumnHeadersHeightSizeMode = DataGridViewColumnHeadersHeightSizeMode.DisableResizing,
                ColumnHeadersHeight = 24,
                Font = new Font("Tahoma", 7.5f)
            };
            _dgvResults.EnableHeadersVisualStyles = false;
            _dgvResults.ColumnHeadersDefaultCellStyle.BackColor = Color.White;
            _dgvResults.ColumnHeadersDefaultCellStyle.ForeColor = Color.FromArgb(38, 38, 38);
            _dgvResults.ColumnHeadersDefaultCellStyle.Font = new Font("Tahoma", 8f, FontStyle.Bold);
            _dgvResults.DefaultCellStyle.SelectionBackColor = Color.FromArgb(232, 241, 255);
            _dgvResults.DefaultCellStyle.SelectionForeColor = Color.FromArgb(18, 92, 191);
            _dgvResults.DefaultCellStyle.Font = new Font("Tahoma", 7.5f);
            _dgvResults.RowTemplate.Height = 18;
            _dgvResults.Columns.Add(new DataGridViewTextBoxColumn { Name = "Id", HeaderText = "ID", Visible = false });
            _dgvResults.Columns.Add(new DataGridViewTextBoxColumn { Name = "MemberCode", HeaderText = "MemberCode", Visible = false });
            _dgvResults.Columns.Add(new DataGridViewTextBoxColumn { Name = "DisplayName", HeaderText = "ชื่อสมาชิก", FillWeight = 58f });
            _dgvResults.Columns.Add(new DataGridViewTextBoxColumn { Name = "Phone", HeaderText = "เบอร์โทร", FillWeight = 28f });
            _dgvResults.Columns.Add(new DataGridViewTextBoxColumn { Name = "Points", HeaderText = "แต้ม", FillWeight = 14f });
            _dgvResults.CellDoubleClick += OnGridDoubleClick;
            _dgvResults.KeyDown += OnGridKeyDown;
            _dgvResults.SelectionChanged += OnGridSelectionChanged;

            _lblMembersEmpty = new Label
            {
                Text = "ยังไม่มีข้อมูลสมาชิก",
                AutoSize = false,
                ForeColor = Color.FromArgb(160, 167, 180),
                Font = new Font("Tahoma", 8.5f),
                TextAlign = ContentAlignment.MiddleCenter,
                Bounds = new Rectangle(0, 16, contentWidth, 18),
                BackColor = Color.Transparent
            };
            _membersHost.Controls.Add(_dgvResults);
            _membersHost.Controls.Add(_lblMembersEmpty);

            _pnlMemberSummary = new Panel
            {
                Bounds = new Rectangle(left, 440, contentWidth, 32),
                BackColor = Color.FromArgb(243, 248, 255),
                Visible = false,
                Anchor = AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Bottom
            };

            _lblMemberName = new Label
            {
                Bounds = new Rectangle(10, 2, 470, 16),
                Font = new Font("Tahoma", 9f, FontStyle.Bold),
                ForeColor = Color.FromArgb(18, 92, 191),
                Anchor = AnchorStyles.Left | AnchorStyles.Top | AnchorStyles.Right
            };

            _lblMemberPoints = new Label
            {
                Bounds = new Rectangle(10, 17, 470, 14),
                ForeColor = Color.FromArgb(70, 70, 70),
                Anchor = AnchorStyles.Left | AnchorStyles.Top | AnchorStyles.Right
            };

            _btnEditMember = new Button
            {
                Text = "แก้ไขข้อมูลสมาชิก",
                Bounds = new Rectangle(contentWidth - 144, 4, 136, 24),
                Font = new Font("Tahoma", 8f),
                FlatStyle = FlatStyle.Flat,
                BackColor = Color.White,
                ForeColor = Color.FromArgb(18, 92, 191),
                Visible = false,
                Anchor = AnchorStyles.Top | AnchorStyles.Right
            };
            _btnEditMember.FlatAppearance.BorderColor = Color.FromArgb(18, 92, 191);
            _btnEditMember.Click += OnEditMemberClick;

            _pnlMemberSummary.Controls.Add(_lblMemberName);
            _pnlMemberSummary.Controls.Add(_lblMemberPoints);
            _pnlMemberSummary.Controls.Add(_btnEditMember);

            _lblStatus = new Label
            {
                AutoSize = false,
                TextAlign = ContentAlignment.MiddleCenter,
                Font = new Font("Tahoma", 8.5f),
                ForeColor = Color.FromArgb(180, 38, 38),
                Bounds = new Rectangle(left, 478, contentWidth, 16),
                Anchor = AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Bottom
            };

            _btnCancel = new Button
            {
                Text = "ยกเลิก",
                Bounds = new Rectangle(left, 500, 112, 26),
                Font = new Font("Tahoma", 9f),
                FlatStyle = FlatStyle.Flat,
                BackColor = Color.White,
                Anchor = AnchorStyles.Left | AnchorStyles.Bottom
            };
            _btnCancel.FlatAppearance.BorderColor = Color.FromArgb(200, 208, 220);
            _btnCancel.Click += delegate { Close(); };

            _btnConfirm = new Button
            {
                Text = "ยืนยันการสะสมแต้ม",
                Bounds = new Rectangle(left + contentWidth - 188, 500, 188, 26),
                Font = new Font("Tahoma", 9f, FontStyle.Bold),
                Enabled = false,
                FlatStyle = FlatStyle.Flat,
                BackColor = Color.FromArgb(18, 92, 191),
                ForeColor = Color.White,
                Anchor = AnchorStyles.Right | AnchorStyles.Bottom
            };
            _btnConfirm.FlatAppearance.BorderSize = 0;
            _btnConfirm.Click += async delegate { await ConfirmClaimAsync(); };

            Controls.AddRange(new Control[]
            {
                title,
                navPanel,
                sectionReceipt,
                _txtReceiptNo,
                _btnLoadReceipt,
                sectionItems,
                _itemsHost,
                _lblTotal,
                _lblPreviewPoints,
                divider,
                sectionSearch,
                _txtMemberSearch,
                _btnSearch,
                _btnNewMember,
                _membersHost,
                _pnlMemberSummary,
                _lblStatus,
                _btnCancel,
                _btnConfirm
            });

            ResumeLayout(false);
            RefreshEmptyStates();
        }

        private Label CreateSectionLabel(string text, int x, int y)
        {
            return new Label
            {
                Text = text,
                Font = new Font("Tahoma", 11f, FontStyle.Bold),
                ForeColor = Color.FromArgb(40, 40, 40),
                Bounds = new Rectangle(x, y, 420, 22)
            };
        }

        private Button CreateTabButton(string text, int index, bool active, EventHandler clickHandler)
        {
            int width;
            int x;
            if (index == 4)
            {
                width = 196;
                x = 552;
            }
            else
            {
                width = 138;
                x = index * 138;
            }

            var button = new Button
            {
                Text = text,
                Bounds = new Rectangle(x, 0, width, 34),
                Font = new Font("Tahoma", 8f, active ? FontStyle.Bold : FontStyle.Regular),
                FlatStyle = FlatStyle.Flat,
                BackColor = active ? Color.White : Color.FromArgb(249, 251, 254),
                ForeColor = active ? Color.FromArgb(40, 40, 40) : Color.FromArgb(90, 98, 110),
                TextAlign = ContentAlignment.MiddleCenter
            };
            button.FlatAppearance.BorderColor = Color.FromArgb(220, 225, 232);
            button.FlatAppearance.MouseDownBackColor = button.BackColor;
            button.FlatAppearance.MouseOverBackColor = button.BackColor;
            if (clickHandler != null)
                button.Click += clickHandler;
            return button;
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

            ShowMemberSummary(_selectedMember);
            UpdateConfirmButton();
        }

        private void ClearMemberSelection()
        {
            _selectedMember = null;
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

            SetStatus("", false);

            MemberDetail detail;
            try
            {
                detail = await _api.GetMemberAsync(_selectedMember.Id);
            }
            catch (Exception ex)
            {
                SetStatus("โหลดข้อมูลสมาชิกไม่สำเร็จ: " + ex.Message, true);
                return;
            }

            if (detail == null)
            {
                SetStatus("ไม่พบข้อมูลสมาชิก", true);
                return;
            }

            var form = new NewMemberForm(_api, detail);
            form.MemberSaved += delegate (MemberSearchResult updated)
            {
                _selectedMember = updated;
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
                raw.IndexOf("duplicate", StringComparison.OrdinalIgnoreCase) >= 0)
                return "บิลนี้ถูกสะสมแต้มไปแล้ว";
            if (raw.IndexOf("not found", StringComparison.OrdinalIgnoreCase) >= 0)
                return "ไม่พบข้อมูลที่ใช้สำหรับสะสมแต้ม";
            return raw;
        }
    }
}
