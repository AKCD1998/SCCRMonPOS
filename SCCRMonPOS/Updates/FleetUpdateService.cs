using System;
using System.IO;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace SCCRMonPOS.Updates
{
    [DataContract] public sealed class FleetCommand
    {
        [DataMember(Name="id")] public string Id;
        [DataMember(Name="nodeId")] public string NodeId;
        [DataMember(Name="version")] public string Version;
        [DataMember(Name="sha256")] public string Sha256;
        [DataMember(Name="envelope")] public string Envelope;
        [DataMember(Name="state")] public string State;
    }
    [DataContract] public sealed class FleetReply
    {
        [DataMember(Name="ok")] public bool Ok;
        [DataMember(Name="enabled")] public bool Enabled;
        [DataMember(Name="deviceId")] public string DeviceId;
        [DataMember(Name="branchCode")] public string BranchCode;
        [DataMember(Name="posCode")] public string PosCode;
        [DataMember(Name="command")] public FleetCommand Command;
    }
    [DataContract] public sealed class FleetPoll
    {
        [DataMember(Name="protocol")] public int Protocol = 1;
        [DataMember(Name="nodeId")] public string NodeId;
        [DataMember(Name="hostname")] public string Hostname;
        [DataMember(Name="version")] public string Version;
        [DataMember(Name="binaryHash")] public string BinaryHash;
        [DataMember(Name="readiness")] public string Readiness;
    }
    [DataContract] public sealed class FleetReport
    {
        [DataMember(Name="jobId")] public string JobId;
        [DataMember(Name="state")] public string State;
        [DataMember(Name="code")] public string Code;
        [DataMember(Name="installedHash")] public string InstalledHash;
    }
    [DataContract] public sealed class FleetLocalState
    {
        [DataMember] public string JobId;
        [DataMember] public string Hash;
        [DataMember] public string Phase;
        [DataMember] public string StagedPath;
        [DataMember] public string StartedAt;
    }
    public static class FleetJson
    {
        public static string Write<T>(T value) { using(var s=new MemoryStream()) { new DataContractJsonSerializer(typeof(T)).WriteObject(s,value); return Encoding.UTF8.GetString(s.ToArray()); } }
        public static T Read<T>(string json) { if(string.IsNullOrWhiteSpace(json)||json.Length>131072)throw new InvalidDataException("Invalid fleet response."); using(var s=new MemoryStream(Encoding.UTF8.GetBytes(json))) return (T)new DataContractJsonSerializer(typeof(T)).ReadObject(s); }
    }
    public sealed class FleetUpdateService : IDisposable
    {
        private readonly Func<string,string,Task<string>> send;
        private readonly Func<string,UpdateRelease> verify;
        private readonly UpdateService updates;
        private readonly string executable, stateFile, updateRoot;
        private readonly ApprovedDevice device;
        private readonly Func<string> deviceId;
        private readonly Func<bool> authenticated, ready;
        private readonly Func<string,string,bool> restart;
        private readonly CancellationTokenSource cancellation = new CancellationTokenSource();
        private bool polling,disposed;
        public bool HasPendingCommand { get; private set; }
        public string Status { get; private set; } = "รอคำสั่งจากแอดมิน";
        public event Action<string> StatusChanged;

        public FleetUpdateService(ApiClient api,UpdateService updates,string executable,string dataFolder,
            ApprovedDevice device,Func<bool> authenticated,Func<bool> ready,Func<string,string,bool> restart,Func<string> deviceId)
            : this(api.FleetRequestAsync,updates,executable,dataFolder,device,authenticated,ready,restart,UpdateRelease.Verify,deviceId) { }
        internal FleetUpdateService(Func<string,string,Task<string>> send,UpdateService updates,string executable,string dataFolder,
            ApprovedDevice device,Func<bool> authenticated,Func<bool> ready,Func<string,string,bool> restart,Func<string,UpdateRelease> verify,Func<string> deviceId=null)
        {
            this.send=send;this.verify=verify;this.updates=updates;this.executable=Path.GetFullPath(executable);this.device=device;
            this.deviceId=deviceId;
            this.authenticated=authenticated;this.ready=ready;this.restart=restart;
            stateFile=Path.Combine(dataFolder,"fleet-control","state.json");
            updateRoot=Path.Combine(Path.GetDirectoryName(this.executable),"data","updates")+Path.DirectorySeparatorChar;
        }
        public static UpdateRelease Validate(FleetCommand command,string expectedNode,Func<string,UpdateRelease> verify)
        {
            Guid id;
            if(command==null||!Guid.TryParseExact(command.Id,"D",out id)||command.NodeId!=expectedNode)throw new InvalidDataException("Fleet command identity mismatch.");
            var release=verify(command.Envelope);
            release.RequireDeviceAccess();
            if(release.FleetProtocolVersion!=1||release.Sha256!=command.Sha256||release.Version!=command.Version)throw new InvalidDataException("Fleet release mismatch.");
            return release;
        }
        private void Show(string text) { Status=text;StatusChanged?.Invoke(text); }
        private FleetLocalState Load()
        {
            try { return FleetJson.Read<FleetLocalState>(File.ReadAllText(stateFile)); } catch { return null; }
        }
        private void Save(FleetLocalState value)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(stateFile));
            string temporary=stateFile+"."+Guid.NewGuid().ToString("N")+".tmp";
            File.WriteAllText(temporary,FleetJson.Write(value),new UTF8Encoding(false));
            if(File.Exists(stateFile))File.Replace(temporary,stateFile,null);else File.Move(temporary,stateFile);
        }
        private Task Report(FleetCommand command,string phase,string code,string hash)
        {
            return send("report",FleetJson.Write(new FleetReport {JobId=command.Id,State=phase,Code=code,InstalledHash=hash}));
        }
        // Runs on the WinForms context. Only an explicit persisted admin job can
        // reach StageAsync; ordinary latest-version notifications do not install.
        public async Task PollAsync()
        {
            if(polling||disposed||device==null||!authenticated())return;
            polling=true;
            try
            {
                string installed=UpdateRelease.HashFile(executable);
                var reply=FleetJson.Read<FleetReply>(await send("poll",FleetJson.Write(new FleetPoll {
                    NodeId=device.NodeId,Hostname=device.Hostname,Version=updates.CurrentVersion,BinaryHash=installed,Readiness=ready()?"idle":"busy"})));
                if(disposed||!reply.Ok)return;
                if(deviceId!=null)
                {
                    if(reply.DeviceId!=deviceId())throw new InvalidDataException("Authenticated device changed.");
                    try
                    {
                        string directory=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonDocuments),"SCCRM");
                        Directory.CreateDirectory(directory);
                        File.WriteAllText(Path.Combine(directory,"device-identity.json"),FleetJson.Write(new FleetIdentity {
                            NodeId=device.NodeId,DeviceId=reply.DeviceId,Hostname=device.Hostname,Ip=device.Ipv4,
                            Branch=reply.BranchCode,Pos=reply.PosCode,Version=updates.CurrentVersion,Hash=installed,At=DateTime.UtcNow.ToString("o")}),new UTF8Encoding(false));
                    }
                    catch { /* Public diagnostics are optional and contain no credentials. */ }
                }
                var command=reply.Command;
                if(command==null){HasPendingCommand=false;Show(reply.Enabled?"รอคำสั่งจากแอดมิน":"แอดมินพักคำสั่งอัปเดตไว้");return;}
                HasPendingCommand=true;
                var release=Validate(command,device.NodeId,verify);
                var state=Load();
                if(installed==release.Sha256)
                {
                    await Report(command,"succeeded","VERIFIED_RUNNING_RELEASE",installed);
                    Save(new FleetLocalState {JobId=command.Id,Hash=installed,Phase="succeeded"});
                    HasPendingCommand=false;Show("อัปเดตสำเร็จ — รุ่น "+release.Version);return;
                }
                if(state?.JobId==command.Id&&state.Phase=="installing")
                {
                    DateTime started;
                    if(DateTime.TryParse(state.StartedAt,null,System.Globalization.DateTimeStyles.RoundtripKind,out started)&&DateTime.UtcNow-started.ToUniversalTime()<TimeSpan.FromMinutes(2))
                    { Show("รอยืนยันการเปิด SCCRM รุ่นใหม่");return; }
                    await Report(command,"failed","UPDATE_NOT_CONFIRMED",installed);
                    state.Phase="failed";Save(state);Show("อัปเดตไม่สำเร็จ รุ่นเดิมยังทำงานอยู่");return;
                }
                if(state==null||state.JobId!=command.Id||state.Hash!=release.Sha256)
                    state=new FleetLocalState {JobId=command.Id,Hash=release.Sha256,Phase="pending"};
                bool valid=false;
                if(!string.IsNullOrWhiteSpace(state.StagedPath))
                {
                    try { if(Path.GetFullPath(state.StagedPath).StartsWith(updateRoot,StringComparison.OrdinalIgnoreCase)){release.VerifyExecutable(state.StagedPath);valid=true;} } catch { }
                }
                if(!valid)
                {
                    Show("ดาวน์โหลดรุ่น "+release.Version+" ตามคำสั่งแอดมิน");
                    await Report(command,"downloading","ADMIN_REQUEST",installed);
                    state.StagedPath=await updates.StageAsync(release,command.Envelope,cancellation.Token);
                    state.Phase="waiting_for_idle";Save(state);
                }
                if(disposed)return;
                if(!ready()) { await Report(command,"waiting_for_idle","WORK_IN_PROGRESS",installed);Show("รอ SCCRM บันทึกงาน / ปิดหน้าที่กำลังแก้ไขก่อนอัปเดต");return; }
                release.VerifyExecutable(state.StagedPath);
                await Report(command,"installing","READY_TO_RESTART_SCCRM",installed);
                if(disposed)return;
                state.Phase="installing";state.StartedAt=DateTime.UtcNow.ToString("o");Save(state);
                // Recheck after the network await. The callback closes only our
                // app and starts its existing verified replacement helper.
                if(!restart(state.StagedPath,command.Envelope))
                {
                    state.Phase="waiting_for_idle";Save(state);
                    await Report(command,"waiting_for_idle","WORK_STARTED_DURING_CHECK",installed);
                }
            }
            catch(OperationCanceledException) { }
            catch { if(!disposed)Show("ติดต่อระบบอัปเดตไม่ได้ — SCCRM รุ่นเดิมยังใช้ต่อได้"); }
            finally { polling=false; }
        }
        public void Dispose() { disposed=true;cancellation.Cancel(); }
    }
    [DataContract] public sealed class FleetIdentity
    {
        [DataMember] public string NodeId;
        [DataMember] public string DeviceId;
        [DataMember] public string Hostname;
        [DataMember] public string Ip;
        [DataMember] public string Branch;
        [DataMember] public string Pos;
        [DataMember] public string Version;
        [DataMember] public string Hash;
        [DataMember] public string At;
    }
}
