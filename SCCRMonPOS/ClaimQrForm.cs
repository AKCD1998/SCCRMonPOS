using System;
using System.Drawing;
using System.Globalization;
using System.Windows.Forms;
using SCCRMonPOS.Models;

namespace SCCRMonPOS
{
    public sealed class ClaimQrForm : Form
    {
        private readonly Timer  _closeTimer;
        private readonly Timer  _countdownTimer;
        private int             _secondsLeft;
        private Label           _countdownLabel;
        private Label           _qrErrorLabel;

        public ClaimQrForm(
            PosReceipt receipt,
            string claimPayload,
            DateTime? expiresAtUtc,
            int displaySeconds)
        {
            SuspendLayout();

            Text            = "SCCRM — Loyalty Claim";
            ClientSize      = new Size(360, 560);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox     = false;
            MinimizeBox     = false;
            TopMost         = true;
            StartPosition   = FormStartPosition.CenterScreen;
            ShowInTaskbar   = false;
            BackColor       = Color.White;
            Font            = new Font("Tahoma", 9.5f);

            // ── Title ──────────────────────────────────────────────────────────
            var title = new Label
            {
                Text      = "สแกนเพื่อสะสมแต้ม",
                AutoSize  = false,
                TextAlign = ContentAlignment.MiddleCenter,
                Font      = new Font("Tahoma", 15f, FontStyle.Bold),
                ForeColor = Color.FromArgb(16, 74, 132),
                Bounds    = new Rectangle(20, 16, 320, 34)
            };

            var subtitle = new Label
            {
                Text      = "เปิดแอปมือถือแล้วสแกน QR นี้หลังชำระเงิน",
                AutoSize  = false,
                TextAlign = ContentAlignment.MiddleCenter,
                ForeColor = Color.FromArgb(70, 70, 70),
                Bounds    = new Rectangle(20, 54, 320, 28)
            };

            // ── QR image box ───────────────────────────────────────────────────
            var qrBox = new PictureBox
            {
                Bounds      = new Rectangle(60, 90, 240, 240),
                BorderStyle = BorderStyle.None,
                SizeMode    = PictureBoxSizeMode.Zoom,
                BackColor   = Color.White
            };

            _qrErrorLabel = new Label
            {
                Text      = "ไม่สามารถโหลด QR — กรุณาพิมพ์รหัสด้านล่าง",
                AutoSize  = false,
                TextAlign = ContentAlignment.MiddleCenter,
                ForeColor = Color.FromArgb(160, 0, 0),
                Bounds    = new Rectangle(60, 90, 240, 240),
                Visible   = false,
                Font      = new Font("Tahoma", 9f, FontStyle.Italic),
                BackColor = Color.FromArgb(255, 245, 245)
            };

            string qrUrl = BuildQrImageUrl(claimPayload);
            qrBox.LoadCompleted += (s, e) =>
            {
                if (e.Error != null || qrBox.Image == null)
                {
                    qrBox.Visible       = false;
                    _qrErrorLabel.Visible = true;
                }
            };
            try { qrBox.LoadAsync(qrUrl); }
            catch { qrBox.Visible = false; _qrErrorLabel.Visible = true; }

            // ── Receipt summary ────────────────────────────────────────────────
            var receiptLabel = new Label
            {
                Text      = BuildReceiptSummary(receipt, expiresAtUtc),
                AutoSize  = false,
                ForeColor = Color.FromArgb(55, 55, 55),
                Bounds    = new Rectangle(24, 342, 312, 72)
            };

            // ── Raw claim code (fallback) ───────────────────────────────────────
            var codeHeader = new Label
            {
                Text      = "หรือพิมพ์รหัสนี้ในแอป:",
                AutoSize  = false,
                ForeColor = Color.FromArgb(90, 90, 90),
                Font      = new Font("Tahoma", 8.5f, FontStyle.Italic),
                Bounds    = new Rectangle(24, 420, 312, 18)
            };

            var payloadBox = new TextBox
            {
                Bounds      = new Rectangle(24, 440, 312, 32),
                ReadOnly    = true,
                Multiline   = false,
                Text        = claimPayload,
                Font        = new Font("Consolas", 9f),
                BackColor   = Color.FromArgb(245, 245, 245),
                BorderStyle = BorderStyle.FixedSingle
            };

            // ── Buttons ────────────────────────────────────────────────────────
            var copyButton = new Button
            {
                Text                  = "คัดลอก",
                Bounds                = new Rectangle(24, 482, 80, 28),
                UseVisualStyleBackColor = true
            };
            copyButton.Click += (s, e) =>
            {
                try { Clipboard.SetText(claimPayload); }
                catch { }
            };

            var closeButton = new Button
            {
                Text                  = "ปิด",
                Bounds                = new Rectangle(256, 482, 80, 28),
                UseVisualStyleBackColor = true
            };
            closeButton.Click += (s, e) => Close();

            // ── Countdown label ────────────────────────────────────────────────
            _secondsLeft   = Math.Max(5, displaySeconds);
            _countdownLabel = new Label
            {
                Text      = "ปิดอัตโนมัติใน " + _secondsLeft + " วินาที",
                AutoSize  = false,
                TextAlign = ContentAlignment.MiddleCenter,
                ForeColor = Color.FromArgb(130, 130, 130),
                Font      = new Font("Tahoma", 8.5f),
                Bounds    = new Rectangle(110, 517, 140, 20)
            };

            Controls.AddRange(new Control[]
            {
                title, subtitle,
                qrBox, _qrErrorLabel,
                receiptLabel,
                codeHeader, payloadBox,
                copyButton, closeButton,
                _countdownLabel
            });

            // ── Auto-close timer ───────────────────────────────────────────────
            _closeTimer = new Timer { Interval = _secondsLeft * 1000 };
            _closeTimer.Tick += (s, e) =>
            {
                _closeTimer.Stop();
                Close();
            };
            _closeTimer.Start();

            // ── Countdown display timer (ticks every second) ───────────────────
            _countdownTimer = new Timer { Interval = 1000 };
            _countdownTimer.Tick += (s, e) =>
            {
                _secondsLeft--;
                if (_secondsLeft <= 0)
                {
                    _countdownTimer.Stop();
                    _countdownLabel.Text = "กำลังปิด…";
                }
                else
                {
                    _countdownLabel.Text = "ปิดอัตโนมัติใน " + _secondsLeft + " วินาที";
                }
            };
            _countdownTimer.Start();

            ResumeLayout(false);
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                _closeTimer?.Dispose();
                _countdownTimer?.Dispose();
            }
            base.Dispose(disposing);
        }

        private static string BuildReceiptSummary(PosReceipt receipt, DateTime? expiresAtUtc)
        {
            string amount     = receipt == null
                ? "-"
                : receipt.GrandTotal.ToString("N2", CultureInfo.InvariantCulture) + " บาท";
            string docNo      = receipt?.DocNo     ?? "-";
            string branchCode = receipt?.BranchCode ?? "-";
            string expires    = expiresAtUtc.HasValue
                ? expiresAtUtc.Value.ToLocalTime().ToString("HH:mm:ss")
                : "-";

            return
                "ใบเสร็จ: " + docNo       + Environment.NewLine +
                "สาขา: "   + branchCode   + Environment.NewLine +
                "ยอดซื้อ: " + amount       + Environment.NewLine +
                "QR หมดอายุ: " + expires;
        }

        private static string BuildQrImageUrl(string payload)
        {
            string encoded = Uri.EscapeDataString(payload ?? string.Empty);
            // api.qrserver.com — requires internet; the raw code below is shown as fallback.
            return "https://api.qrserver.com/v1/create-qr-code/?size=240x240&ecc=M&data=" + encoded;
        }
    }
}
