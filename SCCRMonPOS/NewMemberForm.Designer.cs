namespace SCCRMonPOS
{
    partial class NewMemberForm
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
            this.lblTitle        = new System.Windows.Forms.Label();
            this.lblName         = new System.Windows.Forms.Label();
            this._txtName        = new System.Windows.Forms.TextBox();
            this.lblPhone        = new System.Windows.Forms.Label();
            this._txtPhone       = new System.Windows.Forms.TextBox();
            this.lblEmail        = new System.Windows.Forms.Label();
            this._txtEmail       = new System.Windows.Forms.TextBox();
            this.lblSex          = new System.Windows.Forms.Label();
            this._rdMale         = new System.Windows.Forms.RadioButton();
            this._rdFemale       = new System.Windows.Forms.RadioButton();
            this._rdUnspecified  = new System.Windows.Forms.RadioButton();
            this.lblDob          = new System.Windows.Forms.Label();
            this._dtpDob         = new System.Windows.Forms.DateTimePicker();
            this._chkDobUnknown  = new System.Windows.Forms.CheckBox();
            this.lblRmk          = new System.Windows.Forms.Label();
            this._txtRemark      = new System.Windows.Forms.TextBox();
            this._lblStatus      = new System.Windows.Forms.Label();
            this._btnCancel      = new System.Windows.Forms.Button();
            this._btnSave        = new System.Windows.Forms.Button();
            this.SuspendLayout();
            //
            // lblTitle
            //
            this.lblTitle.AutoSize  = false;
            this.lblTitle.Bounds    = new System.Drawing.Rectangle(20, 12, 380, 28);
            this.lblTitle.Font      = new System.Drawing.Font("Tahoma", 13F, System.Drawing.FontStyle.Bold);
            this.lblTitle.ForeColor = System.Drawing.Color.FromArgb(16, 74, 132);
            this.lblTitle.Name      = "lblTitle";
            this.lblTitle.Text      = "เพิ่มสมาชิกใหม่";
            this.lblTitle.TextAlign = System.Drawing.ContentAlignment.MiddleCenter;
            //
            // lblName
            //
            this.lblName.Bounds = new System.Drawing.Rectangle(20, 52, 140, 20);
            this.lblName.Name   = "lblName";
            this.lblName.Text   = "ชื่อ-นามสกุล *";
            //
            // _txtName
            //
            this._txtName.Bounds    = new System.Drawing.Rectangle(20, 72, 380, 24);
            this._txtName.MaxLength = 200;
            this._txtName.Name      = "_txtName";
            //
            // lblPhone
            //
            this.lblPhone.Bounds = new System.Drawing.Rectangle(20, 106, 140, 20);
            this.lblPhone.Name   = "lblPhone";
            this.lblPhone.Text   = "เบอร์โทรศัพท์ *";
            //
            // _txtPhone
            //
            this._txtPhone.Bounds    = new System.Drawing.Rectangle(20, 126, 200, 24);
            this._txtPhone.MaxLength = 20;
            this._txtPhone.Name      = "_txtPhone";
            //
            // lblEmail
            //
            this.lblEmail.Bounds = new System.Drawing.Rectangle(20, 160, 80, 20);
            this.lblEmail.Name   = "lblEmail";
            this.lblEmail.Text   = "อีเมล";
            //
            // _txtEmail
            //
            this._txtEmail.Bounds    = new System.Drawing.Rectangle(20, 180, 380, 24);
            this._txtEmail.MaxLength = 100;
            this._txtEmail.Name      = "_txtEmail";
            //
            // lblSex
            //
            this.lblSex.Bounds = new System.Drawing.Rectangle(20, 214, 60, 20);
            this.lblSex.Name   = "lblSex";
            this.lblSex.Text   = "เพศ";
            //
            // _rdMale
            //
            this._rdMale.Bounds  = new System.Drawing.Rectangle(20, 234, 70, 22);
            this._rdMale.Checked = true;
            this._rdMale.Name    = "_rdMale";
            this._rdMale.Text    = "ชาย";
            //
            // _rdFemale
            //
            this._rdFemale.Bounds = new System.Drawing.Rectangle(94, 234, 70, 22);
            this._rdFemale.Name   = "_rdFemale";
            this._rdFemale.Text   = "หญิง";
            //
            // _rdUnspecified
            //
            this._rdUnspecified.Bounds = new System.Drawing.Rectangle(168, 234, 80, 22);
            this._rdUnspecified.Name   = "_rdUnspecified";
            this._rdUnspecified.Text   = "ไม่ระบุ";
            //
            // lblDob
            //
            this.lblDob.Bounds = new System.Drawing.Rectangle(20, 266, 80, 20);
            this.lblDob.Name   = "lblDob";
            this.lblDob.Text   = "วันเกิด";
            //
            // _dtpDob
            //
            this._dtpDob.Bounds  = new System.Drawing.Rectangle(20, 286, 200, 24);
            this._dtpDob.Enabled = false;
            this._dtpDob.Format  = System.Windows.Forms.DateTimePickerFormat.Short;
            this._dtpDob.Name    = "_dtpDob";
            this._dtpDob.Value   = new System.DateTime(2000, 1, 1);
            //
            // _chkDobUnknown
            //
            this._chkDobUnknown.Bounds  = new System.Drawing.Rectangle(230, 287, 80, 22);
            this._chkDobUnknown.Checked = true;
            this._chkDobUnknown.CheckState = System.Windows.Forms.CheckState.Checked;
            this._chkDobUnknown.Name    = "_chkDobUnknown";
            this._chkDobUnknown.Text    = "ไม่ทราบ";
            //
            // lblRmk
            //
            this.lblRmk.Bounds = new System.Drawing.Rectangle(20, 320, 100, 20);
            this.lblRmk.Name   = "lblRmk";
            this.lblRmk.Text   = "หมายเหตุ";
            //
            // _txtRemark
            //
            this._txtRemark.Bounds    = new System.Drawing.Rectangle(20, 340, 380, 22);
            this._txtRemark.MaxLength = 200;
            this._txtRemark.Name      = "_txtRemark";
            //
            // _lblStatus
            //
            this._lblStatus.AutoSize  = false;
            this._lblStatus.Bounds    = new System.Drawing.Rectangle(20, 374, 380, 22);
            this._lblStatus.Font      = new System.Drawing.Font("Tahoma", 9F);
            this._lblStatus.ForeColor = System.Drawing.Color.FromArgb(120, 120, 120);
            this._lblStatus.Name      = "_lblStatus";
            this._lblStatus.Text      = "* จำเป็นต้องกรอก";
            this._lblStatus.TextAlign = System.Drawing.ContentAlignment.MiddleCenter;
            //
            // _btnCancel
            //
            this._btnCancel.Bounds                = new System.Drawing.Rectangle(20, 406, 100, 32);
            this._btnCancel.Name                  = "_btnCancel";
            this._btnCancel.Text                  = "ยกเลิก";
            this._btnCancel.UseVisualStyleBackColor = true;
            //
            // _btnSave
            //
            this._btnSave.BackColor               = System.Drawing.Color.FromArgb(16, 74, 132);
            this._btnSave.Bounds                  = new System.Drawing.Rectangle(256, 406, 148, 32);
            this._btnSave.FlatStyle               = System.Windows.Forms.FlatStyle.Flat;
            this._btnSave.FlatAppearance.BorderSize = 0;
            this._btnSave.ForeColor               = System.Drawing.Color.White;
            this._btnSave.Name                    = "_btnSave";
            this._btnSave.Text                    = "บันทึกสมาชิก";
            this._btnSave.UseVisualStyleBackColor = false;
            //
            // NewMemberForm
            //
            this.AcceptButton    = this._btnSave;
            this.BackColor       = System.Drawing.Color.White;
            this.CancelButton    = this._btnCancel;
            this.ClientSize      = new System.Drawing.Size(420, 490);
            this.Controls.Add(this.lblTitle);
            this.Controls.Add(this.lblName);
            this.Controls.Add(this._txtName);
            this.Controls.Add(this.lblPhone);
            this.Controls.Add(this._txtPhone);
            this.Controls.Add(this.lblEmail);
            this.Controls.Add(this._txtEmail);
            this.Controls.Add(this.lblSex);
            this.Controls.Add(this._rdMale);
            this.Controls.Add(this._rdFemale);
            this.Controls.Add(this._rdUnspecified);
            this.Controls.Add(this.lblDob);
            this.Controls.Add(this._dtpDob);
            this.Controls.Add(this._chkDobUnknown);
            this.Controls.Add(this.lblRmk);
            this.Controls.Add(this._txtRemark);
            this.Controls.Add(this._lblStatus);
            this.Controls.Add(this._btnCancel);
            this.Controls.Add(this._btnSave);
            this.Font            = new System.Drawing.Font("Tahoma", 9.5F);
            this.FormBorderStyle = System.Windows.Forms.FormBorderStyle.FixedDialog;
            this.MaximizeBox     = false;
            this.MinimizeBox     = false;
            this.Name            = "NewMemberForm";
            this.ShowInTaskbar   = false;
            this.StartPosition   = System.Windows.Forms.FormStartPosition.CenterParent;
            this.Text            = "SCCRM — เพิ่มสมาชิกใหม่";
            this.TopMost         = true;
            this.ResumeLayout(false);
        }

        private System.Windows.Forms.Label          lblTitle;
        private System.Windows.Forms.Label          lblName;
        private System.Windows.Forms.TextBox        _txtName;
        private System.Windows.Forms.Label          lblPhone;
        private System.Windows.Forms.TextBox        _txtPhone;
        private System.Windows.Forms.Label          lblEmail;
        private System.Windows.Forms.TextBox        _txtEmail;
        private System.Windows.Forms.Label          lblSex;
        private System.Windows.Forms.RadioButton    _rdMale;
        private System.Windows.Forms.RadioButton    _rdFemale;
        private System.Windows.Forms.RadioButton    _rdUnspecified;
        private System.Windows.Forms.Label          lblDob;
        private System.Windows.Forms.DateTimePicker _dtpDob;
        private System.Windows.Forms.CheckBox       _chkDobUnknown;
        private System.Windows.Forms.Label          lblRmk;
        private System.Windows.Forms.TextBox        _txtRemark;
        private System.Windows.Forms.Label          _lblStatus;
        private System.Windows.Forms.Button         _btnCancel;
        private System.Windows.Forms.Button         _btnSave;
    }
}
