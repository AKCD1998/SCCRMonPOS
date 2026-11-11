param()
$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.Encoding]::UTF8
$service='SCCRMHQSalesImport';$scope='SCCRM-HQ-SALES-IMPORT-V1';$marker='b740db43-5811-44cb-b072-0480a0b26f19'
$remote='\\100.90.166.72';$root='\\100.90.166.72\D\SCCRM-HQ-LiveSync-20261024\sales-import';$native='D:\SCCRM-HQ-LiveSync-20261024\sales-import'
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'));$stage='proof'
function Plain([string]$path){if(((Get-Item -LiteralPath $path).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'SALES_SERVICE_REPARSE_REFUSED'}}
function OwnSC([string[]]$Arguments){if($Arguments[0] -cnotin @('query','create','start','failure') -or $Arguments[1] -cne $service){throw 'SALES_SERVICE_SCOPE_REFUSED'};$old=$ErrorActionPreference;try{$ErrorActionPreference='Continue';$out=@(& "$env:WINDIR\System32\sc.exe" $remote @Arguments 2>&1);$code=$LASTEXITCODE}finally{$ErrorActionPreference=$old};return @{code=$code;output=($out -join "`n")}}
function Acl([string]$path,[bool]$write,[string]$owner){Plain $path;$acl=New-Object Security.AccessControl.DirectorySecurity;$acl.SetAccessRuleProtection($true,$false);foreach($sid in @($owner,'S-1-5-18','S-1-5-32-544')|Select-Object -Unique){$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),'FullControl','ContainerInherit,ObjectInherit','None','Allow'))};$rights=if($write){'Modify'}else{'ReadAndExecute'};$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-19'),$rights,'ContainerInherit,ObjectInherit','None','Allow'));[IO.Directory]::SetAccessControl($path,$acl)}
try{
 $dirty=@(& git -C $repo status --porcelain --untracked-files=all);if($LASTEXITCODE -ne 0 -or $dirty.Count){throw 'SALES_COMMITTED_SOURCE_REQUIRED'}
 $proof=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'runtime\copy-proof.json') -Raw|ConvertFrom-Json
 $sha=[Security.Cryptography.SHA256]::Create();$memory=New-Object IO.MemoryStream;foreach($file in @('SalesImport.cs','schema.cjs','queue.sql')){$bytes=[IO.File]::ReadAllBytes((Join-Path $PSScriptRoot $file));$memory.Write($bytes,0,$bytes.Length)};$sourceHash=[BitConverter]::ToString($sha.ComputeHash($memory.ToArray())).Replace('-','').ToLowerInvariant();$memory.Dispose();$sha.Dispose()
 if(!$proof.ok -or $proof.productionWrites -ne 0 -or $proof.sourceHash -cne $sourceHash -or @($proof.tests).Count -lt 18){throw 'SALES_COPY_PROOF_REQUIRED'}
 $q=OwnSC @('query',$service);if($q.code -ne 1060){throw 'SALES_SERVICE_EXISTS_OR_ACCESS_REFUSED'}
 Plain ([IO.Path]::GetDirectoryName($root));if(Test-Path -LiteralPath $root){Plain $root;$owned=Get-Content -LiteralPath (Join-Path $root '.sales-import-owner.json') -Raw|ConvertFrom-Json;if($owned.marker -cne $marker -or $owned.service -cne $service -or $owned.root -cne $native){throw 'SALES_FOLDER_NOT_OWNED'}}else{$null=New-Item -Path $root -ItemType Directory}
 $owner=(Get-Acl -LiteralPath $root).GetOwner([Security.Principal.SecurityIdentifier]).Value;Acl $root $false $owner
 foreach($sub in @('runtime','status')){$path=Join-Path $root $sub;if(!(Test-Path -LiteralPath $path)){$null=New-Item -Path $path -ItemType Directory};Acl $path $true $owner}
 $exe=Join-Path $repo 'build-verify\sales-import\SCCRMHQSalesImport.exe';if(!(Test-Path -LiteralPath $exe)){throw 'SALES_COMPILED_EXE_REQUIRED'}
 $stage='stage-owned-files';Copy-Item -LiteralPath $exe -Destination (Join-Path $root ($service+'.exe'));Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'README.md') -Destination (Join-Path $root 'README.md')
 $commit=(& git -C $repo rev-parse HEAD).Trim();$owned=@{scope=$scope;marker=$marker;service=$service;root=$native;sourceCommit=$commit;sourceHash=$sourceHash;account='NT AUTHORITY\LocalService';exeHash=(Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant()}
 [IO.File]::WriteAllText((Join-Path $root '.sales-import-owner.json'),($owned|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
 $stage='create-new-service';$create=OwnSC @('create',$service,'binPath=',($native+'\'+$service+'.exe'),'start=','delayed-auto','obj=','NT AUTHORITY\LocalService','DisplayName=','SCCRM HQ Sales Import');if($create.code -ne 0){throw 'SALES_SERVICE_CREATE_FAILED'}
 $recovery=OwnSC @('failure',$service,'reset=','86400','actions=','restart/15000/restart/30000/restart/60000');if($recovery.code -ne 0){throw 'SALES_SERVICE_RECOVERY_FAILED'}
 $start=OwnSC @('start',$service);if($start.code -ne 0){throw 'SALES_SERVICE_START_FAILED'}
 @{ok=$true;service=$service;sourceCommit=$commit;sourceHash=$sourceHash;account='NT AUTHORITY\LocalService';awaitingCredentials=$true;otherServicesChanged=0}|ConvertTo-Json -Compress
}catch{@{ok=$false;stage=$stage;code=$(if($_.Exception.Message -cmatch '^SALES_[A-Z_]+$'){$_.Exception.Message}else{'SALES_SERVICE_STAGE_FAILED'});otherServicesChanged=0}|ConvertTo-Json -Compress;exit 1}
