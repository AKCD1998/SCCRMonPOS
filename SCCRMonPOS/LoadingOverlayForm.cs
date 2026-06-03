using System;
using System.Drawing;
using System.Globalization;
using System.Windows.Forms;
using SCCRMonPOS.Models;

namespace SCCRMonPOS
{
    /// <summary>
    /// Shown immediately on all screens when a sale is detected, while the QR token is being fetched.
    /// Replaced by ClaimQrForm once the token is ready, or closed on permanent failure.
    /// </summary>
    public sealed class LoadingOverlayForm : Form
    {
        private readonly Timer _dotTimer;
        private readonly Timer _safetyTimer;
        private Label _statusLabel;
        private int _dotCount;
        private readonly Screen _targetScreen;

        private static readonly int SafetyCloseSeconds = 180; // close if QR never arrives

        public LoadingOverlayForm(PosReceipt receipt, Screen targetScreen = null)
        {
            _targetScreen = targetScreen ?? Screen.PrimaryScreen;
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
                Text      = "กำลังสร้าง QR — โปรดรอสักครู่",
                AutoSize  = false,
                TextAlign = ContentAlignment.MiddleCenter,
                ForeColor = Color.FromArgb(70, 70, 70),
                Bounds    = new Rectangle(20, 54, 320, 28)
            };

            // ── Spinner area (matches QR box position in ClaimQrForm) ──────────
            var spinnerPanel = new Panel
            {
                Bounds    = new Rectangle(60, 90, 240, 240),
                BackColor = Color.FromArgb(245, 248, 255)
            };

            var spinnerIcon = new Label
            {
                Text      = "⏳",
                AutoSize  = false,
                TextAlign = ContentAlignment.MiddleCenter,
                Font      = new Font("Segoe UI Emoji", 48f),
                Bounds    = new Rectangle(0, 30, 240, 100)
            };

            _statusLabel = new Label
            {
                Text      = "กำลังสร้าง QR",
                AutoSize  = false,
                TextAlign = ContentAlignment.MiddleCenter,
                Font      = new Font("Tahoma", 11f),
                ForeColor = Color.FromArgb(16, 74, 132),
                Bounds    = new Rectangle(0, 140, 240, 30)
            };

            var progressBar = new ProgressBar
            {
                Style  = ProgressBarStyle.Marquee,
                Bounds = new Rectangle(20, 185, 200, 16),
                MarqueeAnimationSpeed = 30
            };

            spinnerPanel.Controls.AddRange(new Control[] { spinnerIcon, _statusLabel, progressBar });

            // ── Receipt summary ────────────────────────────────────────────────
            var receiptLabel = new Label
            {
                Text      = BuildReceiptSummary(receipt),
                AutoSize  = false,
                ForeColor = Color.FromArgb(55, 55, 55),
                Bounds    = new Rectangle(24, 342, 312, 72)
            };

            // ── Info text ─────────────────────────────────────────────────────
            var infoLabel = new Label
            {
                Text      = "ระบบกำลังเชื่อมต่อกับเซิร์ฟเวอร์ CRM...",
                AutoSize  = false,
                TextAlign = ContentAlignment.MiddleCenter,
                Font      = new Font("Tahoma", 8.5f, FontStyle.Italic),
                ForeColor = Color.FromArgb(120, 120, 120),
                Bounds    = new Rectangle(20, 430, 320, 20)
            };

            Controls.AddRange(new Control[] { title, subtitle, spinnerPanel, receiptLabel, infoLabel });

            // ── Dot animation timer ───────────────────────────────────────────
            _dotTimer = new Timer { Interval = 500 };
            _dotTimer.Tick += (s, e) =>
            {
                _dotCount = (_dotCount + 1) % 4;
                string dots = new string('.', _dotCount);
                _statusLabel.Text = "กำลังสร้าง QR" + dots;
            };
            _dotTimer.Start();

            // ── Safety close (if QR never arrives) ───────────────────────────
            _safetyTimer = new Timer { Interval = SafetyCloseSeconds * 1000 };
            _safetyTimer.Tick += (s, e) =>
            {
                _safetyTimer.Stop();
                Close();
            };
            _safetyTimer.Start();

            ResumeLayout(false);
        }

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);

            if (_targetScreen == null) return;

            Rectangle area = _targetScreen.WorkingArea;
            Location = new Point(
                area.Left + Math.Max(0, (area.Width - Width) / 2),
                area.Top + Math.Max(0, (area.Height - Height) / 2));
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                _dotTimer?.Dispose();
                _safetyTimer?.Dispose();
            }
            base.Dispose(disposing);
        }

        private static string BuildReceiptSummary(PosReceipt receipt)
        {
            string amount = receipt == null
                ? "-"
                : receipt.GrandTotal.ToString("N2", CultureInfo.InvariantCulture) + " บาท";
            string docNo      = receipt?.DocNo      ?? "-";
            string branchCode = receipt?.BranchCode ?? "-";

            return
                "ใบเสร็จ: " + docNo       + Environment.NewLine +
                "สาขา: "   + branchCode   + Environment.NewLine +
                "ยอดซื้อ: " + amount;
        }
    }
}
