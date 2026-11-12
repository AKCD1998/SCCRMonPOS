using System;
using System.Drawing;
using System.Globalization;
using System.Linq;
using System.Runtime.Serialization;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace SCCRMonPOS
{
    [DataContract] public sealed class SyncJobList
    {
        [DataMember(Name="ok")] public bool Ok { get; set; }
        [DataMember(Name="jobs")] public SyncJob[] Jobs { get; set; }
    }
    [DataContract] public sealed class SyncJobDetail
    {
        [DataMember(Name="ok")] public bool Ok { get; set; }
        [DataMember(Name="job")] public SyncJob Job { get; set; }
        [DataMember(Name="events")] public SyncEvent[] Events { get; set; }
    }
    [DataContract] public sealed class SyncJob
    {
        [DataMember(Name="id")] public string Id { get; set; }
        [DataMember(Name="kind")] public string Kind { get; set; }
        [DataMember(Name="memberId")] public string MemberId { get; set; }
        [DataMember(Name="memberName")] public string MemberName { get; set; }
        [DataMember(Name="memberCode")] public string MemberCode { get; set; }
        [DataMember(Name="receiptNo")] public string ReceiptNo { get; set; }
        [DataMember(Name="branchCode")] public string BranchCode { get; set; }
        [DataMember(Name="state")] public string State { get; set; }
        [DataMember(Name="label")] public string Label { get; set; }
        [DataMember(Name="attempts")] public int Attempts { get; set; }
        [DataMember(Name="createdAt")] public string CreatedAt { get; set; }
        [DataMember(Name="nextAttemptAt")] public string NextAttemptAt { get; set; }
        [DataMember(Name="completeness")] public SyncCompleteness Completeness { get; set; }
    }
    [DataContract] public sealed class SyncCompleteness
    {
        [DataMember(Name="state")] public string State { get; set; }
        [DataMember(Name="label")] public string Label { get; set; }
        [DataMember(Name="verifiedAt")] public string VerifiedAt { get; set; }
        [DataMember(Name="nextCheckAt")] public string NextCheckAt { get; set; }
    }
    [DataContract] public sealed class SyncEvent
    {
        [DataMember(Name="at")] public string At { get; set; }
        [DataMember(Name="label")] public string Label { get; set; }
    }

    public sealed class SyncStatusForm : Form
    {
        private readonly ApiClient _api;
        private string _memberId;
        private readonly DataGridView _grid = new DataGridView {
            Dock=DockStyle.Fill, ReadOnly=true, AllowUserToAddRows=false, AllowUserToDeleteRows=false,
            MultiSelect=false, SelectionMode=DataGridViewSelectionMode.FullRowSelect, RowHeadersVisible=false,
            AutoSizeColumnsMode=DataGridViewAutoSizeColumnsMode.Fill, BackgroundColor=SystemColors.Window
        };
        private readonly TextBox _events = new TextBox { Dock=DockStyle.Bottom, Height=130, Multiline=true,
            ReadOnly=true, ScrollBars=ScrollBars.Vertical, BackColor=SystemColors.Window };
        private readonly Label _status = new Label { Dock=DockStyle.Bottom, Height=42, Padding=new Padding(8) };
        private readonly Button _retry = new Button { Text="ลองตรวจและส่งใหม่", AutoSize=true, Enabled=false };
        private readonly Button _refresh = new Button { Text="โหลดสถานะใหม่", AutoSize=true };
        private readonly Timer _timer = new Timer { Interval=10000 };
        private bool _loading, _retrying;
        private int _detailGeneration;

        public SyncStatusForm(ApiClient api, string memberId=null)
        {
            _api=api; _memberId=memberId;
            Text="SCCRM — สถานะส่งข้อมูลไป Ada";
            Font=new Font("Tahoma",10); StartPosition=FormStartPosition.CenterParent;
            var area=Screen.FromPoint(Cursor.Position).WorkingArea;
            ClientSize=new Size(Math.Max(540,Math.Min(720,(int)(area.Width*0.7))),Math.Max(360,Math.Min(540,area.Height-120)));
            MinimumSize=new Size(540,360);
            var heading=new Label { Dock=DockStyle.Top,Height=54,Padding=new Padding(10),
                Text="ข้อมูลเก็บใน SCCRM แล้ว ระบบจะเติมข้อมูลที่ขาดและตรวจซ้ำเอง\r\nแต้มใช้ข้อมูลจาก Ada — ปุ่มลองใหม่ไม่สร้างบิลหรือเพิ่มแต้ม" };
            var bar=new FlowLayoutPanel { Dock=DockStyle.Top,Height=43,Padding=new Padding(6) };
            var all=new Button { Text="ดูทั้งสาขา",AutoSize=true };
            bar.Controls.AddRange(new Control[]{_refresh,_retry,all});
            _grid.Columns.Add("date","บันทึกเมื่อ");
            _grid.Columns.Add("member","สมาชิก");
            _grid.Columns.Add("receipt","รายการ");
            _grid.Columns.Add("state","สถานะการส่ง Ada");
            _grid.Columns[0].FillWeight=70; _grid.Columns[1].FillWeight=100;
            _grid.Columns[2].FillWeight=100; _grid.Columns[3].FillWeight=160;
            _grid.DefaultCellStyle.WrapMode=DataGridViewTriState.True;
            _grid.AutoSizeRowsMode=DataGridViewAutoSizeRowsMode.AllCells;
            Controls.Add(_grid); Controls.Add(_events); Controls.Add(_status); Controls.Add(bar); Controls.Add(heading);
            _refresh.Click+=async(s,e)=>await RefreshAsync();
            all.Click+=async(s,e)=>{_memberId=null;await RefreshAsync();};
            _retry.Click+=async(s,e)=>await RetryAsync();
            _grid.SelectionChanged+=async(s,e)=>{if(!_loading)await DetailsAsync();};
            _timer.Tick+=async(s,e)=>await RefreshAsync();
            Shown+=async(s,e)=>{await RefreshAsync();_timer.Start();};
            FormClosed+=(s,e)=>{++_detailGeneration;_timer.Dispose();};
        }
        private SyncJob Selected { get { return _grid.SelectedRows.Count==1?_grid.SelectedRows[0].Tag as SyncJob:null; } }
        private static string When(string value)
        {
            DateTimeOffset time;
            return DateTimeOffset.TryParse(value,CultureInfo.InvariantCulture,DateTimeStyles.AssumeUniversal,out time)
                ?time.ToLocalTime().ToString("dd/MM HH:mm:ss",CultureInfo.InvariantCulture):"—";
        }
        private void RetryEnabled()
        {
            var selected=Selected;
            _retry.Enabled=!_loading&&!_retrying&&selected!=null&&selected.State!="running"&&selected.State!="succeeded"&&selected.Completeness?.State!="running";
        }
        internal async Task RefreshAsync()
        {
            if(_loading||_retrying||IsDisposed)return;
            _loading=true;_refresh.Enabled=false;RetryEnabled();
            string selected=Selected?.Id;
            try {
                var result=await _api.GetSyncJobsAsync(_memberId);if(IsDisposed)return;
                ++_detailGeneration;_grid.Rows.Clear();
                foreach(var job in result.Jobs) {
                    int index=_grid.Rows.Add(When(job.CreatedAt),job.MemberName+"\n"+job.MemberCode,
                        job.Kind=="member"?"สมัครสมาชิก":job.ReceiptNo,job.Label);
                    _grid.Rows[index].Tag=job;
                }
                _grid.ClearSelection();
                var row=_grid.Rows.Cast<DataGridViewRow>().FirstOrDefault(r=>(r.Tag as SyncJob)?.Id==selected)
                    ??_grid.Rows.Cast<DataGridViewRow>().FirstOrDefault();
                if(row!=null)row.Selected=true;else _events.Text="ยังไม่มีรายการส่งข้อมูลของสาขานี้";
                _status.Text="แสดง "+result.Jobs.Length+" รายการล่าสุด · ตรวจสถานะใหม่ทุก 10 วินาที";
            }catch(ApiException error){if(!IsDisposed)_status.Text=error.Message;}
            catch{if(!IsDisposed)_status.Text="ยังติดต่อไม่ได้ ข้อมูลเดิมยังเก็บอยู่ ระบบจะตรวจใหม่";}
            finally{_loading=false;if(!IsDisposed){_refresh.Enabled=true;RetryEnabled();}}
            if(!IsDisposed)await DetailsAsync();
        }
        private async Task DetailsAsync()
        {
            var selected=Selected;int generation=++_detailGeneration;RetryEnabled();
            if(selected==null||IsDisposed)return;
            try {
                var result=await _api.GetSyncJobAsync(selected.Id);
                if(IsDisposed||generation!=_detailGeneration||Selected?.Id!=selected.Id)return;
                _events.Text="บันทึกใน SCCRM แล้ว · ตรวจ "+result.Job.Attempts+" ครั้ง"+
                    (string.IsNullOrEmpty(result.Job.NextAttemptAt)?"":" · ครั้งถัดไป "+When(result.Job.NextAttemptAt))+"\r\n"+
                    (result.Job.Completeness==null?"":result.Job.Completeness.Label+
                        " · ตรวจครบล่าสุด "+When(result.Job.Completeness.VerifiedAt)+
                        " · ตรวจซ้ำครั้งถัดไป "+When(result.Job.Completeness.NextCheckAt)+"\r\n")+
                    string.Join("\r\n",result.Events.Select(e=>When(e.At)+"  "+e.Label));
            }catch{if(!IsDisposed&&generation==_detailGeneration)_events.Text="ยังอ่านประวัติการส่งไม่ได้ กดโหลดสถานะใหม่ได้";}
        }
        private async Task RetryAsync()
        {
            var selected=Selected;if(selected==null||_retrying||_loading)return;
            _retrying=true;RetryEnabled();
            try {await _api.RetrySyncJobAsync(selected.Id);if(!IsDisposed)_status.Text="รับคำขอแล้ว ระบบจะตรวจและลองส่งใหม่";}
            catch(ApiException error){if(!IsDisposed)_status.Text=error.Message;}
            catch{if(!IsDisposed)_status.Text="ยังรับคำขอไม่ได้ กดลองใหม่ได้โดยไม่สร้างบิลซ้ำ";}
            finally{_retrying=false;}
            if(!IsDisposed)await RefreshAsync();
        }
    }
}
