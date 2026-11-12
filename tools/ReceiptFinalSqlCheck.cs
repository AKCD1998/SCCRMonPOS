using System;
using System.Collections.Generic;
using System.Data.SqlClient;
using System.IO;
using System.Linq;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using SCCRMonPOS;

[DataContract] internal sealed class FinalCopyInput {
    [DataMember] public string Server,Database,User,Password;
    [DataMember] public FinalCopyCase[] Cases;
}
[DataContract] internal sealed class FinalCopyCase {
    [DataMember] public string Branch,Pos,Doc;
    [DataMember] public decimal Total,Discount;
    [DataMember] public int Lines;
    [DataMember] public bool ExpectActive;
    [DataMember] public bool ExpectMissing;
}
internal static class ReceiptFinalSqlCheck {
    private static int Main() {
        FinalCopyInput input=null;
        try {
            using(var stream=new MemoryStream(System.Text.Encoding.UTF8.GetBytes(Console.In.ReadToEnd())))
                input=(FinalCopyInput)new DataContractJsonSerializer(typeof(FinalCopyInput)).ReadObject(stream);
            if(input.Server!="tcp:100.90.166.72,49800" || !System.Text.RegularExpressions.Regex.IsMatch(input.Database??"","^SCCRM_ReceiptTimeCopy_20261111_00[1345]$") || input.Cases==null)throw new Exception("copy-only");
            Environment.SetEnvironmentVariable("SCCRMONPOS__AdaPosDbServer",input.Server);
            Environment.SetEnvironmentVariable("SCCRMONPOS__AdaPosDbName",input.Database);
            Environment.SetEnvironmentVariable("SCCRMONPOS__AdaPosDbUser",input.User);
            Environment.SetEnvironmentVariable("SCCRMONPOS__AdaPosDbPassword",input.Password);
            var builder=new SqlConnectionStringBuilder {DataSource=input.Server,InitialCatalog=input.Database,UserID=input.User,Password=input.Password,ConnectTimeout=5};
            using(var conn=new SqlConnection(builder.ConnectionString)) {
                conn.Open();using(var cmd=new SqlCommand("SELECT COUNT(*) FROM dbo.SCCRM_TimeCopyOwner WHERE marker='4afc7446-846e-4d6a-8a1b-e672655b1a38'",conn))
                    if(Convert.ToInt32(cmd.ExecuteScalar())!=1)throw new Exception("copy-marker");
            }
            int reads=0;
            foreach(var c in input.Cases)using(var watcher=new AdaPosWatcher(null,false,new ReceiptTerminalScope(c.Branch,c.Pos))) {
                var r=watcher.LoadReceiptByDocNo(c.Doc);
                if(c.ExpectMissing) {
                    if(r!=null)throw new Exception("unpaid-live-fallback");
                    reads++;continue;
                }
                if(r==null||!r.FinalSnapshotVerified||r.GrandTotal!=c.Total||r.Discount!=c.Discount||r.Items.Count!=c.Lines||!FinalReceiptSnapshot.IsPaid(r))throw new Exception("final-read");
                if(c.ExpectActive && r.HeaderTable!="TSHD"+c.Pos)throw new Exception("active-table-precedence");
                var again=watcher.LoadReceiptByDocNo(c.Doc);
                if(again==null||FinalReceiptSnapshot.Fingerprint(r)!=FinalReceiptSnapshot.Fingerprint(again))throw new Exception("changed-read");
                reads+=2;
            }
            Console.WriteLine("{\"ok\":true,\"finalReads\":"+reads+",\"productionWrites\":0}");return 0;
        }catch(Exception e){Console.WriteLine("{\"ok\":false,\"type\":\""+e.GetType().Name+"\",\"code\":\""+(e.Message=="final-read"?"FINAL_READ_FAILED":"COPY_CHECK_FAILED")+"\"}");return 1;}
        finally{foreach(string key in new[]{"AdaPosDbServer","AdaPosDbName","AdaPosDbUser","AdaPosDbPassword"})Environment.SetEnvironmentVariable("SCCRMONPOS__"+key,null);if(input!=null)input.Password=null;}
    }
}
