using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Threading.Tasks;
using System.Windows.Forms;
using SCCRMonPOS;
using SCCRMonPOS.Models;

// Component integration, not Program.Main: never starts the real AdaPos watcher,
// installs an app, bypasses a production device check, or reads a real receipt.
// Uses actual WinForms events/controls, ApiClient and owned synthetic fixtures.
internal static class PurchaseHistoryCheck
{
    [DataContract] private sealed class Input
    {
        [DataMember] public string BaseUrl;
        [DataMember] public string StaffToken;
        [DataMember] public string MemberId;
        [DataMember] public string Phone;
        [DataMember] public string OtherMemberId;
        [DataMember] public string OtherPhone;
        [DataMember] public string BranchCode;
        [DataMember] public string ReceiptPrefix;
        [DataMember] public string OutputDirectory;
        [DataMember] public bool HistoryOnly;
        [DataMember] public int ExpectedCount;
    }
    private static string stage="input";
    private static int checks;
    private static T Field<T>(object target,string name) { return (T)target.GetType().GetField(name,BindingFlags.Instance|BindingFlags.NonPublic).GetValue(target); }
    private static object Call(object target,string name,params object[] args) { return target.GetType().GetMethod(name,BindingFlags.Instance|BindingFlags.NonPublic).Invoke(target,args); }
    private static void Check(bool ok) { if(!ok)throw new InvalidOperationException();checks++; }
    private static async Task Until(Func<bool> ready)
    {
        var watch=Stopwatch.StartNew();
        while(!ready()) { if(watch.ElapsedMilliseconds>30000)throw new TimeoutException();await Task.Delay(40); }
    }
    private static void ShowOffscreen(Form form)
    {
        form.StartPosition=FormStartPosition.Manual;form.Location=new Point(-20000,-20000);form.ShowInTaskbar=false;form.Show();
    }
    private static PosReceipt Receipt(Input i,string suffix,bool drugOnly)
    {
        var r=new PosReceipt { DocNo=i.ReceiptPrefix+suffix,DocType="1",BranchCode=i.BranchCode,PosCode="TEST-POS",CashierCode="TEST-CASHIER",DocDate=DateTime.Today,DocTime="10:11:12",GrandTotal=drugOnly?100m:340m,Discount=drugOnly?0m:10m };
        if(!drugOnly)r.Items.Add(new PosReceiptItem { Seq=3,ProductCode="TEST-VIT",ProductName="วิตามิน fixture",Barcode="SYNTHETIC-BC",Qty=2,UnitPrice=130m,NetAmount=250m,LineDiscount=10m,PromotionCode="TEST-PROMO" });
        r.Items.Add(new PosReceiptItem { Seq=5,ProductCode="TEST-DRUG",ProductName="เภสัช fixture",Barcode="SYNTHETIC-DRUG",Qty=1,UnitPrice=100m,NetAmount=100m });return r;
    }
    private static void Capture(Form form,string path)
    {
        using(var bitmap=new Bitmap(form.Width,form.Height)) { form.DrawToBitmap(bitmap,new Rectangle(Point.Empty,form.Size));bitmap.Save(path,System.Drawing.Imaging.ImageFormat.Png); }
    }
    private static async Task Confirm(ApiClient api,Input input,string phone,string memberId,string suffix,bool drugOnly)
    {
        stage="select-member-and-confirm-"+suffix;
        using(var display=new CustomerDisplayController(Path.Combine(input.OutputDirectory,"synthetic-display")))
        using(var form=new MemberClaimForm(api,null,25,"synthetic-history-test",Receipt(input,suffix,drugOnly),display))
        {
            ShowOffscreen(form);
            Field<TextBox>(form,"_txtMemberSearch").Text=phone;
            Field<Button>(form,"_btnSearch").PerformClick();
            var grid=Field<DataGridView>(form,"_dgvResults");
            await Until(()=>grid.Rows.Count>0 && Field<Button>(form,"_btnSearch").Enabled);
            Check(Field<MemberSearchResult>(form,"_selectedMember").Id==memberId);
            Check(Field<Button>(form,"_btnConfirm").Enabled);
            Field<Button>(form,"_btnConfirm").PerformClick();
            Check(!grid.Enabled && !Field<Button>(form,"_btnConfirm").Enabled);
            await Until(()=>Field<Label>(form,"_lblStatus").Text.StartsWith("บันทึกบิลสำเร็จ",StringComparison.Ordinal));
            Check(!Field<Button>(form,"_btnConfirm").Enabled);
            if(drugOnly)Check(Field<Label>(form,"_lblStatus").Text.Contains("ได้รับ 0 แต้ม"));
            form.Close();
        }
    }
    private static async Task History(ApiClient api,Input input)
    {
        stage="history-first-bill-and-member-switch";
        using(var form=new PurchaseHistoryForm(api,input.MemberId,"Synthetic QR member"))
        {
            ShowOffscreen(form);
            var grid=Field<DataGridView>(form,"_dgvPurchases");
            await Until(()=>grid.Rows.Count>0 && !Field<bool>(form,"_loadingPage"));
            Check(Field<ListView>(form,"_lvItems").Items.Count>0);
            var older=Field<Button>(form,"_btnOlder");
            while(older.Visible)
            {
                int count=grid.Rows.Count;older.PerformClick();
                await Until(()=>!Field<bool>(form,"_loadingPage"));
                Check(grid.Rows.Count>count);
            }
            Check(grid.Rows.Count==input.ExpectedCount);
            Check(grid.Rows.Cast<DataGridViewRow>().Select(r=>((PurchaseRecord)r.Tag).ClaimId).Distinct().Count()==input.ExpectedCount);
            var mixed=grid.Rows.Cast<DataGridViewRow>().Single(r=>((PurchaseRecord)r.Tag).ReceiptNo==input.ReceiptPrefix+"MIXED");
            grid.ClearSelection();mixed.Selected=true;
            var bill=(PurchaseRecord)mixed.Tag;
            Check(bill.TotalAmount==340m && bill.EligibleAmount==250m && bill.Items.Length==2);
            Check(bill.Items[0].Seq==3 && bill.Items[0].Barcode=="SYNTHETIC-BC" && bill.Items[0].LineDiscount==10m && bill.Items[0].PromotionCode=="TEST-PROMO");
            Check(Field<ListView>(form,"_lvItems").Items.Count==2);
            Check(Field<Label>(form,"_lblReceipt").Text.Contains("TEST-POS"));
            Capture(form,Path.Combine(input.OutputDirectory,"member-purchase-history.png"));
            // Rapid selection must finish with the last selected member's rows.
            var first=(Task)Call(form,"LoadHistoryAsync",input.MemberId,"First",false);
            var last=(Task)Call(form,"LoadHistoryAsync",input.OtherMemberId,"Other",false);
            await Task.WhenAll(first,last);
            Check(grid.Rows.Count==1 && ((PurchaseRecord)grid.Rows[0].Tag).ReceiptNo==input.ReceiptPrefix+"OTHER");
            Field<TextBox>(form,"_txtSearch").Text=input.Phone;
            Field<Button>(form,"_btnSearch").PerformClick();
            await Until(()=>!Field<bool>(form,"_loadingPage") && grid.Rows.Count>0 && Field<string>(form,"_memberId")==input.MemberId);
            Check(!grid.Rows.Cast<DataGridViewRow>().Any(r=>((PurchaseRecord)r.Tag).ReceiptNo==input.ReceiptPrefix+"OTHER"));
            // No-match search must clear the former member and their bill details.
            Field<TextBox>(form,"_txtSearch").Text=input.ReceiptPrefix+"NO-MEMBER";
            Field<Button>(form,"_btnSearch").PerformClick();
            await Until(()=>Field<Button>(form,"_btnSearch").Enabled);
            Check(grid.Rows.Count==0 && Field<ListView>(form,"_lvItems").Items.Count==0 && Field<string>(form,"_memberId")==null);
            form.Close();
        }
    }
    private static void Offline()
    {
        stage="offline-zero-points-and-return-guard";
        var input=new Input {BranchCode="TEST_FIXTURE",ReceiptPrefix="HISTORYTEST-"};
        using(var display=new CustomerDisplayController(Path.Combine(Path.GetTempPath(),"sccrm-history-offline")))
        using(var form=new MemberClaimForm(new ApiClient("http://127.0.0.1:1"),null,25,"synthetic",Receipt(input,"ZERO",true),display))
        {
            Call(form,"AddMemberRow",new MemberSearchResult { Id="synthetic",DisplayName="Synthetic",PointsAvailable=true });
            Call(form,"SelectMemberAtRow",0);
            Check((bool)Call(form,"CanConfirm"));
            var request=(LoyaltyClaimRequest)Call(form,"BuildClaimRequest");
            Check(request.TotalAmount==0m && request.ReceiptTotalAmount==100m && request.Items.Length==1);
            string json=(string)typeof(ApiClient).GetMethod("BuildLoyaltyClaimJson",BindingFlags.Static|BindingFlags.NonPublic).Invoke(null,new object[]{request});
            Check(json.Contains("\"receiptTotalAmount\":100") && json.Contains("SYNTHETIC-DRUG"));
            var receipt=Field<PosReceipt>(form,"_receipt");receipt.IsReturn=true;Check(!(bool)Call(form,"CanConfirm"));
            receipt.IsReturn=false;receipt.DocType="9";Check(!(bool)Call(form,"CanConfirm"));
        }
    }
    [STAThread] private static int Main(string[] args)
    {
        Application.EnableVisualStyles();Application.SetCompatibleTextRenderingDefault(false);
        try
        {
            if(args.Length==0)Offline();
            else
            {
                Check(args.Length==1 && args[0]=="--live");
                var input=(Input)new DataContractJsonSerializer(typeof(Input)).ReadObject(Console.OpenStandardInput());
                Check(input.BaseUrl=="https://sc-official-website.onrender.com" || input.BaseUrl.StartsWith("http://127.0.0.1:"));
                Check(input.BranchCode.StartsWith("TEST_") && input.ReceiptPrefix.StartsWith("HISTORYTEST-"));
                Environment.SetEnvironmentVariable("SCCRMONPOS__ApiBaseUrl",input.BaseUrl);
                Directory.CreateDirectory(input.OutputDirectory);
                var api=new ApiClient(input.BaseUrl);api.SetStaffToken(input.StaffToken);
                Exception failure=null;
                using(var host=new Form { ShowInTaskbar=false,Opacity=0,Size=new Size(1,1) })
                {
                    host.Shown+=async (s,e)=>{try { if(!input.HistoryOnly) { await Confirm(api,input,input.Phone,input.MemberId,"MIXED",false);await Confirm(api,input,input.Phone,input.MemberId,"ZERO",true);await Confirm(api,input,input.OtherPhone,input.OtherMemberId,"OTHER",false); }await History(api,input); } catch(Exception ex) {failure=ex;}finally {host.Close();}};
                    Application.Run(host);
                }
                if(failure!=null)throw failure;
            }
            Console.WriteLine("{\"ok\":true,\"checks\":"+checks+",\"applicationVersion\":\""+typeof(ApiClient).Assembly.GetName().Version+"\",\"adaAccAccessed\":false,\"appInstalled\":false}");return 0;
        }
        catch(Exception error) {Console.WriteLine("{\"ok\":false,\"stage\":\""+stage+"\",\"type\":\""+error.GetType().Name+"\"}");return 1;}
    }
}
