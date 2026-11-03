using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;
using System.Windows.Forms;

[DataContract] public sealed class FleetConsoleReply
{
    [DataMember(Name="ok")] public bool Ok;
    [DataMember(Name="enabled")] public bool Enabled;
    [DataMember(Name="version")] public string Version;
    [DataMember(Name="sha256")] public string Hash;
    [DataMember(Name="code")] public string Code;
    [DataMember(Name="devices")] public FleetConsoleDevice[] Devices;
    [DataMember(Name="jobs")] public FleetConsoleJob[] Jobs;
    [DataMember(Name="notReady")] public FleetConsoleNotReady[] NotReady;
}
[DataContract] public sealed class FleetConsoleDevice
{
    [DataMember(Name="nodeId")] public string NodeId;
    [DataMember(Name="branchCode")] public string Branch;
    [DataMember(Name="posCode")] public string Pos;
    [DataMember(Name="hostname")] public string Host;
    [DataMember(Name="version")] public string Version;
    [DataMember(Name="lastSeenAt")] public string Seen;
    [DataMember(Name="enrolled")] public bool Enrolled;
    [DataMember(Name="online")] public bool Online;
    [DataMember(Name="jobState")] public string JobState;
    [DataMember(Name="targetVersion")] public string Target;
}
[DataContract] public sealed class FleetConsoleJob { [DataMember(Name="id")] public string Id; }
[DataContract] public sealed class FleetConsoleNotReady { [DataMember(Name="nodeId")] public string NodeId;[DataMember(Name="code")] public string Code; }
[DataContract] public sealed class FleetConsoleRequest
{
    [DataMember(Name="requestId")] public string Id;
    [DataMember(Name="nodeIds")] public string[] Nodes;
    [DataMember(Name="expectedReleaseHash")] public string Hash;
}
internal sealed class FleetConsole : Form
{
    private sealed class ApiFailure : Exception { public string Code; public ApiFailure(string code) {Code=code;} }
    private readonly HttpClient http;
    private readonly DataGridView grid=new DataGridView {Dock=DockStyle.Fill,AllowUserToAddRows=false,AllowUserToDeleteRows=false,AutoSizeColumnsMode=DataGridViewAutoSizeColumnsMode.Fill,RowHeadersVisible=false};
    private readonly Label status=new Label {Dock=DockStyle.Bottom,Height=58,Padding=new Padding(12),Text="กำลังเชื่อมต่อ…"};
    private readonly Label releaseLabel=new Label {AutoSize=true,Padding=new Padding(10),Text="รุ่นล่าสุด: กำลังตรวจสอบ"};
    private readonly Button send=new Button {Text="สั่งอัปเดตเครื่องที่เลือก",AutoSize=true,Enabled=false};
    private readonly Button pause=new Button {Text="พักคำสั่งอัปเดต",AutoSize=true};
    private readonly Timer timer=new Timer {Interval=15000};
    private readonly string pendingFile;
    private string releaseHash;
    private bool busy,enabled;

