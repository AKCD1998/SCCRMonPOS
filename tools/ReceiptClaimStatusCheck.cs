using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using SCCRMonPOS;
using SCCRMonPOS.Models;

// Exact desktop HTTP client and WinForms flow, using only synthetic loopback data.
// No watcher is started and no production API, AdaPos or SQL connection is used.
internal static class ReceiptClaimStatusCheck
{
    private static int checks;
    private const BindingFlags Fields = BindingFlags.NonPublic | BindingFlags.Instance;
    private static void Check(bool value, string name) { if (!value) throw new Exception(name); checks++; }
    private static object Call(object target, string name, params object[] args) => target.GetType().GetMethod(name, Fields).Invoke(target,args);
    private static T Field<T>(object target, string name) => (T)typeof(MemberClaimForm).GetField(name, Fields).GetValue(target);
    private static void Pump(Task task) {
        var clock = Stopwatch.StartNew();
        while (!task.IsCompleted && clock.ElapsedMilliseconds < 8000) { Application.DoEvents(); Thread.Sleep(5); }
        Check(task.IsCompleted, "bounded asynchronous operation"); task.GetAwaiter().GetResult(); Application.DoEvents();
    }
    private static PosReceipt Receipt(string doc = "S-FIXTURE") => new PosReceipt {
        BranchCode="004",PosCode="002",DocNo=doc,DocType="1",DocDate=DateTime.Today,DocTime="12:00:00",GrandTotal=100,
        Items=new List<PosReceiptItem> { new PosReceiptItem {Seq=1, ProductCode="SKU-FIXTURE",ProductName="Fixture",Qty=1,UnitPrice=100,NetAmount=100} }
    };
    private static string Status(bool claimed, string doc = "S-FIXTURE", string name = "สมาชิกที่บันทึกจริง") =>
        "{\"ok\":true,\"branchCode\":\"004\",\"receiptNo\":\""+doc+"\",\"claimed\":"+(claimed?"true":"false")+
        (claimed?",\"claimId\":\"claim-fixture\",\"member\":{\"id\":\"member-a\",\"displayName\":\""+name+"\",\"memberCode\":\"SCM-A\"}":"")+"}";

