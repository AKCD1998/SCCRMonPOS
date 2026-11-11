param()
$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.Encoding]::UTF8
$service='SCCRMHQReceiptSync';$scope='SCCRM-HQ-RECEIPT-SYNC-V1';$marker='a7dc1e0f-91d3-431c-bd97-fb142c5ae082'
$remote='\\100.90.166.72';$root='\\100.90.166.72\D\SCCRM-HQ-LiveSync-20261024\receipts';$nativeRoot='D:\SCCRM-HQ-LiveSync-20261024\receipts'
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'));$stage='source'
function No-Reparse([string]$path){if(((Get-Item -LiteralPath $path).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'RECEIPT_SERVICE_REPARSE_REFUSED'}}
function Sc-Own([string[]]$Arguments){
 if($Arguments[0] -cnotin @('query','qc','create','start') -or $Arguments[1] -cne $service){throw 'RECEIPT_SCM_SCOPE_REFUSED'}
 $old=$ErrorActionPreference;try{$ErrorActionPreference='Continue';$result=@(& "$env:WINDIR\System32\sc.exe" $remote @Arguments 2>&1);$code=$LASTEXITCODE}finally{$ErrorActionPreference=$old}
 return @{code=$code;output=($result -join "`n")}
}
function Acl([string]$path,[bool]$private,[string]$owner){
 No-Reparse $path;$acl=New-Object Security.AccessControl.DirectorySecurity;$acl.SetAccessRuleProtection($true,$false)
 foreach($sid in @($owner,'S-1-5-18','S-1-5-32-544')|Select-Object -Unique){$rule=New-Object Security.AccessControl.FileSystemAccessRule([Security.Principal.SecurityIdentifier]::new($sid),'FullControl','ContainerInherit,ObjectInherit','None','Allow');$acl.AddAccessRule($rule)}
 $rights=if($private){'Modify'}else{'ReadAndExecute'};$rule=New-Object Security.AccessControl.FileSystemAccessRule([Security.Principal.SecurityIdentifier]::new('S-1-5-19'),$rights,'ContainerInherit,ObjectInherit','None','Allow');$acl.AddAccessRule($rule)
 [IO.Directory]::SetAccessControl($path,$acl)
}
try{
 if($env:COMPUTERNAME -ceq 'SERVER'){throw 'RECEIPT_REMOTE_OPERATOR_REQUIRED'}
 $dirty=@(& git -C $repo status --porcelain --untracked-files=all);if($LASTEXITCODE -ne 0 -or $dirty.Count){throw 'RECEIPT_COMMITTED_SOURCE_REQUIRED'}
 $commit=(& git -C $repo rev-parse HEAD).Trim();if($commit -cnotmatch '^[a-f0-9]{40}$'){throw 'RECEIPT_COMMITTED_SOURCE_REQUIRED'}
 $proof=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'runtime\copy-proof.json') -Raw|ConvertFrom-Json
 $receiverHash=(Get-FileHash -LiteralPath (Join-Path $PSScriptRoot 'native-receiver.sql') -Algorithm SHA256).Hash.ToLowerInvariant()
 if($proof.ok -ne $true -or $proof.productionWrites -ne 0 -or $proof.receiverHash -cne $receiverHash -or @($proof.branches).Count -ne 5){throw 'RECEIPT_SERVICE_COPY_PROOF_REQUIRED'}
 $stage='existing-service';$query=Sc-Own @('query',$service)
 if($query.code -ne 1060){throw 'RECEIPT_SERVICE_ALREADY_EXISTS_OR_ACCESS_REFUSED'}
 No-Reparse ([IO.Path]::GetDirectoryName($root))
 if(Test-Path -LiteralPath $root){
  No-Reparse $root;$owned=Get-Content -LiteralPath (Join-Path $root '.receipt-service-owner.json') -Raw|ConvertFrom-Json
  if($owned.marker -cne $marker -or $owned.service -cne $service -or $owned.root -cne $nativeRoot){throw 'RECEIPT_SERVICE_FOLDER_NOT_OWNED'}
 }else{$null=New-Item -Path $root -ItemType Directory}
 $owner=(Get-Acl -LiteralPath $root).GetOwner([Security.Principal.SecurityIdentifier]).Value;Acl $root $false $owner
 foreach($sub in @('runtime','status')){$path=Join-Path $root $sub;if(!(Test-Path -LiteralPath $path)){$null=New-Item -Path $path -ItemType Directory};Acl $path $true $owner}
 $owned=@{marker=$marker;scope=$scope;service=$service;root=$nativeRoot;sourceCommit=$commit;account='NT AUTHORITY\LocalService'}
 [IO.File]::WriteAllText((Join-Path $root '.receipt-service-owner.json'),($owned|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
 $stage='compile';$build=Join-Path $repo 'build-verify\receipt-service';$null=New-Item -Path $build -ItemType Directory -Force
 $exe=Join-Path $build ($service+'.exe');$compiler=Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
 $compile=@(& $compiler /nologo /target:exe /r:System.ServiceProcess.dll ('/out:'+$exe) (Join-Path $PSScriptRoot 'ServiceHost.cs') 2>&1)
 if($LASTEXITCODE -ne 0){throw 'RECEIPT_SERVICE_COMPILE_FAILED'}
 $files=@('run-service.cjs','worker.cjs','native-adapter.cjs','Invoke-ReceiptNative.ps1','secrets.cjs','SecretBridge.ps1','README.md')
 $stage='stage-owned-files';foreach($file in $files){$destination=Join-Path $root $file;if(Test-Path -LiteralPath $destination){No-Reparse $destination};Copy-Item -LiteralPath (Join-Path $PSScriptRoot $file) -Destination $destination -Force}
 Copy-Item -LiteralPath $exe -Destination (Join-Path $root ($service+'.exe')) -Force
 $peers=@{'000'=@('tcp:127.0.0.1,49800','SERVER');'001'=@('100.81.137.41\SQLEXPRESS','SC_001');'003'=@('100.77.101.94\SQLEXPRESS','POSSRV');'004'=@('100.113.59.42\SQLEXPRESS','SERVER004');'005'=@('100.106.107.80\SQLEXPRESS','POSSRV')}
 $targets=@();foreach($b in @('000','001','003','004','005')){$targets+=@{branch=$b;server=$peers[$b][0];machine=$peers[$b][1];database='AdaAcc'}}
 [IO.File]::WriteAllText((Join-Path $root 'config.json'),(@{scope=$scope;enabled=$false;targets=$targets}|ConvertTo-Json -Depth 6),[Text.UTF8Encoding]::new($false))
 $stage='hash-package';$ownedFiles=@($files)+@(($service+'.exe'),'config.json','.receipt-service-owner.json')
 $hashes=@();foreach($file in $ownedFiles){$path=Join-Path $root $file;No-Reparse $path;$hashes+=@{path=$file;sha256=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()}}
 $manifest=@{scope=$scope;marker=$marker;sourceCommit=$commit;receiverHash=$receiverHash;files=$hashes}
 [IO.File]::WriteAllText((Join-Path $root 'package-manifest.json'),($manifest|ConvertTo-Json -Depth 7),[Text.UTF8Encoding]::new($false))
 $stage='create-only-owned-service'
 $create=Sc-Own @('create',$service,'binPath=',($nativeRoot+'\'+$service+'.exe'),'start=','delayed-auto','obj=','NT AUTHORITY\LocalService','DisplayName=','SCCRM HQ Receipt Sync')
 if($create.code -ne 0){throw 'RECEIPT_SERVICE_CREATE_FAILED'}
 $start=Sc-Own @('start',$service);if($start.code -ne 0 -and $start.code -ne 1056){throw 'RECEIPT_SERVICE_START_FAILED'}
 @{ok=$true;service=$service;root=$nativeRoot;account='NT AUTHORITY\LocalService';sourceCommit=$commit;stagedFiles=$hashes.Count;awaitingCredentials=$true;nativeDeliveryEnabled=$false;otherServicesChanged=0;productionDataWrites=0}|ConvertTo-Json -Compress
}catch{$e=$_.Exception.GetBaseException();@{ok=$false;stage=$stage;code=$(if($e.Message -cmatch '^RECEIPT_[A-Z_]+$'){$e.Message}else{'RECEIPT_SERVICE_STAGE_FAILED'});detailsWithheld=$true;otherServicesChanged=0}|ConvertTo-Json -Compress;exit 1}
