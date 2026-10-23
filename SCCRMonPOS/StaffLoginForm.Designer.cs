namespace SCCRMonPOS
{
    partial class StaffLoginForm
    {
        private System.ComponentModel.IContainer components = null;

        protected override void Dispose(bool disposing)
        {
            if (disposing && (components != null))
                components.Dispose();
            base.Dispose(disposing);
        }

        private void InitializeComponent()
        {
            this.lblTitle      = new System.Windows.Forms.Label();
            this.lblDevice     = new System.Windows.Forms.Label();
            this.lblPinCaption = new System.Windows.Forms.Label();
            this._txtPin       = new System.Windows.Forms.TextBox();
            this._lblError     = new System.Windows.Forms.Label();
            this._btnLogin     = new System.Windows.Forms.Button();
            this._btnCancel    = new System.Windows.Forms.Button();
            this.SuspendLayout();
            //
            // lblTitle
            //
            this.lblTitle.AutoSize = true;
            this.lblTitle.Font     = new System.Drawing.Font("Tahoma", 10F, System.Drawing.FontStyle.Bold);
            this.lblTitle.Location = new System.Drawing.Point(20, 20);
            this.lblTitle.Name     = "lblTitle";
            this.lblTitle.Text     = "กรุณากรอกรหัส PIN พนักงาน";
            //
            // lblDevice
            //
            this.lblDevice.AutoSize  = true;
            this.lblDevice.ForeColor = System.Drawing.Color.Gray;
            this.lblDevice.Location  = new System.Drawing.Point(20, 48);
            this.lblDevice.Name      = "lblDevice";
            this.lblDevice.Text      = "Device: ";
            //
            // lblPinCaption
            //
            this.lblPinCaption.AutoSize = true;
            this.lblPinCaption.Location = new System.Drawing.Point(20, 82);
            this.lblPinCaption.Name     = "lblPinCaption";
            this.lblPinCaption.Text     = "PIN :";
            //
            // _txtPin
            //
            this._txtPin.Location     = new System.Drawing.Point(70, 79);
            this._txtPin.MaxLength    = 20;
            this._txtPin.Name         = "_txtPin";
            this._txtPin.PasswordChar = '●';
            this._txtPin.Size         = new System.Drawing.Size(160, 23);
            //
            // _lblError
            //
            this._lblError.ForeColor = System.Drawing.Color.Crimson;
            this._lblError.Location  = new System.Drawing.Point(20, 112);
            this._lblError.Name      = "_lblError";
            this._lblError.Size      = new System.Drawing.Size(300, 18);
            this._lblError.Text      = "";
            //
            // _btnLogin
            //
            this._btnLogin.BackColor                    = System.Drawing.Color.FromArgb(0, 120, 215);
            this._btnLogin.FlatStyle                    = System.Windows.Forms.FlatStyle.Flat;
            this._btnLogin.FlatAppearance.BorderSize    = 0;
            this._btnLogin.ForeColor                    = System.Drawing.Color.White;
            this._btnLogin.Location                     = new System.Drawing.Point(140, 145);
            this._btnLogin.Name                         = "_btnLogin";
            this._btnLogin.Size                         = new System.Drawing.Size(90, 30);
            this._btnLogin.Text                         = "เข้าสู่ระบบ";
            this._btnLogin.UseVisualStyleBackColor      = false;
            //
            // _btnCancel
            //
            this._btnCancel.Location                = new System.Drawing.Point(238, 145);
            this._btnCancel.Name                    = "_btnCancel";
            this._btnCancel.Size                    = new System.Drawing.Size(78, 30);
            this._btnCancel.Text                    = "ยกเลิก";
            this._btnCancel.UseVisualStyleBackColor = true;
            //
            // StaffLoginForm
            //
            this.BackColor       = System.Drawing.Color.White;
            this.ClientSize      = new System.Drawing.Size(340, 190);
            this.Controls.Add(this.lblTitle);
            this.Controls.Add(this.lblDevice);
            this.Controls.Add(this.lblPinCaption);
            this.Controls.Add(this._txtPin);
            this.Controls.Add(this._lblError);
            this.Controls.Add(this._btnLogin);
            this.Controls.Add(this._btnCancel);
            this.Font            = new System.Drawing.Font("Tahoma", 9.5F);
            this.FormBorderStyle = System.Windows.Forms.FormBorderStyle.FixedDialog;
            this.MaximizeBox     = false;
            this.MinimizeBox     = false;
            this.Name            = "StaffLoginForm";
            this.StartPosition   = System.Windows.Forms.FormStartPosition.CenterScreen;
            this.Text            = "SCCRM — ยืนยันตัวตนพนักงาน";
            this.TopMost         = true;
            this.ResumeLayout(false);
            this.PerformLayout();
        }

        private System.Windows.Forms.Label   lblTitle;
        private System.Windows.Forms.Label   lblDevice;
        private System.Windows.Forms.Label   lblPinCaption;
        private System.Windows.Forms.TextBox _txtPin;
        private System.Windows.Forms.Label   _lblError;
        private System.Windows.Forms.Button  _btnLogin;
        private System.Windows.Forms.Button  _btnCancel;
    }
}
