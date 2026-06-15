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
    /// Data source: GET /api/members/:id/purchase-history. Only bills the cashier
    /// linked to this member (via a loyalty claim) appear — AdaPos sales carry no
    /// member, so unclaimed purchases cannot be attributed here.
    /// </summary>
    public sealed class PurchaseHistoryForm : Form
    {
        private readonly ApiClient _api;
        private readonly string _memberId;
        private readonly string _memberName;

        private DataGridView _dgvPurchases;
        private ListView _lvItems;
        private ListView _lvReturns;
        private Label _lblStatus;

        public PurchaseHistoryForm(ApiClient api, string memberId, string memberName)
        {
            _api        = api;
            _memberId   = memberId;
            _memberName = memberName ?? "";

            BuildUi();
            Load += async (s, e) => await LoadHistoryAsync();
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
                Text      = "ประวัติการซื้อของ: " + (_memberName == "" ? "(สมาชิก)" : _memberName),
                Font      = new Font("Segoe UI", 12f, FontStyle.Bold),
                ForeColor = Color.FromArgb(11, 31, 184),
                Dock      = DockStyle.Top,
                Height    = 36,
                Padding   = new Padding(10, 8, 10, 0)
            };

            _lblStatus = new Label
            {
                Text    = "กำลังโหลด…",
                Dock    = DockStyle.Top,
                Height  = 22,
                Padding = new Padding(12, 2, 10, 0),
                ForeColor = Color.DimGray
            };

            _dgvPurchases = new DataGridView
            {
                Dock                   = DockStyle.Top,
                Height                 = 230,
                AllowUserToAddRows     = false,
                AllowUserToDeleteRows  = false,
                ReadOnly               = true,
                MultiSelect            = false,
                SelectionMode          = DataGridViewSelectionMode.FullRowSelect,
                RowHeadersVisible      = false,
                AutoSizeColumnsMode    = DataGridViewAutoSizeColumnsMode.Fill,
                BackgroundColor        = Color.White,
                BorderStyle            = BorderStyle.FixedSingle
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
            Controls.Add(lblTitle);
        }

        private static DataGridViewCellStyle RightAlign()
        {
            return new DataGridViewCellStyle { Alignment = DataGridViewContentAlignment.MiddleRight };
        }

        private async Task LoadHistoryAsync()
        {
            try
            {
                PurchaseHistoryResult history = await _api.GetMemberPurchaseHistoryAsync(_memberId);
                PurchaseRecord[] purchases = history?.Purchases ?? new PurchaseRecord[0];

                _dgvPurchases.Rows.Clear();
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
                    ClearDetails();
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
                _lblStatus.Text = "โหลดประวัติไม่สำเร็จ";
                _lblStatus.ForeColor = Color.Firebrick;
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
