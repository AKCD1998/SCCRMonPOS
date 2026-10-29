$ErrorActionPreference='Stop'
if($env:COMPUTERNAME -cne 'SERVER'){throw 'Run on HQ SERVER only'}
$root=[IO.Path]::GetFullPath($PSScriptRoot)
if($root -cne 'D:\SCCRM-HQ-LiveSync-20261024\fanout'){throw 'Unexpected fanout installation directory'}
$manifest=Get-Content -LiteralPath (Join-Path $root 'package-manifest.json') -Raw|ConvertFrom-Json
if($manifest.scope -cne 'SCCRM-HQ-BRANCH-FANOUT-V1'){throw 'Unreviewed package'}
foreach($file in $manifest.files){$path=Join-Path $root $file.path;if((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $file.sha256){throw 'Package file changed'}}
$exe=Join-Path $root 'SCCRMHQMemberFanout.exe';$service=Get-Service -Name SCCRMHQMemberFanout -ErrorAction SilentlyContinue
if(!$service){
 & sc.exe create SCCRMHQMemberFanout binPath= ('"'+$exe+'"') start= delayed-auto obj= 'NT AUTHORITY\LocalService' DisplayName= 'SCCRM HQ Member Fanout'
 if($LASTEXITCODE -ne 0){throw 'Unable to create dedicated fanout service'}
}else{
 $registered=Get-CimInstance Win32_Service -Filter "Name='SCCRMHQMemberFanout'"
 if($registered.PathName.Trim('"') -cne $exe -or $registered.StartName -cne 'NT AUTHORITY\LocalService'){throw 'Existing service identity collision'}
}
if((Get-Service SCCRMHQMemberFanout).Status -ne 'Running'){Start-Service SCCRMHQMemberFanout}
[ordered]@{ok=$true;service='SCCRMHQMemberFanout';state=[string](Get-Service SCCRMHQMemberFanout).Status;account='LocalService';otherServicesChanged=$false}|ConvertTo-Json -Compress
