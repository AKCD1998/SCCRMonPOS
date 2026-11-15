using System;
using System.Drawing;
using System.Globalization;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace SCCRMonPOS
{
    internal sealed class MemberPreorderForm : Form
    {
        private readonly ApiClient _api;
        internal readonly string MemberId;
        private readonly string _memberName;
        private readonly Label _member = new Label(), _status = new Label(), _recordInfo = new Label();
        private readonly TextBox _billInfo = new TextBox { Multiline=true,ReadOnly=true,ScrollBars=ScrollBars.Vertical };
        private readonly DataGridView _records = Grid(), _confirmed = Grid(), _candidates = Grid();
        private readonly ListView _items = new ListView();
        private readonly Button _add = new Button(), _edit = new Button(), _refresh = new Button(), _confirm = new Button(), _revoke = new Button(), _older = new Button();
        private readonly TextBox _reason = new TextBox();
        private PreorderEntryForm _editor;
        private bool _mutationBusy, _loading, _editorWasVisible;
        private int _generation;
        private string _pageCursor, _nextCursor;
        internal bool HasPendingWork { get { return _mutationBusy || (_editor != null && !_editor.IsDisposed); } }
        internal MemberPreorderForm(ApiClient api,string memberId,string memberName)
        {
            _api=api;MemberId=memberId;_memberName=memberName;
            Text="ระบบพรีออเดอร์ — "+memberName;Font=new Font("Segoe UI",9f);Size=new Size(900,680);MinimumSize=new Size(720,560);StartPosition=FormStartPosition.CenterParent;
            var root=new TableLayoutPanel{Dock=DockStyle.Fill,ColumnCount=1,RowCount=3,Padding=new Padding(10)};root.RowStyles.Add(new RowStyle(SizeType.Absolute,35));root.RowStyles.Add(new RowStyle(SizeType.Absolute,42));root.RowStyles.Add(new RowStyle(SizeType.Percent,100));
            _member.Text=memberName;_member.Dock=DockStyle.Fill;_member.Font=new Font(Font,FontStyle.Bold);root.Controls.Add(_member,0,0);
            var bar=new TableLayoutPanel{Dock=DockStyle.Fill,ColumnCount=2};bar.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,100));bar.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute,140));_status.Dock=DockStyle.Fill;_status.ForeColor=Color.DimGray;
            _refresh.Text="โหลดข้อมูลใหม่";_refresh.Dock=DockStyle.Fill;_refresh.Click+=async(s,e)=>await ReloadAsync();bar.Controls.Add(_status,0,0);bar.Controls.Add(_refresh,1,0);root.Controls.Add(bar,0,1);
            var tabs=new TabControl{Dock=DockStyle.Fill};var notes=new TabPage("ข้อมูลประวัติพรีออเดอร์");var bills=new TabPage("ข้อมูลบิลพรีออเดอร์จริง");tabs.TabPages.Add(notes);tabs.TabPages.Add(bills);root.Controls.Add(tabs,0,2);Controls.Add(root);
            BuildNotes(notes);BuildBills(bills);
            Load+=async(s,e)=>await ReloadAsync();
            FormClosing+=(s,e)=>{if(HasPendingWork){e.Cancel=true;SetError("ยังมีข้อมูลพรีออเดอร์ที่กำลังแก้ไขหรือบันทึกอยู่");ShowPendingEditor();}};
            FormClosed+=(s,e)=>{++_generation;_editor?.Dispose();};
            VisibleChanged+=(s,e)=>{if(_editor==null||_editor.IsDisposed)return;if(!Visible){_editorWasVisible=_editor.Visible;_editor.Hide();}else if(_editorWasVisible){_editorWasVisible=false;_editor.Show(this);}};
        }
        private static DataGridView Grid()
        {
            return new DataGridView{Dock=DockStyle.Fill,ReadOnly=true,AllowUserToAddRows=false,AllowUserToDeleteRows=false,RowHeadersVisible=false,SelectionMode=DataGridViewSelectionMode.FullRowSelect,MultiSelect=false,AutoSizeColumnsMode=DataGridViewAutoSizeColumnsMode.Fill,BackgroundColor=Color.White};
        }
        private static void Column(DataGridView grid,string name,string title,int weight){grid.Columns.Add(new DataGridViewTextBoxColumn{Name=name,HeaderText=title,FillWeight=weight});}
        private void BuildNotes(TabPage tab)
        {
            var layout=new TableLayoutPanel{Dock=DockStyle.Fill,ColumnCount=1,RowCount=4};layout.RowStyles.Add(new RowStyle(SizeType.Absolute,40));layout.RowStyles.Add(new RowStyle(SizeType.Percent,40));layout.RowStyles.Add(new RowStyle(SizeType.Absolute,65));layout.RowStyles.Add(new RowStyle(SizeType.Percent,60));
            var buttons=new FlowLayoutPanel{Dock=DockStyle.Fill,WrapContents=false};_add.Text="เพิ่มข้อมูลที่จดไว้";_add.AutoSize=true;_add.BackColor=Color.FromArgb(190,83,0);_add.ForeColor=Color.White;_edit.Text="แก้ไขรายการที่เลือก";_edit.AutoSize=true;
            _add.Click+=(s,e)=>OpenEditor(null);_edit.Click+=(s,e)=>{var record=Selected<PreorderHistory>(_records);if(record!=null)OpenEditor(record);};buttons.Controls.AddRange(new Control[]{_add,_edit});layout.Controls.Add(buttons,0,0);
            Column(_records,"date","วันที่ลูกค้าแจ้ง / วันที่จด",25);Column(_records,"source","ที่มา",35);Column(_records,"frequency","รอบซื้อ",20);Column(_records,"items","จำนวนรายการ",20);_records.SelectionChanged+=(s,e)=>RenderRecord();layout.Controls.Add(_records,0,1);
            _recordInfo.Dock=DockStyle.Fill;_recordInfo.AutoEllipsis=true;layout.Controls.Add(_recordInfo,0,2);
            _items.Dock=DockStyle.Fill;_items.View=View.Details;_items.FullRowSelect=true;_items.GridLines=true;_items.ShowItemToolTips=true;
            _items.Columns.Add("สินค้า",310);_items.Columns.Add("จำนวนตามที่จด",110);_items.Columns.Add("ข้อมูลจากต้นฉบับ / จุดที่ต้องตรวจ",400);layout.Controls.Add(_items,0,3);tab.Controls.Add(layout);
        }
        private void BuildBills(TabPage tab)
        {
            var layout=new TableLayoutPanel{Dock=DockStyle.Fill,ColumnCount=1,RowCount=8};
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute,32));layout.RowStyles.Add(new RowStyle(SizeType.Percent,40));layout.RowStyles.Add(new RowStyle(SizeType.Absolute,38));layout.RowStyles.Add(new RowStyle(SizeType.Absolute,35));layout.RowStyles.Add(new RowStyle(SizeType.Percent,60));layout.RowStyles.Add(new RowStyle(SizeType.Absolute,60));layout.RowStyles.Add(new RowStyle(SizeType.Absolute,40));layout.RowStyles.Add(new RowStyle(SizeType.Absolute,30));
            layout.Controls.Add(new Label{Text="บิลที่พนักงานยืนยันแล้ว",Dock=DockStyle.Fill,Font=new Font(Font,FontStyle.Bold)},0,0);
            foreach(var grid in new[]{_confirmed,_candidates}){Column(grid,"date","วันที่ซื้อ",18);Column(grid,"receipt","เลขบิล",31);Column(grid,"branch","สาขา",9);Column(grid,"matches","สินค้าที่ตรง",22);Column(grid,"status","สถานะ",20);grid.SelectionChanged+=(s,e)=>{var bill=Selected<PreorderBill>((DataGridView)s);if(bill!=null)_billInfo.Text=BillDescription(bill);UpdateActions();};}
            layout.Controls.Add(_confirmed,0,1);
            var revoke=new TableLayoutPanel{Dock=DockStyle.Fill,ColumnCount=3};revoke.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute,120));revoke.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,100));revoke.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute,180));revoke.Controls.Add(new Label{Text="เหตุผลที่ยกเลิก",Dock=DockStyle.Fill},0,0);_reason.Dock=DockStyle.Fill;_reason.MaxLength=1000;_revoke.Text="ยกเลิกการยืนยันบิลนี้";_revoke.Dock=DockStyle.Fill;_revoke.Click+=async(s,e)=>await RevokeAsync();revoke.Controls.Add(_reason,1,0);revoke.Controls.Add(_revoke,2,0);layout.Controls.Add(revoke,0,2);
            layout.Controls.Add(new Label{Text="รอยืนยัน · พบสินค้าตรงรายการ แต่ยังไม่นับเป็นบิลพรีออเดอร์",Dock=DockStyle.Fill,Font=new Font(Font,FontStyle.Bold)},0,3);layout.Controls.Add(_candidates,0,4);_billInfo.Dock=DockStyle.Fill;layout.Controls.Add(_billInfo,0,5);
            _confirm.Text="ยืนยันว่าเป็นบิลพรีออเดอร์";_confirm.Dock=DockStyle.Fill;_confirm.BackColor=Color.FromArgb(190,83,0);_confirm.ForeColor=Color.White;_confirm.Click+=async(s,e)=>await ConfirmAsync();layout.Controls.Add(_confirm,0,6);
            _older.Text="ค้นบิลก่อนหน้า";_older.Dock=DockStyle.Fill;_older.Visible=false;_older.Click+=async(s,e)=>await ReloadAsync(_nextCursor);layout.Controls.Add(_older,0,7);tab.Controls.Add(layout);
        }
        private static T Selected<T>(DataGridView grid) where T:class {return grid.SelectedRows.Count==0?null:grid.SelectedRows[0].Tag as T;}
        private static string Date(string raw){DateTime value;return DateTime.TryParse(raw,CultureInfo.InvariantCulture,DateTimeStyles.RoundtripKind,out value)?value.ToLocalTime().ToString("dd/MM/yyyy HH:mm"):"ไม่ทราบวันที่";}
        private static string BillDescription(PreorderBill bill)
        {
            return bill.ReceiptNo+" · ยอดบิล "+bill.TotalAmount.ToString("N2")+" บาท\r\n"+string.Join("\r\n",(bill.Items??new PreorderBillItem[0]).Select(i=>i.ProductName+" · "+i.Qty.ToString("0.####",CultureInfo.InvariantCulture)+" "+i.UnitName+" · "+i.LineTotal.ToString("N2")+" บาท"))+
                ((bill.Returns?.Length??0)>0?" · มีบิลคืน "+string.Join(", ",bill.Returns.Select(r=>r.RefundDocNo))+" กรุณาตรวจสอบ":"");
        }
        private void RenderRecord()
        {
            _items.Items.Clear();var record=Selected<PreorderHistory>(_records);if(record==null){_recordInfo.Text="เลือกข้อมูลเพื่อดูสินค้า หรือกดเพิ่มข้อมูลที่จดไว้";UpdateActions();return;}
            _recordInfo.Text=(record.SourceKind=="paper_import"?"นำเข้าจากเอกสาร: ":"พนักงานบันทึก: ")+record.SourceReference+(record.SourceRow.HasValue?" · แถว "+record.SourceRow:"")+"\n"+(record.Notes??"");
            foreach(var item in record.Items??new PreorderItem[0]){var row=new ListViewItem(item.ProductName??"");row.SubItems.Add((item.Quantity?.ToString("0.####",CultureInfo.InvariantCulture)??"ไม่ทราบ")+" "+item.Unit);row.SubItems.Add(item.SourceDescription??"");row.ToolTipText=item.ProductName+"\n"+item.SourceDescription+((item.ProductCodes?.Length??0)==0?"\nยังไม่จับคู่สินค้า จึงยังไม่เสนอบิลจากรายการนี้":"");_items.Items.Add(row);}UpdateActions();
        }
        private void UpdateActions()
        {
            bool editing=_editor!=null&&!_editor.IsDisposed;_add.Enabled=!_mutationBusy&&!editing;_edit.Enabled=!_mutationBusy&&!editing&&Selected<PreorderHistory>(_records)!=null;
            _refresh.Enabled=!_loading&&!_mutationBusy;_older.Enabled=!_loading&&!_mutationBusy;
            var candidate=Selected<PreorderBill>(_candidates);_confirm.Enabled=!_loading&&!_mutationBusy&&candidate!=null&&!candidate.NeedsReview;
            _revoke.Enabled=!_loading&&!_mutationBusy&&Selected<PreorderBill>(_confirmed)!=null;
        }
        private void SetError(string text){_status.ForeColor=Color.Firebrick;_status.Text=text;}
        internal void ShowPendingEditor(){if(_editor!=null&&!_editor.IsDisposed){if(!Visible)Show();if(_editor.WindowState==FormWindowState.Minimized)_editor.WindowState=FormWindowState.Normal;_editor.Show(this);_editor.Activate();}}
        private void OpenEditor(PreorderHistory record)
        {
            if(_editor!=null&&!_editor.IsDisposed){ShowPendingEditor();return;}if(_mutationBusy)return;
            _editor=new PreorderEntryForm(_api,MemberId,_memberName,record);_editor.Saved+=async(s,e)=>await ReloadAsync();_editor.FormClosed+=(s,e)=>{_editor=null;UpdateActions();};_editor.Show(this);UpdateActions();
        }
        internal async Task ReloadAsync(string cursor=null)
        {
            int generation=++_generation;_loading=true;_status.ForeColor=Color.DimGray;_status.Text="กำลังโหลดข้อมูลพรีออเดอร์…";UpdateActions();
            try{var data=await _api.GetMemberPreordersAsync(MemberId,cursor);if(IsDisposed||generation!=_generation)return;
                _pageCursor=cursor;_nextCursor=data.HasMoreBills?data.NextCursor:null;_member.Text=data.MemberName+" — "+data.MemberCode;
                var selected=Selected<PreorderHistory>(_records)?.Id;_records.Rows.Clear();
                foreach(var record in data.Records??new PreorderHistory[0]){var row=new DataGridViewRow();row.CreateCells(_records,string.IsNullOrEmpty(record.OccurredOn)?"ไม่ทราบวันที่":record.OccurredOn,record.SourceReference??"พนักงานบันทึก",record.FrequencyMonths.HasValue?"ทุก "+record.FrequencyMonths+" เดือน":"ไม่ระบุ",record.Items?.Length??0);row.Tag=record;_records.Rows.Add(row);if(record.Id==selected)row.Selected=true;}
                FillBills(_confirmed,data.ConfirmedBills,true);FillBills(_candidates,data.Candidates,false);_older.Visible=!string.IsNullOrEmpty(_nextCursor);RenderRecord();
                _status.Text=!data.ReceiptsAvailable?data.ReceiptMessage:"ข้อมูลที่จดไว้ "+_records.Rows.Count+" รายการ · ยืนยันบิลแล้ว "+_confirmed.Rows.Count+" ใบ · รอยืนยันในหน้าบิลนี้ "+_candidates.Rows.Count+" ใบ";
            }catch(Exception ex){if(!IsDisposed&&generation==_generation)SetError(ex.Message);}
            finally{if(!IsDisposed&&generation==_generation){_loading=false;UpdateActions();}}
        }
        private void FillBills(DataGridView grid,PreorderBill[] bills,bool confirmed)
        {
            grid.Rows.Clear();foreach(var bill in bills??new PreorderBill[0]){var row=new DataGridViewRow();row.CreateCells(grid,Date(bill.SoldAt),bill.ReceiptNo,bill.BranchCode,bill.MatchedItems?.Length??0,bill.NeedsReview?"ข้อมูลต่างกัน ต้องตรวจ":confirmed?"ยืนยันแล้ว":"รอยืนยัน");row.Tag=bill;grid.Rows.Add(row);}
        }
        private async Task ConfirmAsync()
        {
            var bill=Selected<PreorderBill>(_candidates);if(_mutationBusy||_loading||bill==null||bill.NeedsReview)return;_mutationBusy=true;UpdateActions();
            try{await _api.ConfirmPreorderBillAsync(MemberId,bill,Guid.NewGuid().ToString("D"),_pageCursor);if(!IsDisposed)await ReloadAsync(_pageCursor);}
            catch(Exception ex){if(!IsDisposed)SetError(ex.Message);}finally{if(!IsDisposed){_mutationBusy=false;UpdateActions();}}
        }
        private async Task RevokeAsync()
        {
            var bill=Selected<PreorderBill>(_confirmed);if(_mutationBusy||_loading||bill==null)return;if(string.IsNullOrWhiteSpace(_reason.Text)){SetError("ใส่เหตุผลในช่องข้างปุ่มก่อนยกเลิกการยืนยันครับ");_reason.Focus();return;}
            _mutationBusy=true;UpdateActions();try{await _api.RevokePreorderBillAsync(MemberId,bill.Id,Guid.NewGuid().ToString("D"),_reason.Text.Trim());if(!IsDisposed){_reason.Clear();await ReloadAsync(_pageCursor);}}
            catch(Exception ex){if(!IsDisposed)SetError(ex.Message);}finally{if(!IsDisposed){_mutationBusy=false;UpdateActions();}}
        }
    }
}
