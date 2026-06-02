using System;
using System.Collections.Generic;
using System.Configuration;
using System.Drawing;
using System.Globalization;
using System.Threading.Tasks;
using System.Windows.Forms;
using SCCRMonPOS.Models;
using System.Linq;

namespace SCCRMonPOS
{
    // ═══════════════════════════════════════════════════════════════════════════
    //  MemberPointForm  —  two-step wizard
    //
    //  Step 1 : member lookup  (by scan token or manual phone / member-code search)
    //  Step 2 : bill amount entry + point calculation + confirm
    //
    //  After a successful earn the transaction is written to the local audit log
    //  via TransactionRepository.  If the earn fails with a network error the
    //  operator is offered the option to queue the request offline.
    // ═══════════════════════════════════════════════════════════════════════════
    public class MemberPointForm : Form
    {
        // ── Dependencies ─────────────────────────────────────────────────────
        private readonly ApiClient            _api;
        private readonly ProductEligibilityClient _productEligibility;
        private readonly TransactionRepository _txRepo;
        private readonly OfflineQueue          _offlineQueue;

        // ── Session state ────────────────────────────────────────────────────
        private ApiCustomer _customer;
        private int         _step = 1;

        // ── Config ───────────────────────────────────────────────────────────
        private readonly decimal    _bahtPerPoint;
        private readonly bool       _requireProductScreening;

        // ── AdaPos standing-by receipt (may be null for manual flow) ─────────
        private readonly PosReceipt _posReceipt;

        // ── Step-1 controls ──────────────────────────────────────────────────
        private Panel    _pnlStep1;
        private TextBox  _txtSearch;
        private Button   _btnSearch;
        private GroupBox _grpMemberInfo;
        private Label    _lblName, _lblPhone, _lblMemberCode, _lblCurPoints, _lblTier, _lblStep1Error;

        // ── Step-2 controls ──────────────────────────────────────────────────
        private Panel   _pnlStep2;
        private Label   _lblS2MemberCode, _lblS2Name, _lblS2CurPoints;
        private TextBox _txtReceiptNo, _txtBillAmount;
        private Label   _lblEarned, _lblStep2Error;
        private TextBox _txtProductCode;
        private Button  _btnAddProduct, _btnClearProducts;
        private ListView _lvProducts;
        private Label   _lblProductSummary;
        private CheckBox _chkEligibleSubtotalConfirmed;

        private readonly List<ScreenedProduct> _screenedProducts = new List<ScreenedProduct>();

        // ── Shared bottom bar ────────────────────────────────────────────────
        private Button _btnBack, _btnNext;

        // ── Events ───────────────────────────────────────────────────────────

        /// <summary>
        /// Raised when the backend returns 401 (staff token expired or revoked)
        /// while the form is open.  TrayAppContext subscribes to trigger re-auth.
        /// </summary>
        public event EventHandler SessionExpired;

        // ────────────────────────────────────────────────────────────────────
        public MemberPointForm(
            string initialToken,
            ApiClient api,
            TransactionRepository txRepo,
            OfflineQueue offlineQueue,
            ProductEligibilityClient productEligibility,
            bool requireProductScreening,
            PosReceipt posReceipt = null)
        {
            _api                     = api;
            _txRepo                  = txRepo;
            _offlineQueue            = offlineQueue;
            _productEligibility      = productEligibility;
            _requireProductScreening = requireProductScreening;
            _bahtPerPoint            = ReadDecimal("BahtPerPoint", 10m);
            _posReceipt              = posReceipt;

            BuildUi();

            if (!string.IsNullOrWhiteSpace(initialToken))
            {
                _txtSearch.Text = initialToken.Trim();
                _ = ResolveScanTokenAsync(initialToken.Trim());
            }
        }

        // ════════════════════════════════════════════════════════════════════
        //  UI Construction
        // ════════════════════════════════════════════════════════════════════

        private void BuildUi()
        {
            SuspendLayout();

            Text            = "SCCRM — สะสมแต้มสมาชิก";
            ClientSize      = new Size(480, _requireProductScreening ? 610 : 390);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox     = false;
            MinimizeBox     = false;
            TopMost         = true;
            StartPosition   = FormStartPosition.CenterScreen;
            ShowInTaskbar   = false;
            Font            = new Font("Tahoma", 9.5f);
            BackColor       = Color.White;

            BuildStep1Panel();
            BuildStep2Panel();
            BuildBottomBar();

            ResumeLayout(false);
            PerformLayout();
        }

