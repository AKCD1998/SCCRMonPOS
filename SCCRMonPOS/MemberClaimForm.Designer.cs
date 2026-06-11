namespace SCCRMonPOS
{
    partial class MemberClaimForm
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
            this.components = new System.ComponentModel.Container();
            System.Windows.Forms.DataGridViewCellStyle dataGridViewCellStyle5 = new System.Windows.Forms.DataGridViewCellStyle();
            System.Windows.Forms.DataGridViewCellStyle dataGridViewCellStyle6 = new System.Windows.Forms.DataGridViewCellStyle();
            this._lblTitle = new System.Windows.Forms.Label();
            this._navPanel = new System.Windows.Forms.Panel();
            this._btnTabClaim = new System.Windows.Forms.Button();
            this._btnTabHistory = new System.Windows.Forms.Button();
            this._btnTabMembers = new System.Windows.Forms.Button();
            this._btnTabReports = new System.Windows.Forms.Button();
            this._btnTabExtra = new System.Windows.Forms.Button();
            this._lblSectionReceipt = new System.Windows.Forms.Label();
            this._txtReceiptNo = new System.Windows.Forms.TextBox();
            this._btnLoadReceipt = new System.Windows.Forms.Button();
            this._lblSectionItems = new System.Windows.Forms.Label();
            this._itemsHost = new System.Windows.Forms.Panel();
            this._lvItems = new System.Windows.Forms.ListView();
            this._lvItemsRowSizer = new System.Windows.Forms.ImageList(this.components);
            this._lblItemsEmpty = new System.Windows.Forms.Label();
            this._lblTotal = new System.Windows.Forms.Label();
            this._lblPreviewPoints = new System.Windows.Forms.Label();
            this._pnlDivider = new System.Windows.Forms.Panel();
            this._lblSectionSearch = new System.Windows.Forms.Label();
            this._txtMemberSearch = new System.Windows.Forms.TextBox();
            this._btnSearch = new System.Windows.Forms.Button();
            this._btnNewMember = new System.Windows.Forms.Button();
            this._membersHost = new System.Windows.Forms.Panel();
            this._dgvResults = new System.Windows.Forms.DataGridView();
            this.Id = new System.Windows.Forms.DataGridViewTextBoxColumn();
            this.MemberCode = new System.Windows.Forms.DataGridViewTextBoxColumn();
            this.DisplayName = new System.Windows.Forms.DataGridViewTextBoxColumn();
            this.Phone = new System.Windows.Forms.DataGridViewTextBoxColumn();
            this.Points = new System.Windows.Forms.DataGridViewTextBoxColumn();
            this._lblMembersEmpty = new System.Windows.Forms.Label();
            this._pnlMemberSummary = new System.Windows.Forms.Panel();
            this._lblMemberName = new System.Windows.Forms.Label();
            this._lblMemberPoints = new System.Windows.Forms.Label();
            this._btnEditMember = new System.Windows.Forms.Button();
            this._lblStatus = new System.Windows.Forms.Label();
            this._btnCancel = new System.Windows.Forms.Button();
            this._btnConfirm = new System.Windows.Forms.Button();
            this._extraMenu = new System.Windows.Forms.ContextMenuStrip(this.components);
            this._navPanel.SuspendLayout();
            this._itemsHost.SuspendLayout();
            this._membersHost.SuspendLayout();
            ((System.ComponentModel.ISupportInitialize)(this._dgvResults)).BeginInit();
            this._pnlMemberSummary.SuspendLayout();
            this.SuspendLayout();
            // 
            // _lblTitle
            // 
            this._lblTitle.Anchor = ((System.Windows.Forms.AnchorStyles)(((System.Windows.Forms.AnchorStyles.Top | System.Windows.Forms.AnchorStyles.Left) 
            | System.Windows.Forms.AnchorStyles.Right)));
            this._lblTitle.Font = new System.Drawing.Font("Tahoma", 15F, System.Drawing.FontStyle.Bold);
            this._lblTitle.ForeColor = System.Drawing.Color.FromArgb(((int)(((byte)(18)))), ((int)(((byte)(92)))), ((int)(((byte)(191)))));
            this._lblTitle.Location = new System.Drawing.Point(16, 14);
            this._lblTitle.Name = "_lblTitle";
            this._lblTitle.Size = new System.Drawing.Size(455, 30);
            this._lblTitle.TabIndex = 1;
            this._lblTitle.Text = "สะสมแต้ม CRM";
            this._lblTitle.TextAlign = System.Drawing.ContentAlignment.MiddleCenter;
            // 
            // _navPanel
            // 
            this._navPanel.Anchor = ((System.Windows.Forms.AnchorStyles)(((System.Windows.Forms.AnchorStyles.Top | System.Windows.Forms.AnchorStyles.Left) 
            | System.Windows.Forms.AnchorStyles.Right)));
            this._navPanel.BackColor = System.Drawing.Color.White;
            this._navPanel.Controls.Add(this._btnTabClaim);
            this._navPanel.Controls.Add(this._btnTabHistory);
            this._navPanel.Controls.Add(this._btnTabMembers);
            this._navPanel.Controls.Add(this._btnTabReports);
            this._navPanel.Controls.Add(this._btnTabExtra);
            this._navPanel.Location = new System.Drawing.Point(16, 50);
            this._navPanel.Name = "_navPanel";
            this._navPanel.Size = new System.Drawing.Size(455, 34);
            this._navPanel.TabIndex = 2;
            // 
            // _btnTabClaim
            // 
            this._btnTabClaim.BackColor = System.Drawing.Color.White;
            this._btnTabClaim.FlatAppearance.BorderColor = System.Drawing.Color.FromArgb(((int)(((byte)(220)))), ((int)(((byte)(225)))), ((int)(((byte)(232)))));
            this._btnTabClaim.FlatAppearance.MouseDownBackColor = System.Drawing.Color.White;
            this._btnTabClaim.FlatAppearance.MouseOverBackColor = System.Drawing.Color.White;
            this._btnTabClaim.FlatStyle = System.Windows.Forms.FlatStyle.Flat;
            this._btnTabClaim.Font = new System.Drawing.Font("Tahoma", 8F, System.Drawing.FontStyle.Bold);
            this._btnTabClaim.ForeColor = System.Drawing.Color.FromArgb(((int)(((byte)(40)))), ((int)(((byte)(40)))), ((int)(((byte)(40)))));
            this._btnTabClaim.Location = new System.Drawing.Point(4, 0);
            this._btnTabClaim.Name = "_btnTabClaim";
            this._btnTabClaim.Size = new System.Drawing.Size(122, 34);
            this._btnTabClaim.TabIndex = 0;
            this._btnTabClaim.Text = "บันทึกสะสมแต้ม";
            this._btnTabClaim.UseVisualStyleBackColor = false;
            // 
            // _btnTabHistory
            // 
            this._btnTabHistory.BackColor = System.Drawing.Color.FromArgb(((int)(((byte)(249)))), ((int)(((byte)(251)))), ((int)(((byte)(254)))));
            this._btnTabHistory.FlatAppearance.BorderColor = System.Drawing.Color.FromArgb(((int)(((byte)(220)))), ((int)(((byte)(225)))), ((int)(((byte)(232)))));
            this._btnTabHistory.FlatAppearance.MouseDownBackColor = System.Drawing.Color.FromArgb(((int)(((byte)(249)))), ((int)(((byte)(251)))), ((int)(((byte)(254)))));
            this._btnTabHistory.FlatAppearance.MouseOverBackColor = System.Drawing.Color.FromArgb(((int)(((byte)(249)))), ((int)(((byte)(251)))), ((int)(((byte)(254)))));
            this._btnTabHistory.FlatStyle = System.Windows.Forms.FlatStyle.Flat;
            this._btnTabHistory.Font = new System.Drawing.Font("Tahoma", 8F);
            this._btnTabHistory.ForeColor = System.Drawing.Color.FromArgb(((int)(((byte)(90)))), ((int)(((byte)(98)))), ((int)(((byte)(110)))));
            this._btnTabHistory.Location = new System.Drawing.Point(125, 0);
            this._btnTabHistory.Name = "_btnTabHistory";
            this._btnTabHistory.Size = new System.Drawing.Size(99, 34);
            this._btnTabHistory.TabIndex = 1;
            this._btnTabHistory.Text = "ประวัติการสะสม";
            this._btnTabHistory.UseVisualStyleBackColor = false;
            // 
            // _btnTabMembers
            // 
            this._btnTabMembers.BackColor = System.Drawing.Color.FromArgb(((int)(((byte)(249)))), ((int)(((byte)(251)))), ((int)(((byte)(254)))));
            this._btnTabMembers.FlatAppearance.BorderColor = System.Drawing.Color.FromArgb(((int)(((byte)(220)))), ((int)(((byte)(225)))), ((int)(((byte)(232)))));
            this._btnTabMembers.FlatAppearance.MouseDownBackColor = System.Drawing.Color.FromArgb(((int)(((byte)(249)))), ((int)(((byte)(251)))), ((int)(((byte)(254)))));
            this._btnTabMembers.FlatAppearance.MouseOverBackColor = System.Drawing.Color.FromArgb(((int)(((byte)(249)))), ((int)(((byte)(251)))), ((int)(((byte)(254)))));
            this._btnTabMembers.FlatStyle = System.Windows.Forms.FlatStyle.Flat;
            this._btnTabMembers.Font = new System.Drawing.Font("Tahoma", 8F);
            this._btnTabMembers.ForeColor = System.Drawing.Color.FromArgb(((int)(((byte)(90)))), ((int)(((byte)(98)))), ((int)(((byte)(110)))));
            this._btnTabMembers.Location = new System.Drawing.Point(223, 0);
            this._btnTabMembers.Name = "_btnTabMembers";
            this._btnTabMembers.Size = new System.Drawing.Size(58, 34);
            this._btnTabMembers.TabIndex = 2;
            this._btnTabMembers.Text = "สมาชิก";
            this._btnTabMembers.UseVisualStyleBackColor = false;
            // 
            // _btnTabReports
            // 
            this._btnTabReports.BackColor = System.Drawing.Color.FromArgb(((int)(((byte)(249)))), ((int)(((byte)(251)))), ((int)(((byte)(254)))));
            this._btnTabReports.FlatAppearance.BorderColor = System.Drawing.Color.FromArgb(((int)(((byte)(220)))), ((int)(((byte)(225)))), ((int)(((byte)(232)))));
            this._btnTabReports.FlatAppearance.MouseDownBackColor = System.Drawing.Color.FromArgb(((int)(((byte)(249)))), ((int)(((byte)(251)))), ((int)(((byte)(254)))));
            this._btnTabReports.FlatAppearance.MouseOverBackColor = System.Drawing.Color.FromArgb(((int)(((byte)(249)))), ((int)(((byte)(251)))), ((int)(((byte)(254)))));
            this._btnTabReports.FlatStyle = System.Windows.Forms.FlatStyle.Flat;
            this._btnTabReports.Font = new System.Drawing.Font("Tahoma", 8F);
            this._btnTabReports.ForeColor = System.Drawing.Color.FromArgb(((int)(((byte)(90)))), ((int)(((byte)(98)))), ((int)(((byte)(110)))));
            this._btnTabReports.Location = new System.Drawing.Point(280, 0);
            this._btnTabReports.Name = "_btnTabReports";
            this._btnTabReports.Size = new System.Drawing.Size(60, 34);
            this._btnTabReports.TabIndex = 3;
            this._btnTabReports.Text = "รายงาน";
            this._btnTabReports.UseVisualStyleBackColor = false;
            // 
            // _btnTabExtra
            // 
            this._btnTabExtra.BackColor = System.Drawing.Color.FromArgb(((int)(((byte)(18)))), ((int)(((byte)(92)))), ((int)(((byte)(191)))));
            this._btnTabExtra.FlatAppearance.BorderColor = System.Drawing.Color.FromArgb(((int)(((byte)(18)))), ((int)(((byte)(92)))), ((int)(((byte)(191)))));
            this._btnTabExtra.FlatAppearance.MouseDownBackColor = System.Drawing.Color.FromArgb(((int)(((byte)(18)))), ((int)(((byte)(92)))), ((int)(((byte)(191)))));
            this._btnTabExtra.FlatAppearance.MouseOverBackColor = System.Drawing.Color.FromArgb(((int)(((byte)(18)))), ((int)(((byte)(92)))), ((int)(((byte)(191)))));
            this._btnTabExtra.FlatStyle = System.Windows.Forms.FlatStyle.Flat;
            this._btnTabExtra.Font = new System.Drawing.Font("Tahoma", 8F);
            this._btnTabExtra.ForeColor = System.Drawing.Color.White;
            this._btnTabExtra.Location = new System.Drawing.Point(340, 0);
            this._btnTabExtra.Name = "_btnTabExtra";
            this._btnTabExtra.Size = new System.Drawing.Size(111, 34);
            this._btnTabExtra.TabIndex = 4;
            this._btnTabExtra.Text = "เมนูเพิ่มเติม";
            this._btnTabExtra.UseVisualStyleBackColor = false;
            // 
            // _lblSectionReceipt
            // 
            this._lblSectionReceipt.Font = new System.Drawing.Font("Tahoma", 11F, System.Drawing.FontStyle.Bold);
            this._lblSectionReceipt.ForeColor = System.Drawing.Color.FromArgb(((int)(((byte)(40)))), ((int)(((byte)(40)))), ((int)(((byte)(40)))));
            this._lblSectionReceipt.Location = new System.Drawing.Point(16, 96);
            this._lblSectionReceipt.Name = "_lblSectionReceipt";
            this._lblSectionReceipt.Size = new System.Drawing.Size(100, 22);
            this._lblSectionReceipt.TabIndex = 3;
            this._lblSectionReceipt.Text = "เลขที่ใบเสร็จ";
            // 
            // _txtReceiptNo
            // 
            this._txtReceiptNo.Anchor = ((System.Windows.Forms.AnchorStyles)(((System.Windows.Forms.AnchorStyles.Top | System.Windows.Forms.AnchorStyles.Left) 
            | System.Windows.Forms.AnchorStyles.Right)));
            this._txtReceiptNo.BorderStyle = System.Windows.Forms.BorderStyle.FixedSingle;
            this._txtReceiptNo.Font = new System.Drawing.Font("Tahoma", 10F);
            this._txtReceiptNo.Location = new System.Drawing.Point(124, 94);
            this._txtReceiptNo.Name = "_txtReceiptNo";
            this._txtReceiptNo.Size = new System.Drawing.Size(241, 24);
            this._txtReceiptNo.TabIndex = 4;
            // 
            // _btnLoadReceipt
            // 
            this._btnLoadReceipt.Anchor = ((System.Windows.Forms.AnchorStyles)((System.Windows.Forms.AnchorStyles.Top | System.Windows.Forms.AnchorStyles.Right)));
            this._btnLoadReceipt.BackColor = System.Drawing.Color.White;
            this._btnLoadReceipt.FlatAppearance.BorderColor = System.Drawing.Color.FromArgb(((int)(((byte)(200)))), ((int)(((byte)(208)))), ((int)(((byte)(220)))));
            this._btnLoadReceipt.FlatStyle = System.Windows.Forms.FlatStyle.Flat;
            this._btnLoadReceipt.Font = new System.Drawing.Font("Tahoma", 9F);
            this._btnLoadReceipt.Location = new System.Drawing.Point(379, 93);
            this._btnLoadReceipt.Name = "_btnLoadReceipt";
            this._btnLoadReceipt.Size = new System.Drawing.Size(88, 28);
            this._btnLoadReceipt.TabIndex = 5;
            this._btnLoadReceipt.Text = "โหลด";
            this._btnLoadReceipt.UseVisualStyleBackColor = false;
            // 
            // _lblSectionItems
            // 
            this._lblSectionItems.Font = new System.Drawing.Font("Tahoma", 11F, System.Drawing.FontStyle.Bold);
            this._lblSectionItems.ForeColor = System.Drawing.Color.FromArgb(((int)(((byte)(40)))), ((int)(((byte)(40)))), ((int)(((byte)(40)))));
            this._lblSectionItems.Location = new System.Drawing.Point(16, 124);
            this._lblSectionItems.Name = "_lblSectionItems";
            this._lblSectionItems.Size = new System.Drawing.Size(420, 22);
            this._lblSectionItems.TabIndex = 6;
            this._lblSectionItems.Text = "รายการสินค้า";
            // 
            // _itemsHost
            // 
            this._itemsHost.Anchor = ((System.Windows.Forms.AnchorStyles)(((System.Windows.Forms.AnchorStyles.Top | System.Windows.Forms.AnchorStyles.Left) 
            | System.Windows.Forms.AnchorStyles.Right)));
            this._itemsHost.BackColor = System.Drawing.Color.White;
            this._itemsHost.BorderStyle = System.Windows.Forms.BorderStyle.FixedSingle;
            this._itemsHost.Controls.Add(this._lvItems);
            this._itemsHost.Controls.Add(this._lblItemsEmpty);
            this._itemsHost.Location = new System.Drawing.Point(16, 149);
            this._itemsHost.Name = "_itemsHost";
            this._itemsHost.Size = new System.Drawing.Size(455, 96);
            this._itemsHost.TabIndex = 7;
            // 
            // _lvItems
            // 
            this._lvItems.BorderStyle = System.Windows.Forms.BorderStyle.None;
            this._lvItems.Font = new System.Drawing.Font("Tahoma", 7.5F);
            this._lvItems.FullRowSelect = true;
            this._lvItems.GridLines = true;
            this._lvItems.HeaderStyle = System.Windows.Forms.ColumnHeaderStyle.Nonclickable;
            this._lvItems.HideSelection = false;
            this._lvItems.Location = new System.Drawing.Point(2, -1);
            this._lvItems.MultiSelect = false;
            this._lvItems.Name = "_lvItems";
            this._lvItems.Size = new System.Drawing.Size(452, 77);
            this._lvItems.SmallImageList = this._lvItemsRowSizer;
            this._lvItems.TabIndex = 0;
            this._lvItems.UseCompatibleStateImageBehavior = false;
            this._lvItems.View = System.Windows.Forms.View.Details;
            this._lvItems.SelectedIndexChanged += new System.EventHandler(this._lvItems_SelectedIndexChanged);
            // 
            // _lvItemsRowSizer
            // 
            this._lvItemsRowSizer.ColorDepth = System.Windows.Forms.ColorDepth.Depth8Bit;
            this._lvItemsRowSizer.ImageSize = new System.Drawing.Size(1, 14);
            this._lvItemsRowSizer.TransparentColor = System.Drawing.Color.Transparent;
            // 
            // _lblItemsEmpty
            // 
            this._lblItemsEmpty.BackColor = System.Drawing.Color.Transparent;
            this._lblItemsEmpty.Font = new System.Drawing.Font("Tahoma", 8.5F);
            this._lblItemsEmpty.ForeColor = System.Drawing.Color.FromArgb(((int)(((byte)(160)))), ((int)(((byte)(167)))), ((int)(((byte)(180)))));
            this._lblItemsEmpty.Location = new System.Drawing.Point(0, 22);
            this._lblItemsEmpty.Name = "_lblItemsEmpty";
            this._lblItemsEmpty.Size = new System.Drawing.Size(438, 18);
            this._lblItemsEmpty.TabIndex = 1;
            this._lblItemsEmpty.Text = "ยังไม่มีข้อมูลสินค้า";
            this._lblItemsEmpty.TextAlign = System.Drawing.ContentAlignment.MiddleCenter;
            // 
            // _lblTotal
            // 
            this._lblTotal.Anchor = ((System.Windows.Forms.AnchorStyles)((System.Windows.Forms.AnchorStyles.Top | System.Windows.Forms.AnchorStyles.Right)));
            this._lblTotal.Font = new System.Drawing.Font("Tahoma", 10.5F, System.Drawing.FontStyle.Bold);
            this._lblTotal.ForeColor = System.Drawing.Color.FromArgb(((int)(((byte)(32)))), ((int)(((byte)(32)))), ((int)(((byte)(32)))));
            this._lblTotal.Location = new System.Drawing.Point(13, 268);
            this._lblTotal.Name = "_lblTotal";
            this._lblTotal.Size = new System.Drawing.Size(84, 18);
            this._lblTotal.TabIndex = 8;
            this._lblTotal.Text = "ยอดรวม: -";
            this._lblTotal.TextAlign = System.Drawing.ContentAlignment.MiddleRight;
            // 
            // _lblPreviewPoints
            // 
            this._lblPreviewPoints.Anchor = ((System.Windows.Forms.AnchorStyles)((System.Windows.Forms.AnchorStyles.Top | System.Windows.Forms.AnchorStyles.Right)));
            this._lblPreviewPoints.Font = new System.Drawing.Font("Tahoma", 10.5F, System.Drawing.FontStyle.Bold);
            this._lblPreviewPoints.ForeColor = System.Drawing.Color.FromArgb(((int)(((byte)(24)))), ((int)(((byte)(140)))), ((int)(((byte)(52)))));
            this._lblPreviewPoints.Location = new System.Drawing.Point(316, 268);
            this._lblPreviewPoints.Name = "_lblPreviewPoints";
            this._lblPreviewPoints.Size = new System.Drawing.Size(155, 18);
            this._lblPreviewPoints.TabIndex = 9;
            this._lblPreviewPoints.Text = "แต้มที่จะได้รับ: -";
            this._lblPreviewPoints.TextAlign = System.Drawing.ContentAlignment.MiddleRight;
            // 
            // _pnlDivider
            // 
            this._pnlDivider.Anchor = ((System.Windows.Forms.AnchorStyles)(((System.Windows.Forms.AnchorStyles.Top | System.Windows.Forms.AnchorStyles.Left) 
            | System.Windows.Forms.AnchorStyles.Right)));
            this._pnlDivider.BackColor = System.Drawing.Color.FromArgb(((int)(((byte)(220)))), ((int)(((byte)(225)))), ((int)(((byte)(232)))));
            this._pnlDivider.Location = new System.Drawing.Point(16, 308);
            this._pnlDivider.Name = "_pnlDivider";
            this._pnlDivider.Size = new System.Drawing.Size(484, 1);
            this._pnlDivider.TabIndex = 10;
            // 
            // _lblSectionSearch
            // 
            this._lblSectionSearch.Font = new System.Drawing.Font("Tahoma", 11F, System.Drawing.FontStyle.Bold);
            this._lblSectionSearch.ForeColor = System.Drawing.Color.FromArgb(((int)(((byte)(40)))), ((int)(((byte)(40)))), ((int)(((byte)(40)))));
            this._lblSectionSearch.Location = new System.Drawing.Point(14, 330);
            this._lblSectionSearch.Name = "_lblSectionSearch";
            this._lblSectionSearch.Size = new System.Drawing.Size(281, 24);
            this._lblSectionSearch.TabIndex = 11;
            this._lblSectionSearch.Text = "ค้นหาสมาชิก (เบอร์โทร / ชื่อ / อีเมล)";
            // 
            // _txtMemberSearch
            // 
            this._txtMemberSearch.Anchor = ((System.Windows.Forms.AnchorStyles)(((System.Windows.Forms.AnchorStyles.Top | System.Windows.Forms.AnchorStyles.Left) 
            | System.Windows.Forms.AnchorStyles.Right)));
            this._txtMemberSearch.BorderStyle = System.Windows.Forms.BorderStyle.FixedSingle;
            this._txtMemberSearch.Font = new System.Drawing.Font("Tahoma", 9.5F);
            this._txtMemberSearch.Location = new System.Drawing.Point(16, 356);
            this._txtMemberSearch.Name = "_txtMemberSearch";
            this._txtMemberSearch.Size = new System.Drawing.Size(263, 23);
            this._txtMemberSearch.TabIndex = 12;
            // 
            // _btnSearch
            // 
            this._btnSearch.Anchor = ((System.Windows.Forms.AnchorStyles)((System.Windows.Forms.AnchorStyles.Top | System.Windows.Forms.AnchorStyles.Right)));
            this._btnSearch.BackColor = System.Drawing.Color.White;
            this._btnSearch.FlatAppearance.BorderColor = System.Drawing.Color.FromArgb(((int)(((byte)(200)))), ((int)(((byte)(208)))), ((int)(((byte)(220)))));
            this._btnSearch.FlatStyle = System.Windows.Forms.FlatStyle.Flat;
            this._btnSearch.Font = new System.Drawing.Font("Tahoma", 9F);
            this._btnSearch.Location = new System.Drawing.Point(285, 352);
            this._btnSearch.Name = "_btnSearch";
            this._btnSearch.Size = new System.Drawing.Size(80, 28);
            this._btnSearch.TabIndex = 13;
            this._btnSearch.Text = "ค้นหา";
            this._btnSearch.UseVisualStyleBackColor = false;
            // 
            // _btnNewMember
            // 
            this._btnNewMember.Anchor = ((System.Windows.Forms.AnchorStyles)((System.Windows.Forms.AnchorStyles.Top | System.Windows.Forms.AnchorStyles.Right)));
            this._btnNewMember.BackColor = System.Drawing.Color.FromArgb(((int)(((byte)(24)))), ((int)(((byte)(140)))), ((int)(((byte)(52)))));
            this._btnNewMember.FlatAppearance.BorderSize = 0;
            this._btnNewMember.FlatStyle = System.Windows.Forms.FlatStyle.Flat;
            this._btnNewMember.Font = new System.Drawing.Font("Tahoma", 9F, System.Drawing.FontStyle.Bold);
            this._btnNewMember.ForeColor = System.Drawing.Color.White;
            this._btnNewMember.Location = new System.Drawing.Point(375, 353);
            this._btnNewMember.Name = "_btnNewMember";
            this._btnNewMember.Size = new System.Drawing.Size(96, 28);
            this._btnNewMember.TabIndex = 14;
            this._btnNewMember.Text = "+ สมาชิกใหม่";
            this._btnNewMember.UseVisualStyleBackColor = false;
            // 
            // _membersHost
            // 
            this._membersHost.Anchor = ((System.Windows.Forms.AnchorStyles)((((System.Windows.Forms.AnchorStyles.Top | System.Windows.Forms.AnchorStyles.Bottom) 
            | System.Windows.Forms.AnchorStyles.Left) 
            | System.Windows.Forms.AnchorStyles.Right)));
            this._membersHost.BackColor = System.Drawing.Color.White;
            this._membersHost.BorderStyle = System.Windows.Forms.BorderStyle.FixedSingle;
            this._membersHost.Controls.Add(this._dgvResults);
            this._membersHost.Controls.Add(this._lblMembersEmpty);
            this._membersHost.Location = new System.Drawing.Point(16, 392);
            this._membersHost.Name = "_membersHost";
            this._membersHost.Size = new System.Drawing.Size(455, 84);
            this._membersHost.TabIndex = 15;
            // 
            // _dgvResults
            // 
            this._dgvResults.AllowUserToAddRows = false;
            this._dgvResults.AllowUserToDeleteRows = false;
            this._dgvResults.AllowUserToResizeRows = false;
            this._dgvResults.AutoSizeColumnsMode = System.Windows.Forms.DataGridViewAutoSizeColumnsMode.Fill;
            this._dgvResults.BackgroundColor = System.Drawing.Color.White;
            this._dgvResults.BorderStyle = System.Windows.Forms.BorderStyle.None;
            this._dgvResults.ColumnHeadersBorderStyle = System.Windows.Forms.DataGridViewHeaderBorderStyle.Single;
            dataGridViewCellStyle5.BackColor = System.Drawing.Color.White;
            dataGridViewCellStyle5.Font = new System.Drawing.Font("Tahoma", 7.5F);
            dataGridViewCellStyle5.ForeColor = System.Drawing.Color.FromArgb(((int)(((byte)(38)))), ((int)(((byte)(38)))), ((int)(((byte)(38)))));
            this._dgvResults.ColumnHeadersDefaultCellStyle = dataGridViewCellStyle5;
            this._dgvResults.ColumnHeadersHeight = 24;
            this._dgvResults.ColumnHeadersHeightSizeMode = System.Windows.Forms.DataGridViewColumnHeadersHeightSizeMode.DisableResizing;
            this._dgvResults.Columns.AddRange(new System.Windows.Forms.DataGridViewColumn[] {
            this.Id,
            this.MemberCode,
            this.DisplayName,
            this.Phone,
            this.Points});
            dataGridViewCellStyle6.Alignment = System.Windows.Forms.DataGridViewContentAlignment.MiddleLeft;
            dataGridViewCellStyle6.BackColor = System.Drawing.SystemColors.Window;
            dataGridViewCellStyle6.Font = new System.Drawing.Font("Tahoma", 7.5F);
            dataGridViewCellStyle6.ForeColor = System.Drawing.SystemColors.ControlText;
            dataGridViewCellStyle6.SelectionBackColor = System.Drawing.Color.FromArgb(((int)(((byte)(232)))), ((int)(((byte)(241)))), ((int)(((byte)(255)))));
            dataGridViewCellStyle6.SelectionForeColor = System.Drawing.Color.FromArgb(((int)(((byte)(18)))), ((int)(((byte)(92)))), ((int)(((byte)(191)))));
            dataGridViewCellStyle6.WrapMode = System.Windows.Forms.DataGridViewTriState.False;
            this._dgvResults.DefaultCellStyle = dataGridViewCellStyle6;
            this._dgvResults.EnableHeadersVisualStyles = false;
            this._dgvResults.Font = new System.Drawing.Font("Tahoma", 7.5F);
            this._dgvResults.Location = new System.Drawing.Point(-1, 0);
            this._dgvResults.MultiSelect = false;
            this._dgvResults.Name = "_dgvResults";
            this._dgvResults.ReadOnly = true;
            this._dgvResults.RowHeadersVisible = false;
            this._dgvResults.RowTemplate.Height = 18;
            this._dgvResults.SelectionMode = System.Windows.Forms.DataGridViewSelectionMode.FullRowSelect;
            this._dgvResults.Size = new System.Drawing.Size(451, 79);
            this._dgvResults.TabIndex = 0;
            this._dgvResults.CellContentClick += new System.Windows.Forms.DataGridViewCellEventHandler(this._dgvResults_CellContentClick);
            // 
            // Id
            // 
            this.Id.HeaderText = "ID";
            this.Id.Name = "Id";
            this.Id.ReadOnly = true;
            this.Id.Visible = false;
            // 
            // MemberCode
            // 
            this.MemberCode.HeaderText = "MemberCode";
            this.MemberCode.Name = "MemberCode";
            this.MemberCode.ReadOnly = true;
            this.MemberCode.Visible = false;
            // 
            // DisplayName
            // 
            this.DisplayName.FillWeight = 30F;
            this.DisplayName.HeaderText = "ชื่อสมาชิก";
            this.DisplayName.Name = "DisplayName";
            this.DisplayName.ReadOnly = true;
            // 
            // Phone
            // 
            this.Phone.FillWeight = 56F;
            this.Phone.HeaderText = "เบอร์โทร";
            this.Phone.Name = "Phone";
            this.Phone.ReadOnly = true;
            // 
            // Points
            // 
            this.Points.FillWeight = 14F;
            this.Points.HeaderText = "แต้ม";
            this.Points.Name = "Points";
            this.Points.ReadOnly = true;
            // 
            // _lblMembersEmpty
            // 
            this._lblMembersEmpty.BackColor = System.Drawing.Color.Transparent;
            this._lblMembersEmpty.Font = new System.Drawing.Font("Tahoma", 8.5F);
            this._lblMembersEmpty.ForeColor = System.Drawing.Color.FromArgb(((int)(((byte)(160)))), ((int)(((byte)(167)))), ((int)(((byte)(180)))));
            this._lblMembersEmpty.Location = new System.Drawing.Point(0, 16);
            this._lblMembersEmpty.Name = "_lblMembersEmpty";
            this._lblMembersEmpty.Size = new System.Drawing.Size(465, 18);
            this._lblMembersEmpty.TabIndex = 1;
            this._lblMembersEmpty.Text = "ยังไม่มีข้อมูลสมาชิก";
            this._lblMembersEmpty.TextAlign = System.Drawing.ContentAlignment.MiddleCenter;
            // 
            // _pnlMemberSummary
            // 
            this._pnlMemberSummary.Anchor = ((System.Windows.Forms.AnchorStyles)(((System.Windows.Forms.AnchorStyles.Bottom | System.Windows.Forms.AnchorStyles.Left) 
            | System.Windows.Forms.AnchorStyles.Right)));
            this._pnlMemberSummary.BackColor = System.Drawing.Color.FromArgb(((int)(((byte)(243)))), ((int)(((byte)(248)))), ((int)(((byte)(255)))));
            this._pnlMemberSummary.Controls.Add(this._lblMemberName);
            this._pnlMemberSummary.Controls.Add(this._lblMemberPoints);
            this._pnlMemberSummary.Controls.Add(this._btnEditMember);
            this._pnlMemberSummary.Location = new System.Drawing.Point(16, 481);
            this._pnlMemberSummary.Name = "_pnlMemberSummary";
            this._pnlMemberSummary.Size = new System.Drawing.Size(455, 32);
            this._pnlMemberSummary.TabIndex = 16;
            this._pnlMemberSummary.Visible = false;
            // 
            // _lblMemberName
            // 
            this._lblMemberName.Anchor = ((System.Windows.Forms.AnchorStyles)(((System.Windows.Forms.AnchorStyles.Top | System.Windows.Forms.AnchorStyles.Left) 
            | System.Windows.Forms.AnchorStyles.Right)));
            this._lblMemberName.Font = new System.Drawing.Font("Tahoma", 9F, System.Drawing.FontStyle.Bold);
            this._lblMemberName.ForeColor = System.Drawing.Color.FromArgb(((int)(((byte)(18)))), ((int)(((byte)(92)))), ((int)(((byte)(191)))));
            this._lblMemberName.Location = new System.Drawing.Point(10, 2);
            this._lblMemberName.Name = "_lblMemberName";
            this._lblMemberName.Size = new System.Drawing.Size(177, 16);
            this._lblMemberName.TabIndex = 0;
            // 
            // _lblMemberPoints
            // 
            this._lblMemberPoints.Anchor = ((System.Windows.Forms.AnchorStyles)(((System.Windows.Forms.AnchorStyles.Top | System.Windows.Forms.AnchorStyles.Left) 
            | System.Windows.Forms.AnchorStyles.Right)));
            this._lblMemberPoints.ForeColor = System.Drawing.Color.FromArgb(((int)(((byte)(70)))), ((int)(((byte)(70)))), ((int)(((byte)(70)))));
            this._lblMemberPoints.Location = new System.Drawing.Point(10, 17);
            this._lblMemberPoints.Name = "_lblMemberPoints";
            this._lblMemberPoints.Size = new System.Drawing.Size(177, 14);
            this._lblMemberPoints.TabIndex = 1;
            // 
            // _btnEditMember
            // 
            this._btnEditMember.Anchor = ((System.Windows.Forms.AnchorStyles)((System.Windows.Forms.AnchorStyles.Top | System.Windows.Forms.AnchorStyles.Right)));
            this._btnEditMember.BackColor = System.Drawing.Color.White;
            this._btnEditMember.FlatAppearance.BorderColor = System.Drawing.Color.FromArgb(((int)(((byte)(18)))), ((int)(((byte)(92)))), ((int)(((byte)(191)))));
            this._btnEditMember.FlatStyle = System.Windows.Forms.FlatStyle.Flat;
            this._btnEditMember.Font = new System.Drawing.Font("Tahoma", 8F);
            this._btnEditMember.ForeColor = System.Drawing.Color.FromArgb(((int)(((byte)(18)))), ((int)(((byte)(92)))), ((int)(((byte)(191)))));
            this._btnEditMember.Location = new System.Drawing.Point(311, 3);
            this._btnEditMember.Name = "_btnEditMember";
            this._btnEditMember.Size = new System.Drawing.Size(136, 26);
            this._btnEditMember.TabIndex = 2;
            this._btnEditMember.Text = "แก้ไขข้อมูลสมาชิก";
            this._btnEditMember.UseVisualStyleBackColor = false;
            this._btnEditMember.Visible = false;
            // 
            // _lblStatus
            // 
            this._lblStatus.Anchor = ((System.Windows.Forms.AnchorStyles)(((System.Windows.Forms.AnchorStyles.Bottom | System.Windows.Forms.AnchorStyles.Left) 
            | System.Windows.Forms.AnchorStyles.Right)));
            this._lblStatus.Font = new System.Drawing.Font("Tahoma", 8.5F);
            this._lblStatus.ForeColor = System.Drawing.Color.FromArgb(((int)(((byte)(180)))), ((int)(((byte)(38)))), ((int)(((byte)(38)))));
            this._lblStatus.Location = new System.Drawing.Point(16, 508);
            this._lblStatus.Name = "_lblStatus";
            this._lblStatus.Size = new System.Drawing.Size(484, 16);
            this._lblStatus.TabIndex = 17;
            this._lblStatus.TextAlign = System.Drawing.ContentAlignment.MiddleCenter;
            // 
            // _btnCancel
            // 
            this._btnCancel.Anchor = ((System.Windows.Forms.AnchorStyles)((System.Windows.Forms.AnchorStyles.Bottom | System.Windows.Forms.AnchorStyles.Left)));
            this._btnCancel.BackColor = System.Drawing.Color.White;
            this._btnCancel.FlatAppearance.BorderColor = System.Drawing.Color.FromArgb(((int)(((byte)(200)))), ((int)(((byte)(208)))), ((int)(((byte)(220)))));
            this._btnCancel.FlatStyle = System.Windows.Forms.FlatStyle.Flat;
            this._btnCancel.Font = new System.Drawing.Font("Tahoma", 9F);
            this._btnCancel.Location = new System.Drawing.Point(16, 540);
            this._btnCancel.Name = "_btnCancel";
            this._btnCancel.Size = new System.Drawing.Size(112, 28);
            this._btnCancel.TabIndex = 18;
            this._btnCancel.Text = "ยกเลิก";
            this._btnCancel.UseVisualStyleBackColor = false;
            // 
            // _btnConfirm
            // 
            this._btnConfirm.Anchor = ((System.Windows.Forms.AnchorStyles)((System.Windows.Forms.AnchorStyles.Bottom | System.Windows.Forms.AnchorStyles.Right)));
            this._btnConfirm.BackColor = System.Drawing.Color.FromArgb(((int)(((byte)(18)))), ((int)(((byte)(92)))), ((int)(((byte)(191)))));
            this._btnConfirm.Enabled = false;
            this._btnConfirm.FlatAppearance.BorderSize = 0;
            this._btnConfirm.FlatStyle = System.Windows.Forms.FlatStyle.Flat;
            this._btnConfirm.Font = new System.Drawing.Font("Tahoma", 9F, System.Drawing.FontStyle.Bold);
            this._btnConfirm.ForeColor = System.Drawing.Color.White;
            this._btnConfirm.Location = new System.Drawing.Point(283, 540);
            this._btnConfirm.Name = "_btnConfirm";
            this._btnConfirm.Size = new System.Drawing.Size(188, 28);
            this._btnConfirm.TabIndex = 19;
            this._btnConfirm.Text = "ยืนยันการสะสมแต้ม";
            this._btnConfirm.UseVisualStyleBackColor = false;
            // 
            // _extraMenu
            // 
            this._extraMenu.Name = "_extraMenu";
            this._extraMenu.Size = new System.Drawing.Size(61, 4);
            // 
            // MemberClaimForm
            // 
            this.AutoScaleDimensions = new System.Drawing.SizeF(96F, 96F);
            this.AutoScaleMode = System.Windows.Forms.AutoScaleMode.Dpi;
            this.BackColor = System.Drawing.Color.White;
            this.ClientSize = new System.Drawing.Size(516, 620);
            this.Controls.Add(this._lblTitle);
            this.Controls.Add(this._navPanel);
            this.Controls.Add(this._lblSectionReceipt);
            this.Controls.Add(this._txtReceiptNo);
            this.Controls.Add(this._btnLoadReceipt);
            this.Controls.Add(this._lblSectionItems);
            this.Controls.Add(this._itemsHost);
            this.Controls.Add(this._lblTotal);
            this.Controls.Add(this._lblPreviewPoints);
            this.Controls.Add(this._pnlDivider);
            this.Controls.Add(this._lblSectionSearch);
            this.Controls.Add(this._txtMemberSearch);
            this.Controls.Add(this._btnSearch);
            this.Controls.Add(this._btnNewMember);
            this.Controls.Add(this._membersHost);
            this.Controls.Add(this._pnlMemberSummary);
            this.Controls.Add(this._lblStatus);
            this.Controls.Add(this._btnCancel);
            this.Controls.Add(this._btnConfirm);
            this.Font = new System.Drawing.Font("Tahoma", 8.75F);
            this.MinimumSize = new System.Drawing.Size(532, 560);
            this.Name = "MemberClaimForm";
            this.ShowInTaskbar = false;
            this.StartPosition = System.Windows.Forms.FormStartPosition.CenterScreen;
            this.Text = "SCCRM - สะสมแต้ม";
            this.TopMost = true;
            this.Load += new System.EventHandler(this.MemberClaimForm_Load);
            this._navPanel.ResumeLayout(false);
            this._itemsHost.ResumeLayout(false);
            this._membersHost.ResumeLayout(false);
            ((System.ComponentModel.ISupportInitialize)(this._dgvResults)).EndInit();
            this._pnlMemberSummary.ResumeLayout(false);
            this.ResumeLayout(false);
            this.PerformLayout();

        }

        private System.Windows.Forms.Label                      _lblTitle;
        private System.Windows.Forms.Panel                      _navPanel;
        private System.Windows.Forms.Button                     _btnTabClaim;
        private System.Windows.Forms.Button                     _btnTabHistory;
        private System.Windows.Forms.Button                     _btnTabMembers;
        private System.Windows.Forms.Button                     _btnTabReports;
        private System.Windows.Forms.Button                     _btnTabExtra;
        private System.Windows.Forms.Label                      _lblSectionReceipt;
        private System.Windows.Forms.TextBox                    _txtReceiptNo;
        private System.Windows.Forms.Button                     _btnLoadReceipt;
        private System.Windows.Forms.Label                      _lblSectionItems;
        private System.Windows.Forms.Panel                      _itemsHost;
        private System.Windows.Forms.ImageList                  _lvItemsRowSizer;
        private System.Windows.Forms.ListView                   _lvItems;
        private System.Windows.Forms.Label                      _lblItemsEmpty;
        private System.Windows.Forms.Label                      _lblTotal;
        private System.Windows.Forms.Label                      _lblPreviewPoints;
        private System.Windows.Forms.Panel                      _pnlDivider;
        private System.Windows.Forms.Label                      _lblSectionSearch;
        private System.Windows.Forms.TextBox                    _txtMemberSearch;
        private System.Windows.Forms.Button                     _btnSearch;
        private System.Windows.Forms.Button                     _btnNewMember;
        private System.Windows.Forms.Panel                      _membersHost;
        private System.Windows.Forms.DataGridView               _dgvResults;
        private System.Windows.Forms.DataGridViewTextBoxColumn  _dgvColId;
        private System.Windows.Forms.DataGridViewTextBoxColumn  _dgvColMemberCode;
        private System.Windows.Forms.DataGridViewTextBoxColumn  _dgvColDisplayName;
        private System.Windows.Forms.DataGridViewTextBoxColumn  _dgvColPhone;
        private System.Windows.Forms.DataGridViewTextBoxColumn  _dgvColPoints;
        private System.Windows.Forms.Label                      _lblMembersEmpty;
        private System.Windows.Forms.Panel                      _pnlMemberSummary;
        private System.Windows.Forms.Label                      _lblMemberName;
        private System.Windows.Forms.Label                      _lblMemberPoints;
        private System.Windows.Forms.Button                     _btnEditMember;
        private System.Windows.Forms.Label                      _lblStatus;
        private System.Windows.Forms.Button                     _btnCancel;
        private System.Windows.Forms.Button                     _btnConfirm;
        private System.Windows.Forms.ContextMenuStrip           _extraMenu;
        private System.Windows.Forms.DataGridViewTextBoxColumn Id;
        private System.Windows.Forms.DataGridViewTextBoxColumn MemberCode;
        private System.Windows.Forms.DataGridViewTextBoxColumn DisplayName;
        private System.Windows.Forms.DataGridViewTextBoxColumn Phone;
        private System.Windows.Forms.DataGridViewTextBoxColumn Points;
    }
}
