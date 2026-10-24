using System;
using System.Diagnostics;
using System.IO;
using System.ServiceProcess;
using System.Threading;
using System.Runtime.InteropServices;
public sealed class HqMemberSyncService:ServiceBase {
 [StructLayout(LayoutKind.Sequential)] struct Basic {public long a,b;public uint flags;public UIntPtr min,max;public uint count;public UIntPtr affinity;public uint priority,scheduling;}
 [StructLayout(LayoutKind.Sequential)] struct Io {public ulong a,b,c,d,e,f;}
 [StructLayout(LayoutKind.Sequential)] struct Limits {public Basic basic;public Io io;public UIntPtr processMemory,jobMemory,peakProcess,peakJob;}
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attributes,string name);
 [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job,int type,IntPtr data,uint length);
 [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 readonly string root=AppDomain.CurrentDomain.BaseDirectory;readonly object gate=new object();Process child;Timer watch;bool stopping;IntPtr job;
 public HqMemberSyncService(){ServiceName="SCCRMHQMemberSync";CanStop=true;AutoLog=false;}
 string Runtime(string file){return Path.Combine(root,"live","runtime",file);}
 void Launch(){if(stopping||File.Exists(Runtime("restart.hold")))return;if(job!=IntPtr.Zero){CloseHandle(job);job=IntPtr.Zero;}if(File.Exists(Runtime("stop.request")))File.Delete(Runtime("stop.request"));
  ProcessStartInfo info=new ProcessStartInfo(Path.Combine(root,"node.exe"),"\""+Path.Combine(root,"live","worker.cjs")+"\"");info.WorkingDirectory=root;info.UseShellExecute=false;info.CreateNoWindow=true;info.WindowStyle=ProcessWindowStyle.Hidden;
  job=CreateJobObject(IntPtr.Zero,null);Limits limits=new Limits();limits.basic.flags=0x2000;int size=Marshal.SizeOf(limits);IntPtr ptr=Marshal.AllocHGlobal(size);try{Marshal.StructureToPtr(limits,ptr,false);if(job==IntPtr.Zero||!SetInformationJobObject(job,9,ptr,(uint)size))throw new InvalidOperationException("OWNED_PROCESS_JOB_FAILED");}finally{Marshal.FreeHGlobal(ptr);}
  child=Process.Start(info);if(!AssignProcessToJobObject(job,child.Handle)){child.Kill();throw new InvalidOperationException("OWNED_PROCESS_JOB_FAILED");}child.PriorityClass=ProcessPriorityClass.BelowNormal;
 }
 protected override void OnStart(string[] args){lock(gate){stopping=false;Launch();}watch=new Timer(delegate(object unused){lock(gate){try{if(!stopping&&(child==null||child.HasExited))Launch();}catch{}}},null,15000,15000);}
 protected override void OnStop(){lock(gate){stopping=true;if(watch!=null)watch.Dispose();}File.WriteAllText(Runtime("stop.request"),"service-stop");if(child!=null&&!child.HasExited&&!child.WaitForExit(15000))child.Kill();if(job!=IntPtr.Zero){CloseHandle(job);job=IntPtr.Zero;}}
 public static void Main(){ServiceBase.Run(new HqMemberSyncService());}
}