        private void BuildStep1Panel()
        {
            _pnlStep1 = new Panel { Location = new Point(0, 0), Size = new Size(480, 328), Visible = true };

            var lblCaption = MakeLabel("รหัส / เบอร์โทร :", new Point(18, 22), autoSize: true);

            _txtSearch = new TextBox
            {
                Location  = new Point(140, 19),
                Size      = new Size(200, 23),
                MaxLength = 100
            };
            _txtSearch.KeyDown += (s, e) =>
            {
                if (e.KeyCode == Keys.Return) { e.SuppressKeyPress = true; PerformManualSearch(); }
            };

            _btnSearch = new Button
            {
                Text     = "ค้นหา …",
                Location = new Point(348, 17),
                Size     = new Size(90, 27),
                UseVisualStyleBackColor = true
            };
            _btnSearch.Click += (s, e) => PerformManualSearch();

            _lblStep1Error = MakeLabel("", new Point(18, 52), autoSize: false);
            _lblStep1Error.Size      = new Size(440, 18);
            _lblStep1Error.ForeColor = Color.Crimson;

            _grpMemberInfo = new GroupBox
            {
                Text     = "ข้อมูลสมาชิก",
                Location = new Point(18, 76),
                Size     = new Size(440, 150),
                Enabled  = false
            };

            var r = new[] { "ชื่อลูกค้า :", "เบอร์โทร :", "รหัสสมาชิก :", "แต้มปัจจุบัน :", "ระดับสมาชิก :" };
            _lblName      = InfoLine(_grpMemberInfo, r[0], 24);
            _lblPhone     = InfoLine(_grpMemberInfo, r[1], 50);
            _lblMemberCode= InfoLine(_grpMemberInfo, r[2], 76);
            _lblCurPoints = InfoLine(_grpMemberInfo, r[3], 102);
            _lblTier      = InfoLine(_grpMemberInfo, r[4], 128);

            _lblCurPoints.ForeColor = Color.DarkBlue;
            _lblCurPoints.Font      = new Font("Tahoma", 9.5f, FontStyle.Bold);

            _pnlStep1.Controls.AddRange(new Control[]
            {
                lblCaption, _txtSearch, _btnSearch,
                _lblStep1Error, _grpMemberInfo
            });
            Controls.Add(_pnlStep1);
        }

        private Label InfoLine(GroupBox group, string caption, int y)
        {
            group.Controls.Add(MakeLabel(caption, new Point(12, y), autoSize: true));
            var val = MakeLabel("-", new Point(140, y), autoSize: false);
            val.Size = new Size(280, 18);
            group.Controls.Add(val);
            return val;
        }

