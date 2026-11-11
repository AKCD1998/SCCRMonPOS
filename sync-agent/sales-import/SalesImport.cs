using System;
using System.Collections.Generic;
using System.Data;
using System.Data.SqlClient;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Security.Cryptography;
using System.Security.Principal;
using System.ServiceProcess;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Xml;

// One headless process. No UI automation, child processes, customer/PIN reads or point writes.
public sealed class SalesImport : ServiceBase {
 const string Scope="SCCRM-HQ-SALES-IMPORT-V1";
 static readonly string[] Tables={"TPSTSalHD","TPSTSalDT","TPSTSalRC","TPSTSalPD","TPSTSalPG","TPSTSalPH","TPSTSalInvCsm","TPSTVoidDT"};
 static readonly JavaScriptSerializer Json=new JavaScriptSerializer { MaxJsonLength=8388608 };
 static readonly CultureInfo CI=CultureInfo.InvariantCulture;
 static string Root=AppDomain.CurrentDomain.BaseDirectory;
 readonly ManualResetEvent stop=new ManualResetEvent(false); Thread thread;
 public SalesImport(){ServiceName="SCCRMHQSalesImport";CanStop=true;AutoLog=false;}
 protected override void OnStart(string[] args){thread=new Thread(Run);thread.IsBackground=true;thread.Start();}
 protected override void OnStop(){stop.Set();if(thread!=null)thread.Join(20000);}
 static Dictionary<string,object> Obj(object x){return (Dictionary<string,object>)x;}
 static string S(Dictionary<string,object> x,string k){return x.ContainsKey(k)&&x[k]!=null?Convert.ToString(x[k],CI):"";}
 static object V(Dictionary<string,object> x,string k){return x.ContainsKey(k)&&x[k]!=null?x[k]:DBNull.Value;}
 static void Atomic(string file,object value){string temp=file+".new";File.WriteAllText(temp,Json.Serialize(value),new UTF8Encoding(false));if(File.Exists(file))File.Replace(temp,file,file+".previous");else File.Move(temp,file);}
 static string Hash(string text){using(var h=SHA256.Create())return BitConverter.ToString(h.ComputeHash(Encoding.UTF8.GetBytes(text))).Replace("-","").ToLowerInvariant();}
 static string SafeCode(Exception e){var q=e as SqlException;if(q!=null){foreach(SqlError se in q.Errors){if(se.Message.StartsWith("SALES_",StringComparison.Ordinal)){string code=se.Message.Split('\r','\n',' ')[0];if(System.Text.RegularExpressions.Regex.IsMatch(code,"^SALES_[A-Z_0-9]+$"))return code;}}if(q.Number==2601||q.Number==2627)return "SALES_NATIVE_KEY_COLLISION";if(q.Number==1222||q.Number==1205||q.Number==-2)return "SALES_SQL_BUSY";if(q.Number==18456)return "SALES_LOGIN_FAILED";}return "SALES_CONNECTION_OR_OPERATION_FAILED";}
 static SqlConnection Open(Dictionary<string,object> target){
  var b=new SqlConnectionStringBuilder();b.DataSource=S(target,"server");b.InitialCatalog=S(target,"database");b.UserID=S(target,"user");b.Password=S(target,"password");b.ConnectTimeout=3;b.Pooling=true;b.MaxPoolSize=4;b.ApplicationName="SCCRM-HQ-Sales-Import";b.TrustServerCertificate=true;
  var db=new SqlConnection(b.ConnectionString);try{db.Open();using(var q=db.CreateCommand()){q.CommandTimeout=5;q.CommandText="SET LOCK_TIMEOUT 750;SET DEADLOCK_PRIORITY LOW;SET ANSI_NULLS ON;SET ANSI_PADDING ON;SET ANSI_WARNINGS ON;SET ARITHABORT ON;SET CONCAT_NULL_YIELDS_NULL ON;SET QUOTED_IDENTIFIER ON;SET NUMERIC_ROUNDABORT OFF;SELECT CONVERT(varchar(128),SERVERPROPERTY('MachineName')),DB_NAME(),ORIGINAL_LOGIN()";using(var r=q.ExecuteReader()){if(!r.Read()||r.GetString(0)!=S(target,"machine")||r.GetString(1)!=S(target,"database")||r.GetString(2)!=S(target,"user"))throw new Exception("SALES_TARGET_IDENTITY_REFUSED");}}return db;}catch{db.Dispose();throw;}
 }
 static List<Dictionary<string,object>> Read(SqlCommand q){var rows=new List<Dictionary<string,object>>();using(var r=q.ExecuteReader())while(r.Read()){var row=new Dictionary<string,object>();for(int i=0;i<r.FieldCount;i++){object v=r.GetValue(i);row[r.GetName(i)]=v==DBNull.Value?null:v is DateTime?((DateTime)v).ToString("o",CI):v;}rows.Add(row);}return rows;}
 static List<Dictionary<string,object>> Queue(Dictionary<string,object> cfg,string action,string branch,Dictionary<string,object> args){using(var db=Open(Obj(cfg["hq"])))using(var q=db.CreateCommand()){q.CommandType=CommandType.StoredProcedure;q.CommandText="dbo.SCCRM_SalesQueue";q.CommandTimeout=8;q.Parameters.Add("@Action",SqlDbType.VarChar,20).Value=action;if(!String.IsNullOrEmpty(branch))q.Parameters.Add("@Branch",SqlDbType.Char,3).Value=branch;
  var defs=new Dictionary<string,SqlDbType>{{"Doc",SqlDbType.VarChar},{"Id",SqlDbType.UniqueIdentifier},{"Lease",SqlDbType.UniqueIdentifier},{"Packet",SqlDbType.NVarChar},{"Hash",SqlDbType.Char},{"Code",SqlDbType.VarChar},{"Review",SqlDbType.Bit}};
  if(args!=null)foreach(var p in args){var n=q.Parameters.Add("@"+p.Key,defs[p.Key]);if(p.Key=="Packet")n.Size=-1;else if(p.Key=="Hash")n.Size=64;else if(p.Key=="Doc")n.Size=20;else if(p.Key=="Code")n.Size=80;n.Value=(p.Key=="Id"||p.Key=="Lease")?(object)new Guid(Convert.ToString(p.Value,CI)):p.Value;}return Read(q);}}
 static Dictionary<string,object> Target(Dictionary<string,object> cfg,string branch){return Obj(Obj(cfg["sources"])[branch]);}
 static string Capture(Dictionary<string,object> cfg,string branch,string doc){
  var x=new XmlDocument();var root=x.CreateElement("receipt");x.AppendChild(root);root.SetAttribute("schema",S(cfg,"schema"));root.SetAttribute("doc",doc);root.SetAttribute("branch",branch);var space=x.CreateAttribute("xml","space","http://www.w3.org/XML/1998/namespace");space.Value="preserve";root.Attributes.Append(space);
  using(var db=Open(Target(cfg,branch)))using(var q=db.CreateCommand()){
   q.CommandTimeout=8;var sql=new StringBuilder();foreach(string t in Tables){string order=t=="TPSTSalHD"?"FTShdDocNo":t=="TPSTVoidDT"?"FTVidSeq,FNSdtSeqNo":t=="TPSTSalPD"?"FTPmhCode,FTSpdGrpName,FTSpdBarCode,FNSdtSeqNo":t=="TPSTSalDT"?"FNSdtSeqNo":t=="TPSTSalRC"?"FNSrcSeqNo":t=="TPSTSalInvCsm"?"FNSicSeqNo,FTPdtCode":t=="TPSTSalPG"?"FTPmhCode,FTSpgGrpName":"FTPmhCode";sql.Append("SELECT * FROM dbo.[SCCRM_SalesExport_"+t+"] WHERE FTShdDocNo=@doc ORDER BY "+order+";");}q.CommandText=sql.ToString();q.Parameters.Add("@doc",SqlDbType.VarChar,20).Value=doc;
   using(var r=q.ExecuteReader())for(int ti=0;ti<Tables.Length;ti++){if(ti>0&&!r.NextResult())throw new Exception("SALES_PACKET_TABLE_REQUIRED");var te=x.CreateElement(Tables[ti]);root.AppendChild(te);int count=0;while(r.Read()){if(++count>1000)throw new Exception("SALES_PACKET_TOO_LARGE");var row=x.CreateElement("r");te.AppendChild(row);for(int i=0;i<r.FieldCount;i++){var c=x.CreateElement(r.GetName(i));row.AppendChild(c);if(r.IsDBNull(i)){c.SetAttribute("null","1");continue;}object value=r.GetValue(i);c.InnerText=value is DateTime?((DateTime)value).ToString("yyyy-MM-ddTHH:mm:ss.fff",CI):value is double?((double)value).ToString("R",CI):Convert.ToString(value,CI);}}}
  }
  if(root.SelectNodes("TPSTSalHD/r").Count!=1||root.SelectNodes("TPSTSalDT/r").Count==0)throw new Exception("SALES_SOURCE_NOT_FINAL");return x.OuterXml;
 }
 static List<Dictionary<string,object>> Discover(Dictionary<string,object> cfg,string branch,string prefix,string after){using(var db=Open(Target(cfg,branch)))using(var q=db.CreateCommand()){
  q.CommandTimeout=8;q.CommandText="SELECT TOP(25) FTShdDocNo FROM dbo.SCCRM_SalesExport_TPSTSalHD WHERE FTShdDocNo LIKE @prefix AND FTShdDocNo>@after AND FDShdDocDate>=@floor AND DATEADD(second,90,CONVERT(datetime,CONVERT(char(10),FDShdDocDate,120)+' '+FTShdDocTime,120))<=GETDATE() ORDER BY FTShdDocNo";
  q.Parameters.Add("@prefix",SqlDbType.VarChar,21).Value=prefix+"%";q.Parameters.Add("@after",SqlDbType.VarChar,20).Value=after;DateTime floor=cfg.ContainsKey("scanFloor")?DateTime.ParseExact(S(cfg,"scanFloor"),"yyyyMMdd",CI):DateTime.Now.Date.AddDays(-3);if(floor<new DateTime(2026,11,8))floor=new DateTime(2026,11,8);q.Parameters.Add("@floor",SqlDbType.DateTime).Value=floor;return Read(q);}}
 static List<Dictionary<string,object>> Apply(Dictionary<string,object> cfg,string id,string lease){using(var db=Open(Obj(cfg["hq"])))using(var q=db.CreateCommand()){q.CommandTimeout=12;q.CommandType=CommandType.StoredProcedure;q.CommandText="dbo.SCCRM_SalesApply";q.Parameters.Add("@Id",SqlDbType.UniqueIdentifier).Value=new Guid(id);q.Parameters.Add("@Lease",SqlDbType.UniqueIdentifier).Value=new Guid(lease);return Read(q);}}
 static object Deliver(Dictionary<string,object> cfg,string branch){var jobs=Queue(cfg,"Lease",branch,null);if(jobs.Count==0||jobs[0].ContainsKey("paused"))return new { idle=true };var job=jobs[0];string id=S(job,"id"),lease=S(job,"lease_token");try{
  if(job["packet"]==null){string packet=Capture(cfg,branch,S(job,"doc_no"));if(Hash(packet)!=Hash(Capture(cfg,branch,S(job,"doc_no"))))throw new Exception("SALES_SOURCE_CHANGED");Queue(cfg,"Prepare",branch,new Dictionary<string,object>{{"Id",id},{"Lease",lease},{"Packet",packet},{"Hash",Hash(packet)}});}
  return Apply(cfg,id,lease);
 }catch(Exception e){string code=System.Text.RegularExpressions.Regex.IsMatch(e.Message,"^SALES_[A-Z_0-9]+$")?e.Message:SafeCode(e);bool review=code=="SALES_NATIVE_KEY_COLLISION"||code=="SALES_EXISTING_RECORD_DIFFERENT"||code=="SALES_PARTIAL_DESTINATION"||code=="SALES_NATIVE_TRIGGER_REVIEW"||code=="SALES_PACKET_IDENTITY_REFUSED"||code=="SALES_HEADER_NOT_FINAL";Queue(cfg,"Fail",branch,new Dictionary<string,object>{{"Id",id},{"Lease",lease},{"Code",code},{"Review",review}});return new {id=id,code=code,review=review};}}
 static Dictionary<string,object> LoadSecrets(){
  string keyFile=Path.Combine(Root,"runtime/bootstrap-key.dpapi");using(var rsa=new RSACryptoServiceProvider(4096)){rsa.PersistKeyInCsp=false;if(!File.Exists(keyFile)){byte[] raw=Encoding.UTF8.GetBytes(rsa.ToXmlString(true));try{File.WriteAllBytes(keyFile,ProtectedData.Protect(raw,null,DataProtectionScope.LocalMachine));}finally{Array.Clear(raw,0,raw.Length);}}else{byte[] raw=ProtectedData.Unprotect(File.ReadAllBytes(keyFile),null,DataProtectionScope.LocalMachine);try{rsa.FromXmlString(Encoding.UTF8.GetString(raw));}finally{Array.Clear(raw,0,raw.Length);}}
   var pub=rsa.ExportParameters(false);Atomic(Path.Combine(Root,"status/bootstrap-public.json"),new {kty="RSA",n=Convert.ToBase64String(pub.Modulus).TrimEnd('=').Replace('+','-').Replace('/','_'),e=Convert.ToBase64String(pub.Exponent).TrimEnd('=').Replace('+','-').Replace('/','_')});
   string file=Path.Combine(Root,"runtime/credentials.hybrid.json");if(!File.Exists(file))return null;var p=Obj(Json.DeserializeObject(File.ReadAllText(file)));byte[] key=rsa.Decrypt(Convert.FromBase64String(S(p,"encryptedKey")),true);byte[] iv=Convert.FromBase64String(S(p,"iv")),cipher=Convert.FromBase64String(S(p,"ciphertext")),mac=Convert.FromBase64String(S(p,"mac"));try{if(key.Length!=64||iv.Length!=16||mac.Length!=32||cipher.Length>65536)throw new Exception("SALES_SECRET_REFUSED");byte[] akey=new byte[32],mkey=new byte[32];Array.Copy(key,akey,32);Array.Copy(key,32,mkey,0,32);byte[] prefix=Encoding.UTF8.GetBytes("SCCRM-SALES-SECRETS-V1\0"),input=new byte[prefix.Length+iv.Length+cipher.Length];Array.Copy(prefix,input,prefix.Length);Array.Copy(iv,0,input,prefix.Length,iv.Length);Array.Copy(cipher,0,input,prefix.Length+iv.Length,cipher.Length);using(var h=new HMACSHA256(mkey)){byte[] computed=h.ComputeHash(input);int diff=0;for(int i=0;i<32;i++)diff|=computed[i]^mac[i];if(diff!=0)throw new Exception("SALES_SECRET_REFUSED");}using(var aes=Aes.Create()){aes.Key=akey;aes.IV=iv;using(var d=aes.CreateDecryptor()){byte[] plain=d.TransformFinalBlock(cipher,0,cipher.Length);try{return Obj(Json.DeserializeObject(Encoding.UTF8.GetString(plain)));}finally{Array.Clear(plain,0,plain.Length);}}}}finally{Array.Clear(key,0,key.Length);}}
 }
 void Run(){
  Process.GetCurrentProcess().PriorityClass=ProcessPriorityClass.BelowNormal;Dictionary<string,object> cfg=null;var cursors=new Dictionary<string,string>();var completed=new HashSet<string>();var next=new Dictionary<string,DateTime>();var results=new Dictionary<string,object>();
  while(!stop.WaitOne(0)){try{
   if(Environment.MachineName!="SERVER"||WindowsIdentity.GetCurrent().User.Value!="S-1-5-19"||Process.GetCurrentProcess().SessionId!=0)throw new Exception("SALES_SERVICE_IDENTITY_REFUSED");
   if(cfg==null)cfg=LoadSecrets();if(cfg==null){Status("awaiting_credentials",results,null);stop.WaitOne(3000);continue;}if(S(cfg,"scope")!=Scope)throw new Exception("SALES_SCOPE_REFUSED");
   foreach(string branch in new[]{"005","001","003","004"}){if(stop.WaitOne(0))break;if(next.ContainsKey(branch)&&next[branch]>DateTime.UtcNow)continue;
    try{var status=Queue(cfg,"Status",null,null);bool enabled=false;DateTime floor=DateTime.Now.Date.AddDays(-3);foreach(var s in status)if(S(s,"branch_code")==branch){if(Convert.ToBoolean(s["enabled"],CI))enabled=true;DateTime last=String.IsNullOrEmpty(S(s,"last_scan_at"))?new DateTime(2026,11,8):DateTime.SpecifyKind(DateTime.Parse(S(s,"last_scan_at"),CI),DateTimeKind.Utc).ToLocalTime().Date.AddDays(-1);if(last<floor)floor=last;}if(floor<new DateTime(2026,11,8))floor=new DateTime(2026,11,8);cfg["scanFloor"]=floor.ToString("yyyyMMdd",CI);if(!enabled){results[branch]=new{state="paused"};continue;}
     // A frozen packet is deliverable even while its source is offline.
     for(int i=0;i<12&&!stop.WaitOne(0);i++){string r=Json.Serialize(Deliver(cfg,branch));if(r.Contains("\"idle\":true")||r.Contains("\"code\":"))break;}
     // Commit discovered keys before advancing a volatile page cursor; restarting replays safely.
     var prefixes=new List<string>();for(DateTime month=new DateTime(floor.Year,floor.Month,1);month<=DateTime.Now;month=month.AddMonths(1))foreach(string pos in new[]{"001","002"})foreach(string type in new[]{"S","R"}){string prefix=type+month.ToString("yyMM",CI)+branch+pos+"-";prefixes.Add(prefix);if(completed.Contains(prefix))continue;string after=cursors.ContainsKey(prefix)?cursors[prefix]:prefix;var docs=Discover(cfg,branch,prefix,after);foreach(var doc in docs)Queue(cfg,"Enqueue",branch,new Dictionary<string,object>{{"Doc",doc["FTShdDocNo"]}});if(docs.Count<25)completed.Add(prefix);else cursors[prefix]=S(docs[docs.Count-1],"FTShdDocNo");}
     bool allDone=true;foreach(string prefix in prefixes)if(!completed.Contains(prefix))allDone=false;if(allDone){Queue(cfg,"MarkScan",branch,null);foreach(string prefix in prefixes){completed.Remove(prefix);cursors.Remove(prefix);}}
     for(int i=0;i<12&&!stop.WaitOne(0);i++){string r=Json.Serialize(Deliver(cfg,branch));if(r.Contains("\"idle\":true")||r.Contains("\"code\":"))break;}results[branch]=new{state="online",at=DateTime.UtcNow.ToString("o",CI)};
    }catch(Exception e){results[branch]=new{state="retry",code=SafeCode(e),at=DateTime.UtcNow.ToString("o",CI)};next[branch]=DateTime.UtcNow.AddSeconds(10);}
    Status("running",results,Queue(cfg,"Status",null,null));
   }
  }catch(Exception e){Status("retry",results,new{code=SafeCode(e)});}stop.WaitOne(2000);}
  Status("stopped",results,null);
 }
 static void Status(string state,object branches,object queue){Atomic(Path.Combine(Root,"status/health.json"),new{scope=Scope,state=state,at=DateTime.UtcNow.ToString("o",CI),machine=Environment.MachineName,account=WindowsIdentity.GetCurrent().Name,session=Process.GetCurrentProcess().SessionId,pid=Process.GetCurrentProcess().Id,branches=branches,queue=queue});}
 public static void Main(string[] args){if(args.Length==0){ServiceBase.Run(new SalesImport());return;}if(args.Length!=1||args[0]!="--call")return;
  Console.InputEncoding=Encoding.UTF8;Console.OutputEncoding=new UTF8Encoding(false);try{var p=Obj(Json.DeserializeObject(Console.In.ReadToEnd()));var cfg=Obj(p["config"]);string action=S(p,"action"),branch=S(p,"branch");object result;
   if(action=="Capture")result=new{packet=Capture(cfg,branch,S(p,"doc"))};else if(action=="Discover")result=Discover(cfg,branch,S(p,"prefix"),S(p,"after"));else if(action=="Deliver")result=Deliver(cfg,branch);else if(action=="Apply")result=Apply(cfg,S(p,"id"),S(p,"lease"));else result=Queue(cfg,action,branch,p.ContainsKey("args")?Obj(p["args"]):null);
   Console.WriteLine(Json.Serialize(new{ok=true,result=result}));
  }catch(Exception e){Console.WriteLine(Json.Serialize(new{ok=false,code=e.Message.StartsWith("SALES_",StringComparison.Ordinal)?e.Message:SafeCode(e)}));Environment.ExitCode=1;}}
}
