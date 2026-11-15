using System;
using System.Collections.Generic;
using System.Drawing;
using System.Globalization;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace SCCRMonPOS
{
    internal sealed class PreorderEntryForm : Form
    {
        private readonly ApiClient _api;
        private readonly string _memberId, _requestId = Guid.NewGuid().ToString("D");
        private readonly PreorderHistory _existing;
        private readonly DataGridView _items = new DataGridView();
        private readonly TextBox _search = new TextBox(), _source = new TextBox(), _notes = new TextBox();
        private readonly ComboBox _catalog = new ComboBox();
        private readonly CheckBox _unknownDate = new CheckBox(), _hasFrequency = new CheckBox();
        private readonly DateTimePicker _date = new DateTimePicker();
        private readonly NumericUpDown _months = new NumericUpDown();
        private readonly Label _status = new Label();
        private readonly Button _save = new Button();
        private bool _dirty, _busy, _allowClose;
        internal bool HasUnsavedChanges { get { return _dirty || _busy; } }
        internal event EventHandler Saved;

        internal PreorderEntryForm(ApiClient api, string memberId, string memberName, PreorderHistory existing = null)
        {
            _api=api;_memberId=memberId;_existing=existing;
            Text="ระบบพรีออเดอร์ — "+memberName;
            Font=new Font("Segoe UI",9f);Size=new Size(880,700);MinimumSize=new Size(740,600);StartPosition=FormStartPosition.CenterParent;
            var root=new TableLayoutPanel {Dock=DockStyle.Fill,ColumnCount=1,RowCount=9,Padding=new Padding(12)};
            foreach(var height in new[]{32,42,34,70})root.RowStyles.Add(new RowStyle(SizeType.Absolute,height));
            root.RowStyles.Add(new RowStyle(SizeType.Percent,100));
            foreach(var height in new[]{22,70,44,40})root.RowStyles.Add(new RowStyle(SizeType.Absolute,height));
            root.Controls.Add(new Label {Text=memberName+" · "+(existing==null?"เพิ่มข้อมูลที่จดไว้":"แก้ไขประวัติพรีออเดอร์"),Dock=DockStyle.Fill,Font=new Font(Font,FontStyle.Bold)},0,0);
            var meta=new FlowLayoutPanel {Dock=DockStyle.Fill,WrapContents=false};
            _unknownDate.Text="ไม่ทราบวันที่";_unknownDate.AutoSize=true;_unknownDate.Checked=true;
            _date.Format=DateTimePickerFormat.Short;_date.Width=125;
            _hasFrequency.Text="รอบซื้อทุก";_hasFrequency.AutoSize=true;_months.Minimum=1;_months.Maximum=120;_months.Width=52;
            meta.Controls.AddRange(new Control[]{_unknownDate,_date,_hasFrequency,_months,new Label{Text="เดือน",AutoSize=true}});root.Controls.Add(meta,0,1);
            var src=new TableLayoutPanel {Dock=DockStyle.Fill,ColumnCount=2};src.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute,75));src.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,100));
            src.Controls.Add(new Label{Text="ที่มาข้อมูล",AutoSize=true},0,0);_source.Dock=DockStyle.Fill;_source.MaxLength=255;_source.Text="พนักงานจดไว้";src.Controls.Add(_source,1,0);root.Controls.Add(src,0,2);
            var find=new TableLayoutPanel {Dock=DockStyle.Fill,ColumnCount=3,RowCount=2};find.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,100));find.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute,110));find.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute,160));
            _search.Dock=DockStyle.Fill;_search.MaxLength=100;var findButton=new Button{Text="ค้นหาสินค้า",Dock=DockStyle.Fill};var free=new Button{Text="เพิ่มรายการที่หาไม่พบ",Dock=DockStyle.Fill};
            _catalog.Dock=DockStyle.Fill;_catalog.DropDownStyle=ComboBoxStyle.DropDownList;
            var add=new Button{Text="เพิ่มสินค้าที่เลือก",Dock=DockStyle.Fill};
            find.Controls.Add(_search,0,0);find.Controls.Add(findButton,1,0);find.Controls.Add(free,2,0);find.Controls.Add(_catalog,0,1);find.SetColumnSpan(_catalog,2);find.Controls.Add(add,2,1);root.Controls.Add(find,0,3);
            _items.Dock=DockStyle.Fill;_items.AllowUserToAddRows=false;_items.AllowUserToDeleteRows=true;_items.RowHeadersVisible=false;_items.AutoSizeColumnsMode=DataGridViewAutoSizeColumnsMode.Fill;
            _items.Columns.Add(new DataGridViewTextBoxColumn{Name="name",HeaderText="สินค้า",FillWeight=38});
            _items.Columns.Add(new DataGridViewTextBoxColumn{Name="quantity",HeaderText="จำนวน",FillWeight=10});
            _items.Columns.Add(new DataGridViewTextBoxColumn{Name="unit",HeaderText="หน่วยตามที่จด",FillWeight=12});
            _items.Columns.Add(new DataGridViewTextBoxColumn{Name="note",HeaderText="รายละเอียดจากต้นฉบับ / จุดที่ต้องตรวจ",FillWeight=40});
            root.Controls.Add(_items,0,4);
            root.Controls.Add(new Label{Text="หมายเหตุเพิ่มเติม (รายการนี้ยังไม่ใช่บิลขาย)",Dock=DockStyle.Fill},0,5);
            _notes.Dock=DockStyle.Fill;_notes.Multiline=true;_notes.ScrollBars=ScrollBars.Vertical;_notes.MaxLength=4000;root.Controls.Add(_notes,0,6);
            _status.Dock=DockStyle.Fill;_status.ForeColor=Color.DimGray;_status.Text="เว้นจำนวนไว้ได้ถ้าไม่ทราบ · เลือกสินค้าจากการค้นหาเพื่อให้ระบบเสนอบิลที่ตรงกัน";root.Controls.Add(_status,0,7);
            var buttons=new FlowLayoutPanel{Dock=DockStyle.Fill,FlowDirection=FlowDirection.RightToLeft,WrapContents=false};
            _save.Text="บันทึกข้อมูลพรีออเดอร์";_save.AutoSize=true;_save.BackColor=Color.FromArgb(190,83,0);_save.ForeColor=Color.White;
            var cancel=new Button{Text="ยกเลิกการแก้ไข",AutoSize=true};buttons.Controls.Add(_save);buttons.Controls.Add(cancel);root.Controls.Add(buttons,0,8);Controls.Add(root);
            if(existing!=null){_source.Text=existing.SourceReference??"";_source.ReadOnly=existing.SourceKind=="paper_import";_notes.Text=existing.Notes??"";
                DateTime date;if(DateTime.TryParseExact(existing.OccurredOn,"yyyy-MM-dd",CultureInfo.InvariantCulture,DateTimeStyles.None,out date)){_date.Value=date;_unknownDate.Checked=false;}
                _hasFrequency.Checked=existing.FrequencyMonths.HasValue;if(existing.FrequencyMonths.HasValue)_months.Value=Math.Max(1,Math.Min(120,existing.FrequencyMonths.Value));
                foreach(var item in existing.Items??new PreorderItem[0])AddRow(item);
            }
            UpdateMetadata();_dirty=false;
            _unknownDate.CheckedChanged+=(s,e)=>{_dirty=true;UpdateMetadata();};_hasFrequency.CheckedChanged+=(s,e)=>{_dirty=true;UpdateMetadata();};
            _date.ValueChanged+=(s,e)=>_dirty=true;_months.ValueChanged+=(s,e)=>_dirty=true;_source.TextChanged+=(s,e)=>_dirty=true;_notes.TextChanged+=(s,e)=>_dirty=true;
            _items.CellValueChanged+=(s,e)=>_dirty=true;_items.UserDeletedRow+=(s,e)=>_dirty=true;
            _items.DataError+=(s,e)=>{e.ThrowException=false;_status.Text="จำนวนไม่ถูกต้อง กรุณาตรวจช่องที่กำลังแก้ไข";};
            findButton.Click+=async(s,e)=>{if(_busy)return;try{findButton.Enabled=false;_catalog.Items.Clear();var products=await _api.SearchPreorderProductsAsync(_search.Text.Trim());if(IsDisposed)return;foreach(var item in products)_catalog.Items.Add(item);if(_catalog.Items.Count>0)_catalog.SelectedIndex=0;_status.Text=_catalog.Items.Count>0?"เลือกสินค้าแล้วกดเพิ่มสินค้าที่เลือก":"ยังไม่พบสินค้า ใช้ปุ่มเพิ่มรายการที่หาไม่พบได้";}catch(Exception ex){if(!IsDisposed)SetError(ex.Message);}finally{if(!IsDisposed)findButton.Enabled=true;}};
            add.Click+=(s,e)=>{if(_busy)return;var product=_catalog.SelectedItem as PreorderCatalogItem;if(product==null){SetError("ค้นหาและเลือกสินค้าก่อนครับ");return;}if(_items.Rows.Count>=40){SetError("เพิ่มได้ครั้งละไม่เกิน 40 รายการ");return;}AddRow(new PreorderItem{ProductCodes=new[]{product.ProductCode},ProductName=product.ProductName,Quantity=1,Unit=product.Unit,SourceDescription=""});_dirty=true;};
            free.Click+=(s,e)=>{if(_busy||_items.Rows.Count>=40)return;AddRow(new PreorderItem{ProductCodes=new string[0],ProductName="",SourceDescription="ยังไม่จับคู่สินค้า"});_dirty=true;_items.CurrentCell=_items.Rows[_items.Rows.Count-1].Cells[0];_items.BeginEdit(true);};
            _save.Click+=async(s,e)=>await SaveAsync();cancel.Click+=(s,e)=>{if(_busy)return;_allowClose=true;Close();};
            FormClosing+=(s,e)=>{if(_busy||(_dirty&&!_allowClose)){e.Cancel=true;SetError("ยังมีข้อมูลที่ไม่ได้บันทึก · กดบันทึก หรือยกเลิกการแก้ไขเพื่อปิดหน้านี้");}};
        }
        private void UpdateMetadata(){_unknownDate.Enabled=!_busy;_hasFrequency.Enabled=!_busy;_date.Enabled=!_unknownDate.Checked&&!_busy;_months.Enabled=_hasFrequency.Checked&&!_busy;}
        private void AddRow(PreorderItem item)
        {
            var row=new DataGridViewRow();row.CreateCells(_items,item.ProductName,item.Quantity?.ToString(CultureInfo.InvariantCulture)??"",item.Unit??"",item.SourceDescription??"");row.Tag=item.ProductCodes??new string[0];row.Cells[0].ReadOnly=((string[])row.Tag).Length>0;_items.Rows.Add(row);
        }
        private void SetError(string message){_status.ForeColor=Color.Firebrick;_status.Text=message;}
        internal PreorderSaveRequest BuildRequest()
        {
            _items.EndEdit();if(_items.Rows.Count==0)throw new InvalidOperationException("เพิ่มสินค้าอย่างน้อย 1 รายการก่อนครับ");
            var items=new List<PreorderItem>();
            foreach(DataGridViewRow row in _items.Rows){string name=Convert.ToString(row.Cells[0].Value).Trim();if(name.Length==0)throw new InvalidOperationException("กรอกชื่อสินค้าทุกรายการก่อนครับ");
                string raw=Convert.ToString(row.Cells[1].Value).Trim();decimal parsed;decimal? quantity=null;
                if(raw.Length>0){if(!decimal.TryParse(raw,NumberStyles.Number,CultureInfo.InvariantCulture,out parsed)||parsed<=0||parsed>1000000)throw new InvalidOperationException("จำนวนต้องมากกว่า 0 หรือเว้นว่างถ้าไม่ทราบ");quantity=parsed;}
                items.Add(new PreorderItem{ProductCodes=(string[])row.Tag,ProductName=name,Quantity=quantity,Unit=Convert.ToString(row.Cells[2].Value).Trim(),SourceDescription=Convert.ToString(row.Cells[3].Value).Trim()});
            }
            return new PreorderSaveRequest{RequestId=_requestId,Id=_existing?.Id,Version=_existing?.Version??0,OccurredOn=_unknownDate.Checked?null:_date.Value.ToString("yyyy-MM-dd",CultureInfo.InvariantCulture),FrequencyMonths=_hasFrequency.Checked?(int?)_months.Value:null,Notes=_notes.Text.Trim(),SourceReference=_source.Text.Trim(),Items=items.ToArray()};
        }
        private async Task SaveAsync()
        {
            if(_busy)return;PreorderSaveRequest request;try{request=BuildRequest();}catch(Exception ex){SetError(ex.Message);return;}
            _busy=true;_save.Enabled=false;_items.Enabled=false;_notes.Enabled=false;_source.Enabled=false;UpdateMetadata();_status.ForeColor=Color.DimGray;_status.Text="กำลังบันทึกข้อมูล…";
            try{await _api.SaveMemberPreorderAsync(_memberId,request);if(IsDisposed)return;_dirty=false;_busy=false;_allowClose=true;Saved?.Invoke(this,EventArgs.Empty);Close();}
            catch(Exception ex){if(!IsDisposed)SetError(ex.Message);}
            finally{if(!IsDisposed){_busy=false;_save.Enabled=true;_items.Enabled=true;_notes.Enabled=true;_source.Enabled=true;UpdateMetadata();}}
        }
    }
}