        private void BuildStep2Panel()
        {
            _pnlStep2 = new Panel
            {
                Location = new Point(0, 0),
                Size = new Size(480, _requireProductScreening ? 548 : 328),
                Visible = false
            };

            var grpSummary = new GroupBox { Text = "ข้อมูลสมาชิก", Location = new Point(18, 10), Size = new Size(440, 100) };
            _lblS2MemberCode = InfoLine(grpSummary, "รหัสสมาชิก :", 24);
            _lblS2Name       = InfoLine(grpSummary, "ชื่อลูกค้า :", 52);
            _lblS2CurPoints  = InfoLine(grpSummary, "แต้มปัจจุบัน :", 78);
            _lblS2CurPoints.ForeColor = Color.DarkBlue;
            _lblS2CurPoints.Font      = new Font("Tahoma", 9.5f, FontStyle.Bold);

            var grpBill = new GroupBox
            {
                Text = _requireProductScreening ? "ข้อมูลบิลและคัดกรองสินค้า" : "ข้อมูลบิล",
                Location = new Point(18, 120),
                Size = new Size(440, _requireProductScreening ? 380 : 160)
            };

            var lblReceiptC = MakeLabel("หมายเลขใบเสร็จ :", new Point(12, 28), autoSize: true);
            _txtReceiptNo   = new TextBox { Location = new Point(165, 25), Size = new Size(255, 23), MaxLength = 50 };

            var lblBillC    = MakeLabel(
                _requireProductScreening ? "ยอดที่ร่วมสะสมแต้ม :" : "ยอดบิล (บาท) :",
                new Point(12, 60), autoSize: true);
            _txtBillAmount  = new TextBox { Location = new Point(165, 57), Size = new Size(255, 23), MaxLength = 12 };
            _txtBillAmount.TextChanged += (s, e) => RecalcPoints();

            var lblEarnedC  = MakeLabel("แต้มที่จะได้รับ :", new Point(12, 100), autoSize: true);
            lblEarnedC.ForeColor = Color.DarkGreen;
            _lblEarned = MakeLabel("0 แต้ม", new Point(165, 100), autoSize: false);
            _lblEarned.Size      = new Size(255, 22);
            _lblEarned.ForeColor = Color.DarkGreen;
            _lblEarned.Font      = new Font("Tahoma", 10f, FontStyle.Bold);

            if (_requireProductScreening)
            {
                var lblProductC = MakeLabel("สแกนสินค้า :", new Point(12, 136), autoSize: true);
                _txtProductCode = new TextBox { Location = new Point(165, 133), Size = new Size(165, 23), MaxLength = 100 };
                _txtProductCode.KeyDown += (s, e) =>
                {
                    if (e.KeyCode == Keys.Return)
                    {
                        e.SuppressKeyPress = true;
                        _ = AddProductAsync();
                    }
                };

                _btnAddProduct = new Button
                {
                    Text = "ตรวจสอบ",
                    Location = new Point(336, 131),
                    Size = new Size(84, 27),
                    UseVisualStyleBackColor = true
                };
                _btnAddProduct.Click += async (s, e) => await AddProductAsync();

                _lvProducts = new ListView
                {
                    Location = new Point(15, 168),
                    Size = new Size(405, 118),
                    View = View.Details,
                    FullRowSelect = true,
                    GridLines = true
                };
                _lvProducts.Columns.Add("รหัส", 90);
                _lvProducts.Columns.Add("สินค้า", 205);
                _lvProducts.Columns.Add("สถานะ", 105);

                _btnClearProducts = new Button
                {
                    Text = "ล้างรายการ",
                    Location = new Point(326, 292),
                    Size = new Size(94, 27),
                    UseVisualStyleBackColor = true
                };
                _btnClearProducts.Click += (s, e) => ClearScreenedProducts();

                _lblProductSummary = MakeLabel("ยังไม่ได้คัดกรองสินค้า", new Point(15, 326), autoSize: false);
                _lblProductSummary.Size = new Size(405, 18);

                _chkEligibleSubtotalConfirmed = new CheckBox
                {
                    Text = "ยืนยันว่า ยอดข้างต้นไม่รวมยา/สินค้าที่ไม่ร่วมสะสมแต้ม",
                    Location = new Point(15, 348),
                    Size = new Size(405, 20),
                    AutoSize = false
                };

                grpBill.Controls.AddRange(new Control[]
                {
                    lblProductC, _txtProductCode, _btnAddProduct,
                    _lvProducts, _btnClearProducts, _lblProductSummary,
                    _chkEligibleSubtotalConfirmed
                });
            }

            _lblStep2Error = MakeLabel("", new Point(12, _requireProductScreening ? 352 + 28 : 132), autoSize: false);
            _lblStep2Error.Size      = new Size(410, 36);
            _lblStep2Error.ForeColor = Color.Crimson;

            grpBill.Controls.AddRange(new Control[]
            {
                lblReceiptC, _txtReceiptNo,
                lblBillC,    _txtBillAmount,
                lblEarnedC,  _lblEarned,
                _lblStep2Error
            });

            _pnlStep2.Controls.AddRange(new Control[] { grpSummary, grpBill });
            Controls.Add(_pnlStep2);
        }

        private void BuildBottomBar()
        {
            var bar = new Panel { Dock = DockStyle.Bottom, Height = 52, BackColor = Color.FromArgb(240, 240, 240) };
            var sep = new Label { Dock = DockStyle.Top, Height = 1, BackColor = Color.Silver };

            _btnBack = new Button
            {
                Text     = "ย้อนกลับ",
                Size     = new Size(96, 32),
                Location = new Point(264, 10),
                UseVisualStyleBackColor = true
            };
            _btnBack.Click += BtnBack_Click;

            _btnNext = new Button
            {
                Text      = "ดำเนินการต่อ",
                Size      = new Size(108, 32),
                Location  = new Point(366, 10),
                BackColor = Color.FromArgb(0, 120, 215),
                ForeColor = Color.White,
                FlatStyle = FlatStyle.Flat
            };
            _btnNext.FlatAppearance.BorderSize = 0;
            _btnNext.FlatAppearance.MouseOverBackColor = Color.FromArgb(0, 100, 180);
            _btnNext.Click += BtnNext_Click;

            bar.Controls.AddRange(new Control[] { sep, _btnBack, _btnNext });
            Controls.Add(bar);
        }