    [STAThread] public static void Main()
    {
        Application.EnableVisualStyles();Application.SetCompatibleTextRenderingDefault(false);
        if(!string.Equals(Environment.MachineName,"SCPRODUCTDEV",StringComparison.OrdinalIgnoreCase))
        {MessageBox.Show("คอนโซลนี้กำหนดให้ใช้บน SCProductDev","SCCRM");return;}
        try{Application.Run(new FleetConsole());}
        catch{MessageBox.Show("เปิดคอนโซลไม่ได้ กรุณาตรวจการตั้งค่าสิทธิ์แอดมิน SCCRM บนเครื่องนี้","SCCRM");}
    }
    private FleetConsole()
    {
        Text="SCCRM — ควบคุมอัปเดตสาขา · SCProductDev";ClientSize=new Size(1100,520);MinimumSize=new Size(900,440);Font=new Font("Tahoma",10);StartPosition=FormStartPosition.CenterScreen;
        string root=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"SCCRMonPOS-Admin");
        pendingFile=Path.Combine(root,"fleet-pending-request.json");
        byte[] secret=ProtectedData.Unprotect(File.ReadAllBytes(Path.Combine(root,"fleet-admin-token.dpapi")),null,DataProtectionScope.CurrentUser);
        try{
            http=new HttpClient(new HttpClientHandler {AllowAutoRedirect=false}) {BaseAddress=new Uri("https://sc-official-website.onrender.com/api/sccrm-fleet/admin/"),Timeout=TimeSpan.FromSeconds(25)};
            http.DefaultRequestHeaders.Authorization=new AuthenticationHeaderValue("Bearer",Encoding.UTF8.GetString(secret));
        }finally{Array.Clear(secret,0,secret.Length);}
        grid.Columns.Add(new DataGridViewCheckBoxColumn {Name="selected",HeaderText="เลือก",FillWeight=35});
        grid.CurrentCellDirtyStateChanged+=(s,e)=>{if(grid.IsCurrentCellDirty)grid.CommitEdit(DataGridViewDataErrorContexts.Commit);};
        foreach(string title in new[]{"สาขา","POS","ชื่อเครื่อง","รุ่นปัจจุบัน","ติดต่อครั้งล่าสุด","สถานะคำสั่ง","รุ่นเป้าหมาย"})grid.Columns.Add(title,title);
        foreach(DataGridViewColumn column in grid.Columns)if(column.Name!="selected")column.ReadOnly=true;
        var bar=new FlowLayoutPanel {Dock=DockStyle.Top,Height=55,Padding=new Padding(8)};
        var all=new Button {Text="เลือกทุกสาขา",AutoSize=true};all.Click+=(s,e)=>{foreach(DataGridViewRow row in grid.Rows)row.Cells[0].Value=true;};
        var refresh=new Button {Text="รีเฟรช",AutoSize=true};refresh.Click+=async(s,e)=>await RefreshAsync();
        send.Click+=async(s,e)=>await IssueAsync();pause.Click+=async(s,e)=>await PauseAsync();
        bar.Controls.AddRange(new Control[]{all,send,refresh,pause,releaseLabel});
        Controls.Add(grid);Controls.Add(bar);Controls.Add(status);
        timer.Tick+=async(s,e)=>await RefreshAsync();Shown+=async(s,e)=>{await RefreshAsync();timer.Start();};
        FormClosed+=(s,e)=>{timer.Dispose();http.Dispose();};
    }
    private static string Json<T>(T value){using(var s=new MemoryStream()){new DataContractJsonSerializer(typeof(T)).WriteObject(s,value);return Encoding.UTF8.GetString(s.ToArray());}}
    private async Task<FleetConsoleReply> Request(string path,string body=null)
    {
        using(var request=new HttpRequestMessage(body==null?HttpMethod.Get:HttpMethod.Post,path))
        {
            if(body!=null)request.Content=new StringContent(body,Encoding.UTF8,"application/json");
            using(var response=await http.SendAsync(request))
            {
                string text=await response.Content.ReadAsStringAsync();if(text.Length>262144)throw new InvalidDataException();
                using(var input=new MemoryStream(Encoding.UTF8.GetBytes(text)))
                {
                    var value=(FleetConsoleReply)new DataContractJsonSerializer(typeof(FleetConsoleReply)).ReadObject(input);
                    if(!response.IsSuccessStatusCode||!value.Ok)throw new ApiFailure(value.Code??"FLEET_UNAVAILABLE");return value;
                }
            }
        }
    }
    private string ThaiState(string state)
    {
        switch(state){case "pending":return "รอเครื่องรับคำสั่ง";case "downloading":return "กำลังดาวน์โหลด";case "waiting_for_idle":return "รอบันทึกงาน / ปิดหน้าที่แก้ไข";case "installing":case "restarting":return "กำลังเปิดรุ่นใหม่";case "succeeded":return "สำเร็จ — ยืนยันรุ่นแล้ว";case "failed":return "ไม่สำเร็จ — ตรวจเครื่อง";case "expired":return "คำสั่งหมดอายุ";default:return "ยังไม่มีคำสั่ง";}
    }
    private async Task RefreshAsync()
    {
        if(busy||IsDisposed)return;busy=true;send.Enabled=false;
        try
        {
            var data=await Request("status");if(IsDisposed)return;enabled=data.Enabled;pause.Text=enabled?"พักคำสั่งอัปเดต":"เปิดรับคำสั่งอัปเดต";
            grid.EndEdit();var selected=new HashSet<string>();foreach(DataGridViewRow row in grid.Rows)if(Convert.ToBoolean(row.Cells[0].Value??false))selected.Add((string)row.Tag);
            grid.Rows.Clear();foreach(var d in data.Devices??new FleetConsoleDevice[0])
            {
                DateTime seen;string last=DateTime.TryParse(d.Seen,out seen)?seen.ToLocalTime().ToString("dd/MM HH:mm:ss"):"ยังไม่รายงาน";
                int i=grid.Rows.Add(selected.Contains(d.NodeId),d.Branch,d.Pos,d.Host,d.Version??"ยังไม่มีตัวรับคำสั่ง",last,d.Enrolled?(d.Online?ThaiState(d.JobState):"ออฟไลน์ / รอเปิด SCCRM · "+ThaiState(d.JobState)):"ต้องติดตั้งรุ่นรับคำสั่งครั้งแรก",d.Target??"—");grid.Rows[i].Tag=d.NodeId;
            }
            try{var release=await Request("release");releaseHash=release.Hash;releaseLabel.Text="รุ่นล่าสุด: "+release.Version;}
            catch{releaseHash=null;releaseLabel.Text="ยังไม่มีรุ่นพร้อมสั่งอัปเดต";}
            status.Text=File.Exists(pendingFile)?"มีคำสั่งค้างตอบรับ กดสั่งอีกครั้งเพื่อสอบถามคำสั่งเดิมอย่างปลอดภัย":enabled?"แอดมินกดสั่งเอง · เครื่องปลายทางรอ SCCRM บันทึกงานเสร็จก่อนอัปเดต · ไม่สั่งปิด AdaPos":"พักคำสั่งไว้ · งานที่ส่งต่อให้ตัวติดตั้งแล้วจะทำจนเสร็จ";
        }
        catch{status.Text="เชื่อมต่อไม่ได้ คำสั่งที่ส่งไว้ยังเก็บอยู่ในระบบ";}
        finally{busy=false;send.Enabled=(enabled&&releaseHash!=null)||File.Exists(pendingFile);}
    }
    private async Task IssueAsync()
    {
        if(busy)return;grid.EndEdit();
        string body;
        if(File.Exists(pendingFile))body=File.ReadAllText(pendingFile);
        else
        {
            var nodes=new List<string>();foreach(DataGridViewRow row in grid.Rows)if(Convert.ToBoolean(row.Cells[0].Value??false))nodes.Add((string)row.Tag);
            if(nodes.Count==0){status.Text="เลือกเครื่องที่ต้องการก่อนกดสั่ง";return;}
            body=Json(new FleetConsoleRequest {Id=Guid.NewGuid().ToString("D"),Nodes=nodes.ToArray(),Hash=releaseHash});
            Directory.CreateDirectory(Path.GetDirectoryName(pendingFile));File.WriteAllText(pendingFile,body,new UTF8Encoding(false));
        }
        busy=true;send.Enabled=false;
        try
        {
            var result=await Request("commands",body);File.Delete(pendingFile);
            status.Text="รับคำสั่งแล้ว "+(result.Jobs?.Length??0)+" เครื่อง · ยังไม่พร้อม "+(result.NotReady?.Length??0)+" เครื่อง — ดูสถานะแต่ละเครื่องในตาราง";
        }
        catch(ApiFailure failure) { if(failure.Code=="RELEASE_CHANGED_REVIEW_AGAIN"||failure.Code=="FLEET_CONTROL_PAUSED"||failure.Code=="UNAPPROVED_TARGET")File.Delete(pendingFile);status.Text="ยังไม่ส่งคำสั่ง: "+failure.Code+" — รีเฟรชข้อมูลก่อนลองใหม่"; }
        catch{status.Text="ยังไม่ได้รับคำตอบยืนยัน เก็บคำสั่งเดิมไว้แล้ว กดสั่งอีกครั้งได้โดยไม่สร้างคำสั่งซ้ำ";}
        finally{busy=false;send.Enabled=true;}
    }
    private async Task PauseAsync()
    {
        if(busy)return;busy=true;
        try{await Request("pause","{\"enabled\":"+(enabled?"false":"true")+"}");}
        catch{status.Text="เปลี่ยนสถานะพักคำสั่งไม่ได้ กรุณาลองใหม่";}
        finally{busy=false;await RefreshAsync();}
    }
}
