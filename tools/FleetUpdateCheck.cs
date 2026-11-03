using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using SCCRMonPOS;
using SCCRMonPOS.Updates;

internal static class FleetUpdateCheck
{
    private static int checks;
    private static void Check(bool condition) { if(!condition)throw new InvalidOperationException("Fleet check failed.");checks++; }
    private sealed class Download : HttpMessageHandler
    {
        public byte[] Bytes;public bool Corrupt;public int Calls;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken token)
        {
            Calls++;return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) {RequestMessage=request,Content=new ByteArrayContent(Corrupt?new byte[2048]:Bytes)});
        }
    }
    private sealed class Fixture : IDisposable
    {
        public readonly string Root,Target,Other,Envelope,PublicKey;
        public readonly FleetCommand Command;
        public readonly Download Download;
        public readonly UpdateService Updates;
        public bool Ready,FailPoll,WorkDuringInstall,LostInstallAck;
        public int Restarts,Applies;
        public readonly List<FleetReport> Reports=new List<FleetReport>();
        private readonly string marker;
        public Fixture()
        {
            marker=Guid.NewGuid().ToString("N");Root=Path.Combine(Path.GetTempPath(),"SCCRM-Fleet-Check-"+marker);Directory.CreateDirectory(Root);File.WriteAllText(Path.Combine(Root,"owned.marker"),marker);
            Target=Path.Combine(Root,"SCCRMonPOS.exe");Other=Path.Combine(Root,"AdaPosFront.exe");File.WriteAllBytes(Target,new byte[2048]);File.WriteAllText(Other,"unrelated-pos-fixture-unchanged");
            byte[] bytes=new byte[4096];for(int i=0;i<bytes.Length;i++)bytes[i]=(byte)(i%239);
            string hash;using(var sha=SHA256.Create())hash=BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-","").ToLowerInvariant();
            using(var rsa=new RSACryptoServiceProvider(2048))
            {
                rsa.PersistKeyInCsp=false;PublicKey=rsa.ToXmlString(false);
                string json="{\"schemaVersion\":1,\"releaseId\":\"pos-1.3.16\",\"version\":\"1.3.16\",\"deviceAccessVersion\":1,\"fleetProtocolVersion\":1,\"size\":4096,\"sha256\":\""+hash+"\",\"downloadUrl\":\"https://github.com/AKCD1998/SCCRMonPOS/releases/download/pos-1.3.16/SCCRMonPOS.exe\"}";
                byte[] payload=Encoding.UTF8.GetBytes(json),signature=rsa.SignData(payload,CryptoConfig.MapNameToOID("SHA256"));
                Envelope="{\"payload\":\""+Convert.ToBase64String(payload)+"\",\"signature\":\""+Convert.ToBase64String(signature)+"\"}";
            }
            Command=new FleetCommand {Id=Guid.NewGuid().ToString("D"),NodeId="fixture-node",Version="1.3.16",Sha256=hash,Envelope=Envelope,State="pending"};
            Download=new Download {Bytes=bytes};Updates=new UpdateService(Target,UpdateService.DefaultManifestUrl,new HttpClient(Download),e=>UpdateRelease.Verify(e,PublicKey));
        }
        public FleetUpdateService Service()
        {
            return new FleetUpdateService(Send,Updates,Target,Path.Combine(Root,"data"),new ApprovedDevice {NodeId="fixture-node",Hostname="FIXTURE"},()=>true,()=>Ready,Restart,e=>UpdateRelease.Verify(e,PublicKey));
        }
        private Task<string> Send(string operation,string body)
        {
            if(operation=="poll") {if(FailPoll)throw new IOException("isolated simulated offline");return Task.FromResult(FleetJson.Write(new FleetReply {Ok=true,Enabled=true,Command=Command}));}
            var report=FleetJson.Read<FleetReport>(body);Reports.Add(report);
            if(report.State=="installing")
            {
                if(WorkDuringInstall){WorkDuringInstall=false;Ready=false;}
                if(LostInstallAck){LostInstallAck=false;throw new IOException("isolated lost acknowledgement");}
            }
            return Task.FromResult("{\"ok\":true}");
        }
        private bool Restart(string staged,string envelope)
        {
            Restarts++;if(!Ready)return false;
            UpdateInstaller.Apply(Target,staged,envelope,UpdateRelease.HashFile(Target),p=>Applies++,PublicKey);return true;
        }
        public void Dispose()
        {
            Updates.Dispose();
            Check(File.ReadAllText(Other)=="unrelated-pos-fixture-unchanged");
            string expected=Path.GetFullPath(Path.Combine(Path.GetTempPath(),"SCCRM-Fleet-Check-"+marker));
            if(Path.GetFullPath(Root)!=expected||File.ReadAllText(Path.Combine(Root,"owned.marker"))!=marker)throw new IOException("Fixture cleanup scope mismatch.");
            Directory.Delete(expected,true);
        }
    }
    private static async Task Run()
    {
        using(var f=new Fixture())using(var service=f.Service())
        {
            string old=UpdateRelease.HashFile(f.Target);f.Ready=false;await service.PollAsync();
            Check(f.Download.Calls==1&&f.Restarts==0&&UpdateRelease.HashFile(f.Target)==old);Check(f.Reports.Exists(r=>r.State=="waiting_for_idle"));
            f.Ready=true;await service.PollAsync();Check(f.Applies==1&&UpdateRelease.HashFile(f.Target)==f.Command.Sha256);
            await service.PollAsync();Check(f.Reports.Exists(r=>r.State=="succeeded"&&r.InstalledHash==f.Command.Sha256));
            await service.PollAsync();Check(f.Applies==1&&f.Download.Calls==1);
        }
        using(var f=new Fixture())
        {
            using(var first=f.Service()){f.Ready=false;await first.PollAsync();}
            using(var resumed=f.Service()){f.Ready=true;await resumed.PollAsync();Check(f.Download.Calls==1&&f.Applies==1);}
        }
        using(var f=new Fixture())using(var service=f.Service())
        {
            f.Ready=true;f.WorkDuringInstall=true;await service.PollAsync();Check(f.Applies==0&&f.Reports.Exists(r=>r.Code=="WORK_STARTED_DURING_CHECK"));
            f.Ready=true;await service.PollAsync();Check(f.Applies==1);
        }
        using(var f=new Fixture())using(var service=f.Service())
        {
            f.Ready=true;f.LostInstallAck=true;await service.PollAsync();Check(f.Applies==0);await service.PollAsync();Check(f.Applies==1&&f.Download.Calls==1);
        }
        using(var f=new Fixture())using(var service=f.Service())
        {
            string old=UpdateRelease.HashFile(f.Target);f.Download.Corrupt=true;f.Ready=true;await service.PollAsync();
            Check(f.Applies==0&&f.Restarts==0&&UpdateRelease.HashFile(f.Target)==old);
        }
        using(var f=new Fixture())using(var service=f.Service())
        {
            f.FailPoll=true;f.Ready=true;await service.PollAsync();Check(f.Restarts==0&&f.Download.Calls==0);
            f.FailPoll=false;await service.PollAsync();Check(f.Applies==1);
        }
        using(var f=new Fixture())using(var service=f.Service())
        {
            f.Command.NodeId="another-device";f.Ready=true;await service.PollAsync();Check(f.Restarts==0&&f.Download.Calls==0);
        }
    }
    private static int Main()
    {
        try{Run().GetAwaiter().GetResult();Console.WriteLine("{\"ok\":true,\"checks\":"+checks+",\"customerWrites\":0,\"realPosProcessesTouched\":0}");return 0;}
        catch(Exception error){Console.WriteLine("{\"ok\":false,\"type\":\""+error.GetType().Name+"\",\"checks\":"+checks+"}");return 1;}
    }
}