        // ════════════════════════════════════════════════════════════════════
        //  Navigation
        // ════════════════════════════════════════════════════════════════════

        private void GoToStep(int step)
        {
            _step = step;
            _pnlStep1.Visible = (step == 1);
            _pnlStep2.Visible = (step == 2);

            if (step == 2)
            {
                _btnNext.Text = "ยืนยัน";
                PopulateStep2();
                _txtBillAmount.Focus();
            }
            else
            {
                _btnNext.Text = "ดำเนินการต่อ";
            }
        }

        // ════════════════════════════════════════════════════════════════════
        //  Step 1 — Member lookup
        // ════════════════════════════════════════════════════════════════════

        private async Task ResolveScanTokenAsync(string token)
        {
            SetLoading(true, "กำลังค้นหาสมาชิก…");
            try
            {
                ApiCustomer c = await _api.ResolveScanTokenAsync(token);
                LoadCustomer(c);
            }
            catch (TokenExpiredException ex) { HandleTokenExpired(ex); }
            catch (ApiException ex)          { ShowStep1Error(ex.Message); }
            finally { SetLoading(false); }
        }

        private async void PerformManualSearch()
        {
            string input = _txtSearch.Text.Trim();
            if (string.IsNullOrEmpty(input))
            {
                ShowStep1Error("กรุณากรอกรหัสสมาชิก หรือ เบอร์โทรศัพท์");
                return;
            }

            SetLoading(true, "กำลังค้นหาสมาชิก…");
            try
            {
                ApiCustomer c;
                if (input.StartsWith("SCM-", StringComparison.OrdinalIgnoreCase))
                    c = await _api.SearchByMemberCodeAsync(input);
                else if (input.Length <= 15 && !input.Contains("-"))
                    c = await _api.SearchByPhoneAsync(input);
                else
                    c = await _api.SearchByMemberCodeAsync(input);

                LoadCustomer(c);
            }
            catch (TokenExpiredException ex) { HandleTokenExpired(ex); }
            catch (ApiException ex)          { ShowStep1Error(ex.Message); }
            finally { SetLoading(false); }
        }

        private void LoadCustomer(ApiCustomer c)
        {
            if (c == null)
            {
                _customer = null;
                ShowStep1Error("ไม่พบข้อมูลสมาชิก");
                _grpMemberInfo.Enabled = false;
                return;
            }

            _customer              = c;
            ClearScreenedProducts();
            _lblName.Text          = c.FullName    ?? "—";
            _lblPhone.Text         = c.Phone       ?? "—";
            _lblMemberCode.Text    = c.MemberCode  ?? "—";
            _lblCurPoints.Text     = c.Balance.ToString("N0") + " แต้ม";
            _lblTier.Text          = c.Tier        ?? "—";
            _grpMemberInfo.Enabled = true;
            _lblStep1Error.Text    = "";
        }

        private void ShowStep1Error(string msg)
        {
            _lblStep1Error.Text    = msg;
            _customer              = null;
            _grpMemberInfo.Enabled = false;
            _lblName.Text          = "-";
            _lblPhone.Text         = "-";
            _lblMemberCode.Text    = "-";
            _lblCurPoints.Text     = "-";
            _lblTier.Text          = "-";
        }

        private void SetLoading(bool loading, string message = "")
        {
            _btnSearch.Enabled = !loading;
            _btnNext.Enabled   = !loading;
            _btnBack.Enabled   = !loading;
            if (loading) _lblStep1Error.Text = message;
        }

        private void BtnBack_Click(object sender, EventArgs e)
        {
            if (_step == 1) Close();
            else { _lblStep2Error.Text = ""; GoToStep(1); }
        }

        private void BtnNext_Click(object sender, EventArgs e)
        {
            if (_step == 1) Step1Proceed();
            else            _ = Step2ConfirmAsync();
        }

