using System;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Reflection;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Threading.Tasks;

// Separate process per binary: no linked/recompiled replacement for old ApiClient.
// All credentials arrive on stdin; fixture IDs and summaries only go to stdout.
internal static class PromotionCompatibilityCheck
{
    [DataContract] private sealed class Input
    {
        [DataMember] public string BaseUrl;
        [DataMember] public string StaffToken;
        [DataMember] public string MemberId;
        [DataMember] public string Phone;
        [DataMember] public string BranchCode;
        [DataMember] public string ReceiptNo;
        [DataMember] public decimal Amount;
        [DataMember] public int ExpectedPoints;
        [DataMember] public bool Duplicate;
    }
    [DataContract] private sealed class Catalog
    {
        [DataMember(Name="revision")] public string Revision;
        [DataMember(Name="promotions")] public Promotion[] Promotions;
    }
    [DataContract] private sealed class Promotion { [DataMember(Name="id")] public string Id; }
    private static int checks;
    private static string stage = "input";
    private static void Check(bool ok) { if(!ok)throw new InvalidOperationException();checks++; }
    private static object Await(object value) { var task=(Task)value;task.GetAwaiter().GetResult();return task.GetType().GetProperty("Result").GetValue(task); }
    private static object Call(object obj,string method,params object[] args) { return obj.GetType().GetMethod(method).Invoke(obj,args); }
    private static object Get(object obj,string name) { return obj.GetType().GetProperty(name).GetValue(obj); }
    private static void Set(object obj,string name,object value) { obj.GetType().GetProperty(name).SetValue(obj,value); }
    private static int Main(string[] args)
    {
        try
        {
            if(args.Length!=1)throw new InvalidOperationException();
            var input=(Input)new DataContractJsonSerializer(typeof(Input)).ReadObject(Console.OpenStandardInput());
            Check(input.BaseUrl=="https://sc-official-website.onrender.com" || input.BaseUrl.StartsWith("http://127.0.0.1:"));
            Check(input.BranchCode.StartsWith("TEST_",StringComparison.Ordinal) && input.ReceiptNo.StartsWith("PROMOTEST-",StringComparison.Ordinal));
            Environment.SetEnvironmentVariable("SCCRMONPOS__ApiBaseUrl",input.BaseUrl);
            var assembly=Assembly.LoadFrom(Path.GetFullPath(args[0]));
            string version=assembly.GetName().Version.ToString();
            Check(version=="1.1.0.0" || version=="1.2.0.0");
            stage="shared-web-catalog";
            Catalog catalog;
            using(var http=new HttpClient { Timeout=TimeSpan.FromSeconds(20) })
            {
                var raw=http.GetByteArrayAsync(input.BaseUrl+"/api/sccrm/promotions/active?branchCode="+Uri.EscapeDataString(input.BranchCode)).GetAwaiter().GetResult();
                using(var ms=new MemoryStream(raw)) catalog=(Catalog)new DataContractJsonSerializer(typeof(Catalog)).ReadObject(ms);
                Check(catalog!=null && !string.IsNullOrWhiteSpace(catalog.Revision));
                var page=http.GetAsync(input.BaseUrl+"/sccrm/promotions?branchCode="+Uri.EscapeDataString(input.BranchCode)).GetAwaiter().GetResult();
                Check(page.IsSuccessStatusCode);
            }
            var central=assembly.GetType("SCCRMonPOS.CentralPromotions");
            if(central!=null)
            {
                stage="native-central-quote";
                var quote=Await(central.GetMethod("QuoteAsync").Invoke(null,new object[]{input.Amount,input.BranchCode}));
                Check((int)Get(quote,"AwardedPoints")==input.ExpectedPoints);
                Check((string)Get(quote,"Revision")==catalog.Revision);
            }
            stage="native-search";
            var api=Activator.CreateInstance(assembly.GetType("SCCRMonPOS.ApiClient"),input.BaseUrl);
            Call(api,"SetStaffToken",input.StaffToken);
            var members=(Array)Await(Call(api,"SearchMembersAsync",input.Phone));
            Check(members.Cast<object>().Any(m=>(string)Get(m,"Id")==input.MemberId && (bool)Get(m,"PointsAvailable")));
            stage="native-claim";
            var request=Activator.CreateInstance(assembly.GetType("SCCRMonPOS.LoyaltyClaimRequest"));
            foreach(var entry in new[]{new[]{"ReceiptNo",input.ReceiptNo},new[]{"BranchCode",input.BranchCode},new[]{"MemberId",input.MemberId},new[]{"CashierStaffCode","synthetic-promotion-test"},new[]{"SoldAt",DateTime.UtcNow.ToString("o")}})Set(request,entry[0],entry[1]);
            Set(request,"TotalAmount",input.Amount);Set(request,"PreviewPoints",999999);
            var item=Activator.CreateInstance(assembly.GetType("SCCRMonPOS.LoyaltyClaimItem"));
            Set(item,"ProductCode","SCCRM-PROMO-TEST");Set(item,"ProductName","Synthetic promotion fixture");Set(item,"Qty",1m);Set(item,"UnitPrice",input.Amount);Set(item,"LineTotal",input.Amount);
            var items=Array.CreateInstance(item.GetType(),1);items.SetValue(item,0);Set(request,"Items",items);
            object response=null;bool rejected=false;
            try { response=Await(Call(api,"SubmitLoyaltyClaimAsync",request)); }
            catch(Exception error) { var cause=error is TargetInvocationException?error.InnerException:error;rejected=cause.GetType().Name=="ApiException" && cause.Message.IndexOf("already claimed",StringComparison.OrdinalIgnoreCase)>=0;if(!rejected)throw; }
            if(input.Duplicate)Check(rejected);
            else { Check(!rejected && (bool)Get(response,"Ok"));Check((int)Get(response,"AwardedPoints")==input.ExpectedPoints); }
            Console.WriteLine("{\"ok\":true,\"applicationVersion\":\""+version+"\",\"checks\":"+checks+",\"catalogSurface\":\"shared-web\",\"nativeQuote\":"+(central!=null?"true":"false")+",\"catalogRevision\":\""+catalog.Revision+"\",\"promotionIds\":["+string.Join(",",catalog.Promotions.Select(p=>"\""+p.Id+"\""))+"],\"awardedPoints\":"+(response!=null?Get(response,"AwardedPoints").ToString():"null")+"}");
            return 0;
        }
        catch(Exception error) { Console.WriteLine("{\"ok\":false,\"stage\":\""+stage+"\",\"type\":\""+error.GetType().Name+"\"}");return 1; }
    }
}
