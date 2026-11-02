[CmdletBinding()]
param()
# Operator-only. No remote PowerShell/WMI execution, credential transfer, SQL,
# file update or service reconfiguration. Only this exact new service may start.
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.Encoding]::UTF8
$scope='SCCRM-ADA-PRIMARY-POINTS-SERVICE-V1';$marker='c25c42de-d85d-4fac-bd60-794de1abdb7c';$service='SCCRMHQPointSync'
$remote='\\100.90.166.72';$expectedRoot='D:\SCCRM-HQ-LiveSync-20261024\points'
$root='\\100.90.166.72\D\SCCRM-HQ-LiveSync-20261024\points'
$operatorRoot=[IO.Path]::GetFullPath($PSScriptRoot)
$files=@('run-service.cjs','worker.cjs','export.cjs','model.cjs','projection.cjs','compensation.cjs','store.cjs','delivery.cjs','native-adapter.cjs','Read-NativePoints.ps1','Invoke-PointNative.ps1','secrets.cjs','SecretBridge.ps1','Prepare-PrivateRuntime.ps1','Install-Service.ps1','DEPLOY_TH.md','config.json','supabase-ca.crt','SCCRMHQPointSync.exe','.point-service-owner.json')
$stage='package';$created=$false;$lastScExit=$null;$validatedHashes=0;$manifest=$null
function Sc-Own([string[]]$Arguments){
 if(!$Arguments -or $Arguments[0] -cnotin @('query','create','start') -or $Arguments[1] -cne $service){throw 'POINT_REMOTE_SCM_SCOPE_REFUSED'}
 $previousPreference=$ErrorActionPreference
 try{$ErrorActionPreference='Continue';$output=@(& "$env:WINDIR\System32\sc.exe" $remote @Arguments 2>&1);$code=$LASTEXITCODE}finally{$ErrorActionPreference=$previousPreference}
 return [pscustomobject]@{code=$code;output=$output}
}
function Write-Receipt([object]$value){
 $runtime=[IO.Path]::GetFullPath((Join-Path $operatorRoot 'runtime'))
 if(!$runtime.StartsWith($operatorRoot+'\',[StringComparison]::OrdinalIgnoreCase) -or !(Test-Path -LiteralPath $runtime -PathType Container)){throw 'POINT_LOCAL_RECEIPT_PATH_REQUIRED'}
 [IO.File]::WriteAllText((Join-Path $runtime 'remote-install-result.json'),($value|ConvertTo-Json -Depth 5),(New-Object Text.UTF8Encoding $false))
}

function FileHash([string]$file){return (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()}
function No-Reparse([string]$path){if(((Get-Item -LiteralPath $path).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'POINT_INSTALL_REPARSE_REFUSED'}}
function Check-Acl([string]$path,[string]$owner,[bool]$private){
 No-Reparse $path
 $acl=[IO.Directory]::GetAccessControl($path,[Security.AccessControl.AccessControlSections]::Access)
 if(!$acl.AreAccessRulesProtected){throw 'POINT_PACKAGE_ACL_NOT_PROTECTED'}
 $allowed=@('S-1-5-18','S-1-5-32-544',$owner,'S-1-5-19');if(!$private){$allowed+=@('S-1-5-32-545')}
 $rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]));$serviceRules=@()
 foreach($rule in $rules){
  $sid=$rule.IdentityReference.Value
  if($sid -cnotin $allowed -or $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow){throw 'POINT_PACKAGE_ACL_EXCESSIVE'}
  if($sid -ceq 'S-1-5-19'){$serviceRules+=@($rule)}
  if($sid -cin @('S-1-5-19','S-1-5-32-545')){
   $forbidden=[Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership
   if(!$private){$forbidden=$forbidden -bor [Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles}
   if(($rule.FileSystemRights -band $forbidden) -ne 0){throw 'POINT_PACKAGE_ACL_EXCESSIVE'}
  }
 }
 if($serviceRules.Count -ne 1){throw 'POINT_SERVICE_ACL_REQUIRED'}
 $required=if($private){[Security.AccessControl.FileSystemRights]::Modify}else{[Security.AccessControl.FileSystemRights]::ReadAndExecute}
 if(($serviceRules[0].FileSystemRights -band $required) -ne $required){throw 'POINT_SERVICE_ACL_REQUIRED'}
 $actualOwner=[IO.Directory]::GetAccessControl($path,[Security.AccessControl.AccessControlSections]::Owner).GetOwner([Security.Principal.SecurityIdentifier]).Value
 if($actualOwner -cne $owner -or $actualOwner -ceq 'S-1-5-19'){throw 'POINT_PACKAGE_OWNER_REFUSED'}
}

function Read-OwnService {
 if(-not ('SccrmPointRemote.QueryOnly' -as [type])){
  Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
namespace SccrmPointRemote {
 public sealed class ServiceInfo { public string BinaryPath; public string Account; public uint StartType; public bool DelayedAutoStart; public uint State; public uint ProcessId; }
 public static class QueryOnly {
  [StructLayout(LayoutKind.Sequential)] struct Config { public uint Type,Start,Error;public IntPtr Binary,Group;public uint Tag;public IntPtr Dependencies,Account,Display; }
  [StructLayout(LayoutKind.Sequential)] struct Status {public uint Type,State,Controls,Exit,Specific,Checkpoint,WaitHint,Pid,Flags;}
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr OpenSCManager(string machine,string database,uint access);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr OpenService(IntPtr manager,string name,uint access);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool QueryServiceConfig(IntPtr service,IntPtr buffer,uint size,out uint needed);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool QueryServiceConfig2(IntPtr service,uint level,IntPtr buffer,uint size,out uint needed);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool QueryServiceStatusEx(IntPtr service,int level,IntPtr buffer,uint size,out uint needed);
  [DllImport("advapi32.dll")] static extern bool CloseServiceHandle(IntPtr handle);
  public static ServiceInfo Read(){
   IntPtr manager=IntPtr.Zero,service=IntPtr.Zero,buffer=IntPtr.Zero;uint needed;
   try{
    manager=OpenSCManager(@"\\100.90.166.72",null,1);if(manager==IntPtr.Zero)throw new Win32Exception(Marshal.GetLastWin32Error());
    service=OpenService(manager,"SCCRMHQPointSync",1|4);if(service==IntPtr.Zero)throw new Win32Exception(Marshal.GetLastWin32Error());
    QueryServiceConfig(service,IntPtr.Zero,0,out needed);if(needed==0||needed>65536)throw new InvalidOperationException("POINT_SCM_QUERY_SIZE_REFUSED");
    buffer=Marshal.AllocHGlobal((int)needed);if(!QueryServiceConfig(service,buffer,needed,out needed))throw new Win32Exception(Marshal.GetLastWin32Error());
    Config config=(Config)Marshal.PtrToStructure(buffer,typeof(Config));var result=new ServiceInfo{BinaryPath=Marshal.PtrToStringUni(config.Binary),Account=Marshal.PtrToStringUni(config.Account),StartType=config.Start};Marshal.FreeHGlobal(buffer);buffer=IntPtr.Zero;buffer=Marshal.AllocHGlobal(4);
    if(!QueryServiceConfig2(service,3,buffer,4,out needed))throw new Win32Exception(Marshal.GetLastWin32Error());result.DelayedAutoStart=Marshal.ReadInt32(buffer)!=0;Marshal.FreeHGlobal(buffer);buffer=IntPtr.Zero;int size=Marshal.SizeOf(typeof(Status));buffer=Marshal.AllocHGlobal(size);
    if(!QueryServiceStatusEx(service,0,buffer,(uint)size,out needed))throw new Win32Exception(Marshal.GetLastWin32Error());Status status=(Status)Marshal.PtrToStructure(buffer,typeof(Status));result.State=status.State;result.ProcessId=status.Pid;return result;
   }finally{if(buffer!=IntPtr.Zero)Marshal.FreeHGlobal(buffer);if(service!=IntPtr.Zero)CloseServiceHandle(service);if(manager!=IntPtr.Zero)CloseServiceHandle(manager);}
  }
 }
}
"@
 }
 return [SccrmPointRemote.QueryOnly]::Read()
}
function Check-OwnService([object]$info){
 $exe=$expectedRoot+'\SCCRMHQPointSync.exe'
 if(!$info.BinaryPath.Trim().Trim('"').Equals($exe,[StringComparison]::OrdinalIgnoreCase) -or !$info.Account.Equals('NT AUTHORITY\LocalService',[StringComparison]::OrdinalIgnoreCase) -or $info.StartType -ne 2 -or !$info.DelayedAutoStart){throw 'POINT_REMOTE_EXISTING_SERVICE_COLLISION'}
}


try{
 if([IO.Path]::GetFullPath($root) -cne $root -or $operatorRoot.StartsWith('\\')){throw 'POINT_REMOTE_FIXED_PACKAGE_REQUIRED'}
 No-Reparse ([IO.Path]::GetDirectoryName($root));No-Reparse $root
 $owner=(Get-Acl -LiteralPath $root).GetOwner([Security.Principal.SecurityIdentifier]).Value
 Check-Acl $root $owner $false;foreach($sub in @('runtime','status')){Check-Acl (Join-Path $root $sub) $owner $true}
 $stage='manifest'
 $manifestFile=Join-Path $root 'package-manifest.json';No-Reparse $manifestFile;$manifest=Get-Content -LiteralPath $manifestFile -Raw -Encoding UTF8|ConvertFrom-Json
 if($manifest.scope -cne $scope -or $manifest.marker -cne $marker -or $manifest.service -cne $service -or $manifest.machine -cne 'SERVER' -or $manifest.root -cne $expectedRoot -or $manifest.account -cne 'NT AUTHORITY\LocalService' -or $manifest.sourcePatchDigest -cnotmatch '^[a-f0-9]{64}$' -or $manifest.sourceCommit -cnotmatch '^[a-f0-9]{40}$'){throw 'POINT_REVIEWED_MANIFEST_REQUIRED'}
 if(@($manifest.files).Count -ne $files.Count -or (@($manifest.files.path|Sort-Object) -join ',') -cne (@($files|Sort-Object) -join ',')){throw 'POINT_PACKAGE_ALLOWLIST_REFUSED'}
 $actualFiles=@(Get-ChildItem -LiteralPath $root -File -Force|ForEach-Object{$_.Name}|Sort-Object)
 if(($actualFiles -join ',') -cne (@(@($files)+@('package-manifest.json')|Sort-Object) -join ',')){throw 'POINT_PACKAGE_UNEXPECTED_FILE'}
 if((@(Get-ChildItem -LiteralPath $root -Directory -Force|ForEach-Object{$_.Name}|Sort-Object) -join ',') -cne 'runtime,status'){throw 'POINT_PACKAGE_UNEXPECTED_DIRECTORY'}
 foreach($entry in $manifest.files){
  if($entry.path -cnotin $files -or $entry.sha256 -cnotmatch '^[a-f0-9]{64}$'){throw 'POINT_PACKAGE_ENTRY_REFUSED'}
  $file=Join-Path $root $entry.path;No-Reparse $file
  if((FileHash $file) -cne $entry.sha256){throw 'POINT_PACKAGE_INTEGRITY_FAILED'}
  $fileAcl=Get-Acl -LiteralPath $file
  foreach($rule in @($fileAcl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))){
   if($rule.IdentityReference.Value -cnotin @('S-1-5-18','S-1-5-32-544',$owner,'S-1-5-19','S-1-5-32-545') -or $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow){throw 'POINT_PACKAGE_FILE_ACL_EXCESSIVE'}
   if($rule.IdentityReference.Value -cin @('S-1-5-19','S-1-5-32-545') -and ($rule.FileSystemRights -band ([Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership)) -ne 0){throw 'POINT_PACKAGE_FILE_ACL_EXCESSIVE'}
  }
 }
 $owned=Get-Content -LiteralPath (Join-Path $root '.point-service-owner.json') -Raw -Encoding UTF8|ConvertFrom-Json
 if($owned.scope -cne $scope -or $owned.marker -cne $marker -or $owned.machine -cne 'SERVER' -or $owned.root -cne $expectedRoot -or $owned.service -cne $service){throw 'POINT_PACKAGE_OWNERSHIP_REFUSED'}
 $dependencyPaths=@('..\node.exe','..\node_modules\pg\package.json')
 if(@($manifest.dependencies).Count -ne 2 -or (@($manifest.dependencies.path|Sort-Object) -join ',') -cne (@($dependencyPaths|Sort-Object) -join ',')){throw 'POINT_SHARED_RUNTIME_MANIFEST_REFUSED'}
 foreach($entry in $manifest.dependencies){$file=[IO.Path]::GetFullPath((Join-Path $root $entry.path));if($entry.path -cnotin $dependencyPaths -or $entry.sha256 -cnotmatch '^[a-f0-9]{64}$' -or (FileHash $file) -cne $entry.sha256){throw 'POINT_SHARED_RUNTIME_CHANGED'}}
 if((Get-Content -LiteralPath (Join-Path $root '..\node_modules\pg\package.json') -Raw|ConvertFrom-Json).version -cne '8.16.3'){throw 'POINT_SHARED_PG_VERSION_REFUSED'}
 $configText=Get-Content -LiteralPath (Join-Path $root 'config.json') -Raw -Encoding UTF8
 if($configText -match '"[^"\r\n]*(?i:password|passwd|credential|secret|token|api[_-]?key|service[_-]?role|private[_-]?key|connection[_-]?string|pg[_-]?url|encrypted[_-]?key|ciphertext)[^"\r\n]*"\s*:|"(?i:pwd)"\s*:|(?i)postgres(?:ql)?://|BEGIN .*PRIVATE KEY'){throw 'POINT_PUBLIC_CONFIG_SECRET_REFUSED'}
 $config=$configText|ConvertFrom-Json
 if($config.scope -cne $scope -or $config.mode -cne 'Live' -or @($config.sources).Count -ne 5 -or @($config.targets).Count -ne 5){throw 'POINT_LIVE_CONFIG_REQUIRED'}

 $validatedHashes=$manifest.files.Count+$manifest.dependencies.Count
 $hq=@($config.sources|Where-Object{$_.branchCode -ceq '000'})
 if($hq.Count -ne 1 -or $hq[0].machine -cne 'SERVER' -or $hq[0].databaseIdentity -cne '000/SERVER/AdaAcc'){throw 'POINT_REMOTE_SERVER_CONFIG_IDENTITY_REFUSED'}
 $stage='own-scm-query';$query=Sc-Own -Arguments @('query',$service);$lastScExit=$query.code
 if($query.code -eq 1060){
  $stage='own-scm-create';$result=Sc-Own -Arguments @('create',$service,'binPath=',('"'+$expectedRoot+'\SCCRMHQPointSync.exe"'),'start=','delayed-auto','obj=','NT AUTHORITY\LocalService','DisplayName=','SCCRM HQ Ada Points Sync');$lastScExit=$result.code
  if($result.code -ne 0){throw 'POINT_REMOTE_CREATE_REFUSED'};$created=$true
 }elseif($query.code -ne 0){throw 'POINT_REMOTE_QUERY_REFUSED'}
 # Native read-only SCM APIs avoid parsing localized qc text. Existing services
 # are never reconfigured, overwritten, stopped or deleted, even on collision.
 $info=Read-OwnService;Check-OwnService $info
 if($info.State -ne 4){
  if($info.State -ne 1){throw 'POINT_REMOTE_SERVICE_TRANSITION_PENDING'}
  $stage='own-scm-start';$started=Sc-Own -Arguments @('start',$service);$lastScExit=$started.code
  if($started.code -notin @(0,1056)){throw 'POINT_REMOTE_START_REFUSED'}
 }
 $stage='headless-bootstrap-pending';$ready=$false;$deadline=[DateTime]::UtcNow.AddSeconds(35);$statusHashCount=0
 while([DateTime]::UtcNow -lt $deadline){
  $info=Read-OwnService;Check-OwnService $info
  $identityFile=Join-Path $root 'status\bootstrap-identity.json';$publicFile=Join-Path $root 'status\bootstrap-public.json'
  if($info.State -eq 4 -and (Test-Path -LiteralPath $identityFile) -and (Test-Path -LiteralPath $publicFile)){
   try{No-Reparse $identityFile;No-Reparse $publicFile;$identity=Get-Content -LiteralPath $identityFile -Raw -Encoding UTF8|ConvertFrom-Json;$public=Get-Content -LiteralPath $publicFile -Raw -Encoding UTF8|ConvertFrom-Json
    $bootAt=[DateTimeOffset]::Parse($identity.at).UtcDateTime;$stagedAt=[DateTimeOffset]::Parse($manifest.stagedAt).UtcDateTime
    $modulus=if($public.n -cmatch '^[A-Za-z0-9_-]{683}$'){[Convert]::FromBase64String(([string]$public.n).Replace('-','+').Replace('_','/')+'=')}else{@()}
    $ready=$identity.machine -ceq 'SERVER' -and $identity.sessionId -eq 0 -and $identity.accountSid -ceq 'S-1-5-19' -and $bootAt -ge $stagedAt -and $bootAt -le [DateTime]::UtcNow.AddSeconds(5) -and $public.kty -ceq 'RSA' -and $modulus.Length -eq 512 -and ($modulus[0] -band 128) -eq 128 -and $public.e -ceq 'AQAB'
   }catch{$ready=$false}
   if($ready){$statusHashCount=2;break}
  }
  Start-Sleep -Milliseconds 500
 }
 $serviceState=$null;$stateFile=Join-Path $root 'status\service.json'
 if(Test-Path -LiteralPath $stateFile){try{$serviceState=(Get-Content -LiteralPath $stateFile -Raw -Encoding UTF8|ConvertFrom-Json).state;$statusHashCount++}catch{}}
 $statusHashes=@(foreach($relative in @('status\bootstrap-identity.json','status\bootstrap-public.json','status\service.json')){$file=Join-Path $root $relative;if(Test-Path -LiteralPath $file -PathType Leaf){[ordered]@{path=$relative;sha256=FileHash $file}}})
 $report=[ordered]@{installed=$true;healthyPending=$true;syncReady=$false;remoteHost='100.90.166.72';service=$service;serviceCreated=$created;serviceState=$info.State;servicePid=$info.ProcessId;startup='Automatic (Delayed Start)';account='NT AUTHORITY\LocalService';accountSid='S-1-5-19';bootstrapReady=$ready;state=if($ready){'bootstrap_ready_verification_pending'}else{'bootstrap_pending'};observedApplicationState=$serviceState;sessionZeroProof=$ready;verifiedFileHashes=$validatedHashes;manifestHash=FileHash $manifestFile;sourcePatchDigest=$manifest.sourcePatchDigest;statusHashes=$statusHashes;credentialsTransferred=$false;databaseCommandsIssued=0;otherServicesChanged=$false;at=[DateTime]::UtcNow.ToString('o')}
 Write-Receipt $report;$report|ConvertTo-Json -Depth 5 -Compress
}catch{
 $code=if($_.Exception.Message -cmatch '^[A-Z][A-Z_0-9]{4,100}$'){$_.Exception.Message}else{'POINT_REMOTE_INSTALL_REFUSED'}
 $report=[ordered]@{installed=$false;healthyPending=$true;syncReady=$false;code=$code;stage=$stage;serviceCreated=$created;scExit=$lastScExit;verifiedFileHashes=$validatedHashes;credentialsTransferred=$false;databaseCommandsIssued=0;otherServicesChanged=$false;detailsWithheld=$true;at=[DateTime]::UtcNow.ToString('o')}
 try{Write-Receipt $report}catch{};$report|ConvertTo-Json -Compress;exit 1
}