        private void Step1Proceed()
        {
            if (_customer == null)
            {
                ShowStep1Error("กรุณาค้นหาสมาชิกก่อนดำเนินการต่อ");
                return;
            }
            GoToStep(2);
        }

        // ════════════════════════════════════════════════════════════════════
        //  Step 2 — Bill & points
        // ════════════════════════════════════════════════════════════════════

        private void PopulateStep2()
        {
            if (_customer == null) return;
            _lblS2MemberCode.Text = _customer.MemberCode ?? "—";
            _lblS2Name.Text       = _customer.FullName   ?? "—";
            _lblS2CurPoints.Text  = _customer.Balance.ToString("N0") + " แต้ม";
            _lblStep2Error.Text   = "";

            // Pre-fill from AdaPos standing-by receipt if available
            if (_posReceipt != null)
            {
                if (string.IsNullOrEmpty(_txtReceiptNo.Text))
                    _txtReceiptNo.Text = _posReceipt.DocNo;

                if (string.IsNullOrEmpty(_txtBillAmount.Text))
                    _txtBillAmount.Text = _posReceipt.GrandTotal.ToString("F2");

                // Auto-screen all products from the receipt (only if none screened yet)
                if (_requireProductScreening && _posReceipt.Items.Count > 0
                    && _screenedProducts.Count == 0)
                    _ = PreScreenProductsAsync(_posReceipt.Items);
            }

            RecalcPoints();
        }

        private void RecalcPoints()
        {
            decimal bill;
            if (!TryParseBill(_txtBillAmount.Text, out bill))
            {
                _lblEarned.Text = "0 แต้ม";
                return;
            }
            int pts = (int)Math.Floor(bill / _bahtPerPoint);
            _lblEarned.Text = pts.ToString("N0") + " แต้ม";
        }

        private int CalcPoints()
        {
            decimal bill;
            if (!TryParseBill(_txtBillAmount.Text, out bill)) return 0;
            return (int)Math.Floor(bill / _bahtPerPoint);
        }

        private static bool TryParseBill(string text, out decimal value)
        {
            return decimal.TryParse(
                (text ?? "").Trim(),
                NumberStyles.Number,
                CultureInfo.InvariantCulture,
                out value) && value >= 0;
        }

