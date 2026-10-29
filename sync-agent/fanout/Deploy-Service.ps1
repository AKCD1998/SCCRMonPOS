[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
$root=$PSScriptRoot;$sourceRepo=[IO.Path]::GetFullPath((Join-Path $root '..\..'))
$dest='\\100.90.166.72\D\SCCRM-HQ-LiveSync-20261024\fanout'
$configFile=Join-Path $root 'runtime\config.json';$proofFile=Join-Path $root 'runtime\native-copy-result.json'
$proof=Get-Content -LiteralPath $proofFile -Raw|ConvertFrom-Json
if(!$proof.ok -or $proof.productionWrites -ne 0 -or $proof.customerPinRead -ne $false -or $proof.passed -lt 80 -or $proof.membershipPolicy.years -ne 100){throw 'Native copy acceptance required'}
foreach($branch in @('001','003','004','005')){if(!$proof.preservation.$branch.unchanged -or $proof.preservation.$branch.columnsChecked -ne 101 -or $proof.membershipValidityByBranch.$branch.calendarYears -ne 100 -or !$proof.membershipValidityByBranch.$branch.nativeSearchSqlEligible -or !$proof.membershipValidityByBranch.$branch.datesPreservedAfterReplay){throw 'All destination copy validity proofs required'}}
$config=Get-Content -LiteralPath $configFile -Raw|ConvertFrom-Json
if($config.scope -cne 'SCCRM-HQ-BRANCH-FANOUT-V1' -or $config.mode -cne 'live'){throw 'Reviewed live configuration required'}
$dirty=& git -C $sourceRepo status --porcelain --untracked-files=all
if($LASTEXITCODE -ne 0 -or $dirty){throw 'Commit/review the exact fanout source before staging'}
$commit=& git -C $sourceRepo rev-parse HEAD
if((Test-Path -LiteralPath $dest)){throw 'Existing fanout folder requires reviewed update procedure; not overwriting it'}
if((Get-Content -LiteralPath '\\100.90.166.72\D\SCCRM-HQ-LiveSync-20261024\node_modules\pg\package.json' -Raw|ConvertFrom-Json).version -cne '8.16.3'){throw 'Unexpected existing Node dependency runtime'}
$null=New-Item -ItemType Directory -Path $dest
$ownerSid=(Get-Acl -LiteralPath $dest).GetOwner([Security.Principal.SecurityIdentifier])
function Set-OwnedAcl([string]$path,[bool]$private,[bool]$status=$false){
 $acl=New-Object Security.AccessControl.DirectorySecurity;$acl.SetAccessRuleProtection($true,$false)
 foreach($pair in @(@('S-1-5-18','FullControl'),@('S-1-5-32-544','FullControl'),@($ownerSid.Value,'FullControl'),@('S-1-5-19',$(if($private -or $status){'Modify'}else{'ReadAndExecute'})))){
  $sid=New-Object Security.Principal.SecurityIdentifier $pair[0];$rule=New-Object Security.AccessControl.FileSystemAccessRule $sid,$pair[1],'ContainerInherit,ObjectInherit','None','Allow';$acl.AddAccessRule($rule)
 }
 if(!$private){$sid=New-Object Security.Principal.SecurityIdentifier 'S-1-5-32-545';$rule=New-Object Security.AccessControl.FileSystemAccessRule $sid,'ReadAndExecute','ContainerInherit,ObjectInherit','None','Allow';$acl.AddAccessRule($rule)}
 Set-Acl -LiteralPath $path -AclObject $acl
}
Set-OwnedAcl $dest $false
foreach($sub in @('runtime','status')){$null=New-Item -ItemType Directory -Path (Join-Path $dest $sub)}
Set-OwnedAcl (Join-Path $dest 'runtime') $true;Set-OwnedAcl (Join-Path $dest 'status') $false $true
$files=@('worker.cjs','engine.cjs','pg-runtime.cjs','sql-adapter.cjs','SqlRpc.ps1','secrets.cjs','SecretBridge.ps1','Install-Service.ps1')
foreach($file in $files){Copy-Item -LiteralPath (Join-Path $root $file) -Destination (Join-Path $dest $file)}
Copy-Item -LiteralPath $configFile -Destination (Join-Path $dest 'config.json')
Copy-Item -LiteralPath (Join-Path $root '..\live\supabase-ca.crt') -Destination (Join-Path $dest 'supabase-ca.crt')
$exe=Join-Path $root 'runtime\SCCRMHQMemberFanout.exe'
& "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /optimize+ /target:exe /reference:System.ServiceProcess.dll /out:$exe (Join-Path $root 'ServiceHost.cs')
if($LASTEXITCODE -ne 0){throw 'Fanout service build failed'}
Copy-Item -LiteralPath $exe -Destination (Join-Path $dest 'SCCRMHQMemberFanout.exe')
$manifestFiles=@(Get-ChildItem -LiteralPath $dest -File|Where-Object Name -ne 'package-manifest.json'|ForEach-Object{[ordered]@{path=$_.Name;sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}})
$manifest=[ordered]@{scope=$config.scope;sourceCommit=$commit;stagedAt=[DateTime]::UtcNow.ToString('o');files=$manifestFiles}
[IO.File]::WriteAllText((Join-Path $dest 'package-manifest.json'),($manifest|ConvertTo-Json -Depth 5),(New-Object Text.UTF8Encoding $false))
$checks=@(foreach($file in $manifestFiles){(Get-FileHash -LiteralPath (Join-Path $dest $file.path) -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $file.sha256})
if($checks -contains $false){throw 'Remote package readback mismatch'}
[ordered]@{ok=$true;folder='D:\SCCRM-HQ-LiveSync-20261024\fanout';sourceCommit=$commit;packageFiles=$manifestFiles.Count;packageReadbackVerified=$true;serviceInstalled=$false;oldWorkerReplaced=$false;credentialsTransferred=$false}|ConvertTo-Json -Compress
