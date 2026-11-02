[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.Encoding]::UTF8
$scope='SCCRM-ADA-PRIMARY-POINTS-SERVICE-V1';$marker='c25c42de-d85d-4fac-bd60-794de1abdb7c';$service='SCCRMHQPointSync'
$expectedRoot='D:\SCCRM-HQ-LiveSync-20261024\points';$root=[IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\')
$files=@('run-service.cjs','worker.cjs','export.cjs','model.cjs','projection.cjs','compensation.cjs','store.cjs','delivery.cjs','native-adapter.cjs','Read-NativePoints.ps1','Invoke-PointNative.ps1','secrets.cjs','SecretBridge.ps1','Prepare-PrivateRuntime.ps1','Install-Service.ps1','DEPLOY_TH.md','config.json','supabase-ca.crt','SCCRMHQPointSync.exe','.point-service-owner.json')
$stage='identity';$created=$false
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
try{
 if($env:COMPUTERNAME -cne 'SERVER' -or !$root.Equals($expectedRoot,[StringComparison]::OrdinalIgnoreCase)){throw 'POINT_LOCAL_HQ_LOCATION_REQUIRED'}
 $principal=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
 if(!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'POINT_LOCAL_ADMIN_REQUIRED'}
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
 $stage='own-service'
 $exe=Join-Path $root 'SCCRMHQPointSync.exe';$registered=Get-CimInstance Win32_Service -Filter "Name='SCCRMHQPointSync'"
 if($registered){
  if(!$registered.PathName.Trim().Trim('"').Equals($exe,[StringComparison]::OrdinalIgnoreCase) -or $registered.StartName -cne 'NT AUTHORITY\LocalService'){throw 'POINT_EXISTING_SERVICE_IDENTITY_COLLISION'}
  $delayed=(Get-ItemProperty -LiteralPath ('HKLM:\SYSTEM\CurrentControlSet\Services\'+$service) -Name DelayedAutoStart -ErrorAction SilentlyContinue).DelayedAutoStart
  if($registered.StartMode -cne 'Auto' -or $delayed -ne 1){throw 'POINT_EXISTING_SERVICE_START_MODE_REFUSED'}
 }else{
  $output=& sc.exe create $service binPath= ('"'+$exe+'"') start= delayed-auto obj= 'NT AUTHORITY\LocalService' DisplayName= 'SCCRM HQ Ada Points Sync'
  if($LASTEXITCODE -ne 0){throw 'POINT_SERVICE_CREATE_FAILED'};$created=$true
  $output=& sc.exe description $service 'Dedicated headless Ada-authoritative points. Does not control AdaPos, SQL Server, member sync or Shopee.'
  if($LASTEXITCODE -ne 0){throw 'POINT_SERVICE_DESCRIPTION_FAILED'}
 }
 if((Get-Service -Name $service).Status -ne 'Running'){Start-Service -Name $service;(Get-Service -Name $service).WaitForStatus([ServiceProcess.ServiceControllerStatus]::Running,[TimeSpan]::FromSeconds(10))}
 $registered=Get-CimInstance Win32_Service -Filter "Name='SCCRMHQPointSync'"
 if(!$registered -or $registered.State -cne 'Running' -or $registered.ProcessId -le 0 -or [Diagnostics.Process]::GetProcessById([int]$registered.ProcessId).SessionId -ne 0){throw 'POINT_SERVICE_SESSION_ZERO_REQUIRED'}
 $stage='bootstrap-pending';$ready=$false;$deadline=[DateTime]::UtcNow.AddSeconds(25)
 while([DateTime]::UtcNow -lt $deadline){
  $identityFile=Join-Path $root 'status\bootstrap-identity.json';$publicFile=Join-Path $root 'status\bootstrap-public.json'
  if((Test-Path -LiteralPath $identityFile) -and (Test-Path -LiteralPath $publicFile)){
   try{$identity=Get-Content -LiteralPath $identityFile -Raw|ConvertFrom-Json;$public=Get-Content -LiteralPath $publicFile -Raw|ConvertFrom-Json
    $modulus=if($public.n -cmatch '^[A-Za-z0-9_-]{683}$'){[Convert]::FromBase64String(([string]$public.n).Replace('-','+').Replace('_','/')+'=')}else{@()}
    $ready=$identity.machine -ceq 'SERVER' -and $identity.sessionId -eq 0 -and $identity.accountSid -ceq 'S-1-5-19' -and $public.kty -ceq 'RSA' -and $modulus.Length -eq 512 -and ($modulus[0] -band 128) -eq 128 -and $public.e -ceq 'AQAB'
   }catch{$ready=$false}
   if($ready){break}
  }
  Start-Sleep -Milliseconds 500
 }
 $credentialsPresent=Test-Path -LiteralPath (Join-Path $root 'runtime\credentials.hybrid.json')
 $report=[ordered]@{installed=$true;service=$service;serviceCreated=$created;state=if($ready -and !$credentialsPresent){'awaiting_credentials'}elseif($ready){'running_verification_pending'}else{'bootstrap_pending'};healthyPending=$true;syncReady=$false;bootstrapReady=$ready;sessionId=0;account='NT AUTHORITY\LocalService';accountSid='S-1-5-19';startup='Automatic (Delayed Start)';servicePid=$registered.ProcessId;sourcePatchDigest=$manifest.sourcePatchDigest;credentialsTransferred=$false;otherServicesChanged=$false;installedAt=[DateTime]::UtcNow.ToString('o')}
 [IO.File]::WriteAllText((Join-Path $root 'status\install-result.json'),($report|ConvertTo-Json -Depth 4),(New-Object Text.UTF8Encoding $false))
 $report|ConvertTo-Json -Depth 4 -Compress
}catch{$code=if($_.Exception.Message -cmatch '^[A-Z][A-Z_0-9]{4,100}$'){$_.Exception.Message}else{'POINT_INSTALL_FAILED'};[ordered]@{installed=$false;code=$code;stage=$stage;serviceCreated=$created;healthyPending=$true;syncReady=$false;otherServicesChanged=$false;detailsWithheld=$true}|ConvertTo-Json -Compress;exit 1}