        private async Task Step2ConfirmAsync()
        {
            _lblStep2Error.Text = "";

            if (_requireProductScreening)
            {
                if (_productEligibility == null || !_productEligibility.IsConfigured)
                {
                    _lblStep2Error.Text = "ยังไม่ได้ตั้งค่าระบบคัดกรองสินค้า จึงยังไม่สามารถสะสมแต้มได้";
                    return;
                }
                if (_screenedProducts.Count == 0)
                {
                    _lblStep2Error.Text = "กรุณาคัดกรองสินค้าอย่างน้อย 1 รายการก่อนยืนยัน";
                    _txtProductCode.Focus();
                    return;
                }
                if (HasUnknownOrUnmatchedProducts())
                {
                    _lblStep2Error.Text = "มีสินค้าที่ไม่พบข้อมูลหรือยังไม่จัดประเภท กรุณาตรวจสอบก่อน";
                    _txtProductCode.Focus();
                    return;
                }
                if (_chkEligibleSubtotalConfirmed != null && !_chkEligibleSubtotalConfirmed.Checked)
                {
                    _lblStep2Error.Text = "กรุณายืนยันว่าใช้ยอดเฉพาะสินค้าที่ร่วมสะสมแต้ม";
                    return;
                }
            }

            string billText = _txtBillAmount.Text.Trim();
            if (string.IsNullOrEmpty(billText))
            {
                _lblStep2Error.Text = "กรุณากรอกยอดบิล";
                _txtBillAmount.Focus();
                return;
            }

            decimal bill;
            if (!TryParseBill(billText, out bill) || bill <= 0)
            {
                _lblStep2Error.Text = "ยอดบิลต้องเป็นตัวเลขมากกว่า 0";
                _txtBillAmount.Focus();
                return;
            }

            int    earned    = CalcPoints();
            int    newTotal  = _customer.Balance + earned;
            string receiptNo = _txtReceiptNo.Text.Trim();

            string confirmMsg =
                "ยืนยันการสะสมแต้ม?\n\n" +
                $"ชื่อลูกค้า    :  {_customer.FullName}\n" +
                $"รหัสสมาชิก  :  {_customer.MemberCode}\n" +
                (string.IsNullOrEmpty(receiptNo) ? "" : $"ใบเสร็จ        :  {receiptNo}\n") +
                (_requireProductScreening
                    ? $"ยอดที่ร่วมสะสมแต้ม :  {bill:N2} บาท\n"
                    : $"ยอดบิล       :  {bill:N2} บาท\n") +
                (_requireProductScreening ? BuildProductSummaryForConfirm() : "") +
                $"แต้มที่ได้รับ  :  {earned:N0} แต้ม\n" +
                $"แต้มรวมใหม่  :  {newTotal:N0} แต้ม";

            DialogResult dr = MessageBox.Show(
                confirmMsg,
                "SCCRM — ยืนยันการสะสมแต้ม",
                MessageBoxButtons.YesNo,
                MessageBoxIcon.Question,
                MessageBoxDefaultButton.Button2);

            if (dr != DialogResult.Yes) return;

            SetLoading(true, "กำลังบันทึก…");
            try
            {
                EarnApiResult result = await _api.EarnPointsAsync(_customer.Id, bill, receiptNo);

                // ── Write to local audit log ───────────────────────────────────
                WriteAuditLog(result, bill, receiptNo);

                ShowSuccess(result, bill, receiptNo);
                Close();
            }
            catch (TokenExpiredException ex)
            {
                HandleTokenExpired(ex);
            }
            catch (NetworkApiException ex)
            {
                // Network failure — server never received the request.
                // Offer to queue so it can be retried on the next launch.
                _lblStep2Error.Text = ex.Message;
                SetLoading(false);

                DialogResult offerQueue = MessageBox.Show(
                    "ไม่สามารถส่งข้อมูลได้เนื่องจากเครือข่ายขัดข้อง\n\n" +
                    "ต้องการบันทึกรายการนี้ไว้ส่งอีกครั้งในครั้งถัดไปหรือไม่?",
                    "SCCRM — เครือข่ายขัดข้อง",
                    MessageBoxButtons.YesNo,
                    MessageBoxIcon.Question,
                    MessageBoxDefaultButton.Button1);

                if (offerQueue == DialogResult.Yes)
                {
                    try
                    {
                        _offlineQueue.Enqueue(
                            _customer.Id, bill, receiptNo,
                            _customer.FullName, _customer.MemberCode);
                        MessageBox.Show(
                            "บันทึกรายการไว้แล้ว\nจะส่งอัตโนมัติเมื่อเปิดโปรแกรมครั้งถัดไป",
                            "SCCRM",
                            MessageBoxButtons.OK,
                            MessageBoxIcon.Information);
                    }
                    catch (Exception qEx)
                    {
                        MessageBox.Show(
                            "ไม่สามารถบันทึกรายการไว้ได้: " + qEx.Message,
                            "SCCRM",
                            MessageBoxButtons.OK,
                            MessageBoxIcon.Warning);
                    }
                    Close();
                }
                return; // SetLoading already called above
            }
            catch (ApiException ex)
            {
                _lblStep2Error.Text = ex.Message;
            }
            finally
            {
                // Guard: only call if form is still alive (not closed by token-expiry path)
                if (!IsDisposed) SetLoading(false);
            }
        }

        // ── Audit log ─────────────────────────────────────────────────────────

        private void WriteAuditLog(EarnApiResult result, decimal bill, string receiptNo)
        {
            if (_txRepo == null) return;
            try
            {
                _txRepo.Append(new TransactionLog
                {
                    TransactionId   = result.TransactionId,
                    TransactionType = "POINT_COLLECT",
                    MemberToken     = _customer.MemberCode ?? _customer.Id ?? "",
                    MemberName      = _customer.FullName   ?? "",
                    ReceiptNo       = receiptNo,
                    BillAmount      = bill,
                    EarnedPoints    = result.PointsAwarded,
                    PointsBefore    = _customer.Balance,
                    PointsAfter     = result.Balance,
                    CreatedAt       = DateTime.Now,
                    PosMachineName  = Environment.MachineName
                });
            }
            catch { /* Audit log failure is non-fatal — never block the earn flow */ }
        }

        // ── Success dialog ────────────────────────────────────────────────────