    private sealed class Reply { public int Code=200; public string Json; }
    private sealed class Server : IDisposable
    {
        private readonly TcpListener listener = new TcpListener(IPAddress.Loopback,0);
        public Func<string,string,Task<Reply>> Respond;
        public int Posts, StatusCalls;
        public string BaseUrl;
        public Server() {
            listener.Start(); BaseUrl="http://127.0.0.1:"+((IPEndPoint)listener.LocalEndpoint).Port;
            _ = Accept();
        }
        private async Task Accept() {
            try { while(true) { var client=await listener.AcceptTcpClientAsync(); _ = Handle(client); } }
            catch(ObjectDisposedException) {} catch(SocketException) {}
        }
        private async Task Handle(TcpClient client) {
            using(client) using(var stream=client.GetStream()) {
                var header=new List<byte>(); var one=new byte[1];
                while(header.Count<16000) {
                    if(await stream.ReadAsync(one,0,1)==0)return; header.Add(one[0]);
                    int n=header.Count; if(n>=4 && header[n-4]==13 && header[n-3]==10 && header[n-2]==13 && header[n-1]==10)break;
                }
                string headers=Encoding.ASCII.GetString(header.ToArray());
                var lengthLine=headers.Split('\n').FirstOrDefault(l=>l.StartsWith("Content-Length:",StringComparison.OrdinalIgnoreCase));
                int length=lengthLine==null?0:int.Parse(lengthLine.Split(':')[1].Trim()); var bytes=new byte[length]; int read=0;
                while(read<length) {int n=await stream.ReadAsync(bytes,read,length-read); if(n==0)return;read+=n;}
                string path=headers.Split(' ')[1], body=Encoding.UTF8.GetString(bytes);
                if(headers.StartsWith("POST /api/loyalty/claims "))Interlocked.Increment(ref Posts);
                if(path.StartsWith("/api/loyalty/claims/status?"))Interlocked.Increment(ref StatusCalls);
                Reply reply=await Respond(path,body); byte[] output=Encoding.UTF8.GetBytes(reply.Json);
                byte[] response=Encoding.ASCII.GetBytes("HTTP/1.1 "+reply.Code+" Result\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: "+output.Length+"\r\nConnection: close\r\n\r\n");
                try { await stream.WriteAsync(response,0,response.Length); await stream.WriteAsync(output,0,output.Length); } catch(IOException) {}
            }
        }
        public void Dispose() { listener.Stop(); }
    }
    private sealed class Fixture : IDisposable
    {
        public readonly AdaPosWatcher Watcher;
        public readonly CustomerDisplayController Display;
        public readonly MemberClaimForm Form;
        public Fixture(ApiClient api, PosReceipt receipt) {
            Watcher=new AdaPosWatcher(null,false,new ReceiptTerminalScope("004","002"));
            Display=new CustomerDisplayController(Path.Combine(Path.GetTempPath(),"sccrm-status-fixture-"+Guid.NewGuid().ToString("N")));
            Form=new MemberClaimForm(api,Watcher,25,"fixture",receipt,Display) {TopMost=false,ShowInTaskbar=false,StartPosition=FormStartPosition.Manual,Location=new Point(-20000,-20000)};
            Form.Show(); Application.DoEvents();
        }
        public void Wait() => Pump((Task)Call(Form,"RefreshReceiptClaimStatusAsync"));
        public void Select(string id="member-b",string name="สมาชิกที่เลือกภายหลัง") {
            Call(Form,"AddMemberRow",new MemberSearchResult {Id=id,DisplayName=name,MemberCode="SCM-SELECTED",PointsAvailable=true});
            Call(Form,"SelectMemberAtRow",Field<DataGridView>(Form,"_dgvResults").Rows.Count-1);
        }
        public bool Enabled => Field<Button>(Form,"_btnConfirm").Enabled;
        public string Text => Field<Label>(Form,"_receiptStatusLabel").Text;
        public void Dispose() { Form.Close(); Form.Dispose(); Display.Dispose(); Watcher.Dispose(); }
    }
    private static void Run()
    {
        using(var server=new Server()) {
            bool claimed=false,fail=false,race=false,malformed=false;
            server.Respond=(path,body)=> {
                if(path.StartsWith("/api/loyalty/claims/status?"))return Task.FromResult(new Reply {Code=fail?503:200,Json=fail?"{\"error\":\"unavailable\"}":malformed?"{\"ok\":true}":Status(claimed)});
                if(path=="/api/loyalty/claims") {
                    Check(body.Contains("\"memberId\":\"member-b\""),"selected member submitted once"); claimed=true;
                    return Task.FromResult(new Reply {Code=race?409:200,Json=race?"{\"error\":\"Receipt already claimed.\"}":"{\"ok\":true,\"claimId\":\"claim-fixture\",\"receiptNo\":\"S-FIXTURE\",\"member\":{\"displayName\":\"สมาชิกที่เลือกภายหลัง\",\"newPointsBalance\":4},\"awardedPoints\":4}"});
                }
                return Task.FromResult(new Reply {Code=404,Json="{\"error\":\"fixture route\"}"});
            };
            var api=new ApiClient(server.BaseUrl); api.SetStaffToken("synthetic-status-session");
            using(var f=new Fixture(api,Receipt())) {
                f.Wait(); f.Select(); Check(f.Enabled && f.Text.Contains("ยังไม่ได้บันทึก"),"verified unclaimed bill enables confirmation");
                int before=server.StatusCalls; Pump((Task)Call(f.Form,"ConfirmClaimAsync"));
                Check(server.StatusCalls>before && server.Posts==1,"fresh lookup precedes first submit");
                Check(!f.Enabled && f.Text.Contains("บันทึกแล้ว") && f.Text.Contains("สมาชิกที่เลือกภายหลัง"),"success immediately shows stored member and disables confirm");
                Pump((Task)Call(f.Form,"ConfirmClaimAsync")); Check(server.Posts==1,"same form cannot submit twice");
            }
            using(var f=new Fixture(api,Receipt())) {
                f.Wait(); f.Select(); Check(!f.Enabled && f.Text.Contains("สมาชิกที่บันทึกจริง") && f.Text.Contains("SCM-A"),"reopened bill shows actual stored owner despite different selected member");
                Check(Field<Button>(f.Form,"_btnConfirm").Text=="บันทึกแล้ว","already saved button caption");
                var label=Field<Label>(f.Form,"_receiptStatusLabel"); var divider=Field<Panel>(f.Form,"_pnlDivider");
                Check(label.Visible && label.Bottom<=divider.Top && label.Top>=Field<Label>(f.Form,"_lblTotal").Bottom,"status fits between totals and divider");
                using(var bitmap=new Bitmap(f.Form.Width,f.Form.Height)) {
                    f.Form.DrawToBitmap(bitmap,new Rectangle(Point.Empty,bitmap.Size));
                    bitmap.Save(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"receipt-saved-preview.png"));
                }
                Pump((Task)Call(f.Form,"ConfirmClaimAsync")); Check(server.Posts==1,"reopened bill cannot be transferred by confirming another member");
            }
            claimed=false; fail=true;
            using(var f=new Fixture(api,Receipt())) {
                f.Wait(); f.Select(); Check(!f.Enabled && f.Text.Contains("ตรวจสถานะบิลไม่ได้"),"offline status never enables confirmation");
                fail=false; Call(f.Form,"LoadReceipt",Receipt()); f.Wait(); Check(f.Enabled,"reloading retries status and recovers");
                malformed=true; f.Wait(); Check(!f.Enabled,"malformed successful response is blocked"); malformed=false;
            }
            using(var f=new Fixture(api,Receipt())) {
                f.Wait(); f.Select(); claimed=true;
                Pump((Task)Call(f.Form,"ConfirmClaimAsync"));
                Check(server.Posts==1 && !f.Enabled && f.Text.Contains("สมาชิกที่บันทึกจริง"),"another device winning before submit stops POST");
            }
            claimed=false; race=true;
            using(var f=new Fixture(api,Receipt())) {
                f.Wait(); f.Select(); Pump((Task)Call(f.Form,"ConfirmClaimAsync"));
                Check(server.Posts==2 && !f.Enabled && f.Text.Contains("สมาชิกที่บันทึกจริง"),"409 race refreshes actual stored owner and blocks retry");
            }
            // Delay a prior bill's reply; neither lookup nor UI may use it for a newer bill.
            var gate=new TaskCompletionSource<Reply>(); var oldReceived=new TaskCompletionSource<bool>(); bool first=true;
            server.Respond=(path,body)=> {
                if(path.StartsWith("/api/loyalty/claims/status?")) {
                    if(first) { first=false;oldReceived.SetResult(true);return gate.Task; }
                    return Task.FromResult(new Reply {Json=Status(false,"S-NEW")});
                }
                return Task.FromResult(new Reply {Code=404,Json="{}"});
            };
            using(var f=new Fixture(api,Receipt())) {
                f.Select(); Check(!f.Enabled,"pending lookup blocks confirmation while UI remains usable");
                Pump(oldReceived.Task);
                Task pending=Field<Task>(f.Form,"_receiptStatusCheckTask");
                Call(f.Form,"LoadReceipt",Receipt("S-NEW")); f.Wait(); Check(f.Enabled,"new receipt resolves independently of delayed old one");
                gate.SetResult(new Reply {Json=Status(true)}); Pump(pending);
                Check(f.Enabled && f.Text.Contains("ยังไม่ได้บันทึก"),"late response for old receipt cannot change new bill status");
            }
            server.Respond=(path,body)=>Task.FromResult(new Reply {Json=Status(false,"S-WRONG")});
            bool mismatch=false;try { Pump(api.GetReceiptClaimStatusAsync("004","S-FIXTURE")); }catch(ApiException){mismatch=true;}
            Check(mismatch,"mismatched receipt response is rejected");
        }
    }
    [STAThread] private static int Main() {
        try {
            Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
            // Install the UI context before awaiting HTTP work in the constructor.
            using(var context=new Control()) { context.CreateControl(); SynchronizationContext.SetSynchronizationContext(new WindowsFormsSynchronizationContext()); Run(); }
            Console.WriteLine("{\"ok\":true,\"checks\":"+checks+",\"productionWrites\":0,\"sqlConnections\":0}");return 0;
        }catch(Exception error) { Console.WriteLine("{\"ok\":false,\"checks\":"+checks+",\"error\":\""+error.GetBaseException().Message.Replace("\"","'")+"\"}");return 1; }
    }
}
