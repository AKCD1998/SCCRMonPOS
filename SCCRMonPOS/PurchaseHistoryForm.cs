using System;
using System.Drawing;
using System.Globalization;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace SCCRMonPOS
{
    /// <summary>
    /// Read-only view of a member's purchase history (claimed bills) and the
    /// returns recorded against each bill. Opened from the "ประวัติการสะสม" tab.
    ///
    /// Has its own member search box, so it can be opened directly without first
    /// selecting a member on the claim form. If a member is passed in, their
    /// history is loaded immediately.
    ///
    /// Data source: GET /api/members/:id/purchase-history. Only bills the cashier
    /// linked to this member (via a loyalty claim) appear — AdaPos sales carry no
    /// member, so unclaimed purchases cannot be attributed here.
    /// </summary>
    public sealed class PurchaseHistoryForm : Form
    {
        private readonly ApiClient _api;
        private readonly string _initialMemberId;
        private readonly string _initialMemberName;

        private TextBox _txtSearch;
        private Button _btnSearch;
        private ComboBox _cboResults;
        private MemberSearchResult[] _searchResults = new MemberSearchResult[0];
        private bool _suppressResultEvent;

        private Label _lblMember;
        private Label _lblStatus;
        private DataGridView _dgvPurchases;
        private ListView _lvItems;
        private ListView _lvReturns;

        public PurchaseHistoryForm(ApiClient api, string memberId = null, string memberName = null)
        {
            _api               = api;
            _initialMemberId   = memberId;
            _initialMemberName = memberName ?? "";

            BuildUi();

            Load += async (s, e) =>
            {
                if (!string.IsNullOrWhiteSpace(_initialMemberId))
                    await LoadHistoryAsync(_initialMemberId, _initialMemberName);
                else
                {
                    _lblStatus.Text = "ค้นหาสมาชิกด้านบนเพื่อดูประวัติการซื้อ";
                    _txtSearch.Focus();
                }
            };
        }

        private void BuildUi()
        {
            Text          = "ประวัติการซื้อ";
            StartPosition = FormStartPosition.CenterParent;
            MinimumSize   = new Size(720, 560);
            Size          = new Size(760, 600);
            Font          = new Font("Segoe UI", 9f);

            var lblTitle = new Label
            {
                Text      = "ประวัติการซื้อ",
                Font      = new Font("Segoe UI", 12f, FontStyle.Bold),
                ForeColor = Color.FromArgb(11, 31, 184),
                Dock      = DockStyle.Top,
                Height    = 30,
                Padding   = new Padding(10, 6, 0, 0)
            };

            // Search row laid out by a TableLayoutPanel so it stretches with the
            // form and never overflows the right edge.
            var searchRow = new TableLayoutPanel
            {
                Dock        = DockStyle.Top,
                Height      = 36,
                ColumnCount = 4,
                RowCount    = 1,
                Padding     = new Padding(10, 4, 12, 0)
            };
            searchRow.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));        // label
            searchRow.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 220));   // textbox
            searchRow.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));        // button
            searchRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));    // combo fills rest

            var lblSearch = new Label
            {
                Text     = "ค้นหาสมาชิก:",
                AutoSize = true,
                Anchor   = AnchorStyles.Left,
                Margin   = new Padding(0, 6, 6, 0)
            };

            _txtSearch = new TextBox { Dock = DockStyle.Fill, Margin = new Padding(0, 3, 6, 0) };
            _txtSearch.KeyDown += async (s, e) =>
            {
                if (e.KeyCode == Keys.Enter) { e.SuppressKeyPress = true; await SearchAsync(); }
            };

            _btnSearch = new Button { Text = "ค้นหา", AutoSize = true, Margin = new Padding(0, 1, 8, 0) };
            _btnSearch.Click += async (s, e) => await SearchAsync();

            _cboResults = new ComboBox
            {
                Dock          = DockStyle.Fill,
                Margin        = new Padding(0, 3, 0, 0),
                DropDownStyle = ComboBoxStyle.DropDownList
            };
            _cboResults.SelectedIndexChanged += OnResultSelected;

            searchRow.Controls.Add(lblSearch,   0, 0);
            searchRow.Controls.Add(_txtSearch,  1, 0);
            searchRow.Controls.Add(_btnSearch,  2, 0);
            searchRow.Controls.Add(_cboResults, 3, 0);

            _lblMember = new Label
            {
                Text      = "สมาชิก: -",
                Dock      = DockStyle.Top,
                Height    = 22,
                Padding   = new Padding(12, 2, 10, 0),
                Font      = new Font("Segoe UI", 9f, FontStyle.Bold)
            };

            _lblStatus = new Label
            {
                Text      = "",
                Dock      = DockStyle.Top,
                Height    = 22,
                Padding   = new Padding(12, 2, 10, 0),
                ForeColor = Color.DimGray
            };

            _dgvPurchases = new DataGridView
            {
                Dock                  = DockStyle.Top,
                Height                = 210,
                AllowUserToAddRows    = false,
                AllowUserToDeleteRows = false,
                ReadOnly              = true,
                MultiSelect           = false,
                SelectionMode         = DataGridViewSelectionMode.FullRowSelect,
                RowHeadersVisible     = false,
                AutoSizeColumnsMode   = DataGridViewAutoSizeColumnsMode.Fill,
                BackgroundColor       = Color.White,
                BorderStyle           = BorderStyle.FixedSingle
            };
            _dgvPurchases.Columns.Add(new DataGridViewTextBoxColumn { Name = "soldAt",  HeaderText = "วันที่ซื้อ", FillWeight = 26 });
            _dgvPurchases.Columns.Add(new DataGridViewTextBoxColumn { Name = "receipt", HeaderText = "เลขบิล",     FillWeight = 30 });
            _dgvPurchases.Columns.Add(new DataGridViewTextBoxColumn { Name = "total",   HeaderText = "ยอดรวม",    FillWeight = 16, DefaultCellStyle = RightAlign() });
            _dgvPurchases.Columns.Add(new DataGridViewTextBoxColumn { Name = "points",  HeaderText = "แต้มที่ได้", FillWeight = 14, DefaultCellStyle = RightAlign() });
            _dgvPurchases.Columns.Add(new DataGridViewTextBoxColumn { Name = "returns", HeaderText = "คืน",        FillWeight = 14, DefaultCellStyle = RightAlign() });
            _dgvPurchases.SelectionChanged += OnPurchaseSelectionChanged;

            var lblItems = new Label { Text = "รายการสินค้าในบิล", Dock = DockStyle.Top, Height = 20, Padding = new Padding(12, 2, 0, 0), Font = new Font("Segoe UI", 9f, FontStyle.Bold) };
            _lvItems = new ListView
            {
                Dock = DockStyle.Top, Height = 120, View = View.Details,
                FullRowSelect = true, GridLines = true, MultiSelect = false
            };
            _lvItems.Columns.Add("สินค้า", 330);
            _lvItems.Columns.Add("จำนวน", 80, HorizontalAlignment.Center);
            _lvItems.Columns.Add("ยอด",   110, HorizontalAlignment.Right);

            var lblReturns = new Label { Text = "การคืนสินค้าของบิลนี้", Dock = DockStyle.Top, Height = 20, Padding = new Padding(12, 2, 0, 0), Font = new Font("Segoe UI", 9f, FontStyle.Bold) };
            _lvReturns = new ListView
            {
                Dock = DockStyle.Fill, View = View.Details,
                FullRowSelect = true, GridLines = true, MultiSelect = false
            };
            _lvReturns.Columns.Add("วันที่คืน", 150);
            _lvReturns.Columns.Add("เลขบิลคืน", 180);
            _lvReturns.Columns.Add("ยอดคืน",   90, HorizontalAlignment.Right);
            _lvReturns.Columns.Add("ชิ้น",     60, HorizontalAlignment.Right);
            _lvReturns.Columns.Add("แต้มถอน", 80, HorizontalAlignment.Right);

            // Docked controls are added in reverse visual order (last added sits topmost).
            Controls.Add(_lvReturns);
            Controls.Add(lblReturns);
            Controls.Add(_lvItems);
            Controls.Add(lblItems);
            Controls.Add(_dgvPurchases);
            Controls.Add(_lblStatus);
            Controls.Add(_lblMember);
            Controls.Add(searchRow);
            Controls.Add(lblTitle);
        }

        private static DataGridViewCellStyle RightAlign()
        {
            return new DataGridViewCellStyle { Alignment = DataGridViewContentAlignment.MiddleRight };
        }

        // ── Member search ────────────────────────────────────────────────────────

        private async Task SearchAsync()
        {
            string query = (_txtSearch.Text ?? "").Trim();
            if (query.Length == 0) { _txtSearch.Focus(); return; }

            _btnSearch.Enabled = false;
            _lblStatus.ForeColor = Color.DimGray;
            _lblStatus.Text = "กำลังค้นหา…";
            try
            {
                MemberSearchResult[] results = await _api.SearchMembersAsync(query) ?? new MemberSearchResult[0];
                _searchResults = results;

                _suppressResultEvent = true;
                _cboResults.Items.Clear();
                foreach (MemberSearchResult m in results)
                    _cboResults.Items.Add(FormatMemberLabel(m));
                _suppressResultEvent = false;

                if (results.Length == 0)
                {
                    _lblStatus.Text = "ไม่พบสมาชิกที่ตรงกับ \"" + query + "\"";
                }
                else if (results.Length == 1)
                {
                    _cboResults.SelectedIndex = 0; // triggers load
                }
                else
                {
                    _lblStatus.Text = "พบ " + results.Length + " คน — เลือกจากรายการด้านขวา";
                    _cboResults.DroppedDown = true;
                }
            }
            catch (Exception ex)
            {
                _lblStatus.ForeColor = Color.Firebrick;
                _lblStatus.Text = "ค้นหาไม่สำเร็จ";
                MessageBox.Show(this, ex.Message, "SCCRM", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
            finally
            {
                _btnSearch.Enabled = true;
            }
        }

        private async void OnResultSelected(object sender, EventArgs e)
        {
            if (_suppressResultEvent) return;
            int i = _cboResults.SelectedIndex;
            if (i < 0 || i >= _searchResults.Length) return;
            MemberSearchResult m = _searchResults[i];
            await LoadHistoryAsync(m.Id, m.DisplayName);
        }

        private static string FormatMemberLabel(MemberSearchResult m)
        {
            string label = string.IsNullOrWhiteSpace(m.DisplayName) ? "(ไม่มีชื่อ)" : m.DisplayName;
            if (!string.IsNullOrWhiteSpace(m.Phone)) label += " — " + m.Phone;
            if (!string.IsNullOrWhiteSpace(m.MemberCode)) label += " — " + m.MemberCode;
            return label;
        }

        // ── History ──────────────────────────────────────────────────────────────

        private async Task LoadHistoryAsync(string memberId, string memberName)
        {
            if (string.IsNullOrWhiteSpace(memberId)) return;

            _lblMember.Text = "สมาชิก: " + (string.IsNullOrWhiteSpace(memberName) ? "(สมาชิก)" : memberName);
            _lblStatus.ForeColor = Color.DimGray;
            _lblStatus.Text = "กำลังโหลด…";
            _dgvPurchases.Rows.Clear();
            ClearDetails();

            try
            {
                PurchaseHistoryResult history = await _api.GetMemberPurchaseHistoryAsync(memberId);
                PurchaseRecord[] purchases = history?.Purchases ?? new PurchaseRecord[0];

                foreach (PurchaseRecord p in purchases)
                {
                    int idx = _dgvPurchases.Rows.Add(
                        FormatDate(p.SoldAt),
                        p.ReceiptNo ?? "",
                        p.TotalAmount.ToString("N2", CultureInfo.InvariantCulture),
                        p.AwardedPoints.ToString(CultureInfo.InvariantCulture),
                        (p.Returns != null && p.Returns.Length > 0) ? p.Returns.Length.ToString() : "-");
                    _dgvPurchases.Rows[idx].Tag = p;
                }

                if (purchases.Length == 0)
                {
                    _lblStatus.Text = "สมาชิกรายนี้ยังไม่มีประวัติการซื้อที่สะสมแต้ม";
                }
                else
                {
                    _lblStatus.Text = "พบ " + purchases.Length + " บิล — คลิกเลือกบิลเพื่อดูรายการและการคืน";
                    _dgvPurchases.ClearSelection();
                    _dgvPurchases.Rows[0].Selected = true;
                }
            }
            catch (Exception ex)
            {
                _lblStatus.ForeColor = Color.Firebrick;
                _lblStatus.Text = "โหลดประวัติไม่สำเร็จ";
                MessageBox.Show(this, ex.Message, "SCCRM", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        }

        private void OnPurchaseSelectionChanged(object sender, EventArgs e)
        {
            PurchaseRecord p = null;
            if (_dgvPurchases.SelectedRows.Count > 0)
                p = _dgvPurchases.SelectedRows[0].Tag as PurchaseRecord;

            if (p == null) { ClearDetails(); return; }

            _lvItems.BeginUpdate();
            _lvItems.Items.Clear();
            if (p.Items != null)
            {
                foreach (PurchaseItem it in p.Items)
                {
                    var row = new ListViewItem(it.ProductName ?? it.ProductCode ?? "");
                    row.SubItems.Add(TrimNum(it.Qty));
                    row.SubItems.Add(it.LineTotal.ToString("N2", CultureInfo.InvariantCulture));
                    _lvItems.Items.Add(row);
                }
            }
            _lvItems.EndUpdate();

            _lvReturns.BeginUpdate();
            _lvReturns.Items.Clear();
            if (p.Returns != null)
            {
                foreach (PurchaseReturn r in p.Returns)
                {
                    var row = new ListViewItem(FormatDate(r.RefundedAt));
                    row.SubItems.Add(r.RefundDocNo ?? "");
                    row.SubItems.Add(r.RefundTotal.ToString("N2", CultureInfo.InvariantCulture));
                    row.SubItems.Add(TrimNum(r.ReturnedQty));
                    row.SubItems.Add(r.PointsReversed.ToString(CultureInfo.InvariantCulture));
                    _lvReturns.Items.Add(row);
                }
            }
            _lvReturns.EndUpdate();
        }

        private void ClearDetails()
        {
            _lvItems.Items.Clear();
            _lvReturns.Items.Clear();
        }

        private static string TrimNum(decimal value)
        {
            return value.ToString("0.##", CultureInfo.InvariantCulture);
        }

        private static string FormatDate(string raw)
        {
            if (string.IsNullOrWhiteSpace(raw)) return "-";
            DateTime parsed;
            if (DateTime.TryParse(raw, CultureInfo.InvariantCulture,
                    DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out parsed))
                return parsed.ToLocalTime().ToString("yyyy-MM-dd HH:mm", CultureInfo.InvariantCulture);
            return raw;
        }
    }
}