        private void ShowSuccess(EarnApiResult result, decimal bill, string receiptNo)
        {
            string msg =
                "✔  สะสมแต้มสำเร็จ!\n\n" +
                $"ชื่อลูกค้า    :  {_customer.FullName}\n" +
                $"รหัสสมาชิก  :  {_customer.MemberCode}\n" +
                (string.IsNullOrEmpty(receiptNo) ? "" : $"ใบเสร็จ        :  {receiptNo}\n") +
                (_requireProductScreening
                    ? $"ยอดที่ร่วมสะสมแต้ม :  {bill:N2} บาท\n"
                    : $"ยอดบิล       :  {bill:N2} บาท\n") +
                $"แต้มที่ได้รับ  :  {result.PointsAwarded:N0} แต้ม\n" +
                $"แต้มรวมใหม่  :  {result.Balance:N0} แต้ม\n\n" +
                $"[{result.TransactionId}]";

            MessageBox.Show(msg, "SCCRM — สะสมแต้มสำเร็จ",
                MessageBoxButtons.OK, MessageBoxIcon.Information);
        }

        // ── Token expiry handler ──────────────────────────────────────────────

        private void HandleTokenExpired(TokenExpiredException ex)
        {
            MessageBox.Show(
                ex.Message + "\nหน้าต่างนี้จะปิดและนำคุณไปยังหน้าเข้าสู่ระบบ",
                "SCCRM — หมดอายุ",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);

            SessionExpired?.Invoke(this, EventArgs.Empty);

            if (!IsDisposed) Close();
        }

        // ════════════════════════════════════════════════════════════════════
        //  Helpers
        // ════════════════════════════════════════════════════════════════════

        private static Label MakeLabel(string text, Point location, bool autoSize)
        {
            return new Label { Text = text, Location = location, AutoSize = autoSize };
        }

        private static decimal ReadDecimal(string key, decimal defaultValue)
        {
            string raw = ConfigurationManager.AppSettings[key];
            return decimal.TryParse(raw, out decimal v) ? v : defaultValue;
        }

        // codeOverride: when called from PreScreenProductsAsync, pass the barcode/product code
        // directly instead of reading from the text box. UI feedback is suppressed in that mode.
        private async Task AddProductAsync(string codeOverride = null)
        {
            if (!_requireProductScreening) return;

            bool fromReceipt = codeOverride != null;
            string code = fromReceipt ? codeOverride.Trim() : (_txtProductCode?.Text ?? "").Trim();

            if (string.IsNullOrEmpty(code))
            {
                if (!fromReceipt) _lblStep2Error.Text = "กรุณาสแกนหรือกรอกรหัสสินค้า";
                return;
            }

            if (_productEligibility == null || !_productEligibility.IsConfigured)
            {
                if (!fromReceipt) _lblStep2Error.Text = "ยังไม่ได้ตั้งค่าระบบคัดกรองสินค้า";
                return;
            }

            _lblStep2Error.Text = "";
            if (!fromReceipt) ToggleProductLookup(false);
            try
            {
                ProductEligibilityResult result = await _productEligibility.LookupAsync(code);
                var screened = new ScreenedProduct
                {
                    LookupCode   = code,
                    DisplayName  = result.DisplayName,
                    ProductKind  = result.ProductKind,
                    CategoryName = result.CategoryName,
                    Eligible     = result.Eligible,
                    StatusText   = GetStatusText(result),
                    IsResolvable = !string.IsNullOrEmpty(result.ProductKind),
                };

                _screenedProducts.Add(screened);
                var item = new ListViewItem(screened.LookupCode);
                item.SubItems.Add(screened.DisplayName ?? "-");
                item.SubItems.Add(screened.StatusText);
                item.ForeColor = screened.Eligible ? Color.DarkGreen : Color.Firebrick;
                _lvProducts.Items.Add(item);

                if (!fromReceipt) { _txtProductCode.Clear(); _txtProductCode.Focus(); }
                UpdateProductSummary();
            }
            catch (ProductEligibilityNotFoundException ex)
            {
                AddUnresolvedProduct(code, ex.Message);
            }
            catch (ProductEligibilityLookupException ex)
            {
                if (!fromReceipt) _lblStep2Error.Text = ex.Message;
            }
            finally
            {
                if (!fromReceipt) ToggleProductLookup(true);
            }
        }

        // Auto-screens every item from the AdaPos receipt without cashier interaction.
        private async Task PreScreenProductsAsync(IList<PosReceiptItem> items)
        {
            if (!_requireProductScreening
                || _productEligibility == null
                || !_productEligibility.IsConfigured) return;

            ToggleProductLookup(false);
            try
            {
                foreach (PosReceiptItem item in items)
                {
                    // Prefer barcode; fall back to product code
                    string code = !string.IsNullOrWhiteSpace(item.Barcode)
                        ? item.Barcode
                        : item.ProductCode;
                    if (!string.IsNullOrWhiteSpace(code))
                        await AddProductAsync(code);
                }
            }
            finally
            {
                ToggleProductLookup(true);
            }
        }

        private void AddUnresolvedProduct(string code, string reason)
        {
            var screened = new ScreenedProduct
            {
                LookupCode = code,
                DisplayName = "-",
                ProductKind = "",
                CategoryName = "",
                Eligible = false,
                StatusText = reason,
                IsResolvable = false,
            };

            _screenedProducts.Add(screened);
            var item = new ListViewItem(screened.LookupCode);
            item.SubItems.Add("-");
            item.SubItems.Add(screened.StatusText);
            item.ForeColor = Color.Firebrick;
            _lvProducts.Items.Add(item);
            _txtProductCode.Clear();
            _txtProductCode.Focus();
            UpdateProductSummary();
        }

        private void ClearScreenedProducts()
        {
            _screenedProducts.Clear();
            if (_lvProducts != null) _lvProducts.Items.Clear();
            if (_chkEligibleSubtotalConfirmed != null) _chkEligibleSubtotalConfirmed.Checked = false;
            UpdateProductSummary();
            _txtProductCode?.Focus();
        }

        private void UpdateProductSummary()
        {
            if (!_requireProductScreening || _lblProductSummary == null) return;

            int eligible = 0, blocked = 0, unresolved = 0;
            foreach (ScreenedProduct product in _screenedProducts)
            {
                if (!product.IsResolvable) unresolved++;
                else if (product.Eligible) eligible++;
                else blocked++;
            }

            _lblProductSummary.Text =
                $"คัดกรองแล้ว { _screenedProducts.Count:N0} รายการ | ร่วมสะสมแต้ม {eligible:N0} | ไม่ร่วม {blocked:N0} | ต้องตรวจสอบ {unresolved:N0}";
        }

        private bool HasUnknownOrUnmatchedProducts()
        {
            foreach (ScreenedProduct product in _screenedProducts)
            {
                if (!product.IsResolvable) return true;
            }
            return false;
        }

        private string BuildProductSummaryForConfirm()
        {
            int eligible = 0, blocked = 0;
            foreach (ScreenedProduct product in _screenedProducts)
            {
                if (product.Eligible) eligible++;
                else blocked++;
            }

            return
                $"สินค้าที่ร่วมสะสมแต้ม :  {eligible:N0} รายการ\n" +
                $"สินค้าที่ไม่ร่วมสะสมแต้ม :  {blocked:N0} รายการ\n";
        }

        private void ToggleProductLookup(bool enabled)
        {
            if (_txtProductCode != null) _txtProductCode.Enabled = enabled;
            if (_btnAddProduct != null) _btnAddProduct.Enabled = enabled;
            if (_btnClearProducts != null) _btnClearProducts.Enabled = enabled;
            _btnNext.Enabled = enabled;
            _btnBack.Enabled = enabled;
        }

        private static string GetStatusText(ProductEligibilityResult result)
        {
            if (result == null) return "ไม่พบข้อมูล";
            if (result.Eligible) return "ร่วมสะสมแต้ม";
            if (string.Equals(result.Reason, "medicine_blocked", StringComparison.OrdinalIgnoreCase))
                return "ยา - ไม่ร่วมสะสม";
            if (string.Equals(result.Reason, "unknown_product_kind", StringComparison.OrdinalIgnoreCase))
                return "ยังไม่จัดประเภท";
            return "ไม่ร่วมสะสม";
        }

        private sealed class ScreenedProduct
        {
            public string LookupCode { get; set; }
            public string DisplayName { get; set; }
            public string ProductKind { get; set; }
            public string CategoryName { get; set; }
            public bool Eligible { get; set; }
            public bool IsResolvable { get; set; }
            public string StatusText { get; set; }
        }
    }
}
