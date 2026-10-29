[CmdletBinding()]
param([ValidateSet('Stage','Activate','Rollback')][string]$Action='Stage',[ValidatePattern('^[a-f0-9]{40}$')][string]$Commit)
# Only the dedicated fanout service is restarted. SQL/Ada/Shopee are untouched.
$ErrorActionPreference='Stop'
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$dest='\\100.90.166.72\D\SCCRM-HQ-LiveSync-20261024'
$remote=Join-Path $dest 'fanout';$codes=Join-Path $dest 'member-codes'
$backup=Join-Path $remote ('runtime\rollback-ar-'+$Commit)
$mutable=@('worker.cjs','engine.cjs','sql-adapter.cjs','SqlRpc.ps1')
$runtimeFiles=@('assignment.cjs','queue.cjs','runtime.cjs','sql-adapter.cjs','SqlRpc.ps1','service.cjs')
function Require([bool]$Condition,[string]$Message){if(!$Condition){throw $Message}}
function Service-State(){
 $output=& sc.exe '\\100.90.166.72' query SCCRMHQMemberFanout
 if($LASTEXITCODE -ne 0){throw 'Owned fanout service unavailable'}
 if(($output -join "`n") -notmatch 'STATE\s+:\s+([1-7])\s+'){throw 'Unable to identify exact service state'}
 return [int]$Matches[1]
}
function Stop-Owned(){
 $state=Service-State
 if($state -eq 4){$null=& sc.exe '\\100.90.166.72' stop SCCRMHQMemberFanout;if($LASTEXITCODE -ne 0){throw 'Unable to stop owned fanout service'}}
 elseif($state -ne 1 -and $state -ne 3){throw 'Unexpected fanout service transition'}
 for($i=0;$i -lt 50;$i++){if((Service-State) -eq 1){return};Start-Sleep -Milliseconds 500};throw 'Fanout stop timed out'
}
function Start-Owned(){
 Require ((Service-State) -eq 1) 'Fanout must be fully stopped before starting'
 $null=& sc.exe '\\100.90.166.72' start SCCRMHQMemberFanout;if($LASTEXITCODE -ne 0){throw 'Unable to start owned fanout service'}
}
Require (![string]::IsNullOrEmpty($Commit)) 'Exact reviewed source commit required'
Require (Test-Path -LiteralPath (Join-Path $remote 'SCCRMHQMemberFanout.exe')) 'Existing owned installation required'
if($Action -ceq 'Stage'){
 $head=(& git -C $repo rev-parse HEAD).Trim();$dirty=& git -C $repo status --porcelain --untracked-files=all
 Require ($LASTEXITCODE -eq 0 -and $head -ceq $Commit -and !$dirty) 'Commit exact clean source before staging'
 $proof=Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\fanout\runtime\acceptance\member-code-native-result.json') -Raw|ConvertFrom-Json
 Require ($proof.ok -and $proof.scope -ceq 'SCCRM-MEMBER-CODES-NATIVE-COPY-ONLY' -and $proof.productionWrites -eq 0 -and $proof.pinRead -eq $false -and $proof.passed -ge 30) 'Native copy acceptance required'
 Require (!(Test-Path -LiteralPath $backup)) 'Rollback package already exists; do not overwrite it'
 $null=New-Item -ItemType Directory -Path $backup
 foreach($file in $mutable+@('config.json','package-manifest.json')){Copy-Item -LiteralPath (Join-Path $remote $file) -Destination (Join-Path $backup $file)}
 Copy-Item -LiteralPath (Join-Path $remote 'runtime\credentials.hybrid.json') -Destination (Join-Path $backup 'credentials.hybrid.json')
 $stage=Join-Path $backup 'staged';$null=New-Item -ItemType Directory -Path $stage
 foreach($file in $mutable){Copy-Item -LiteralPath (Join-Path $PSScriptRoot ('..\fanout\'+$file)) -Destination (Join-Path $stage $file)}
 Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'runtime\config.json') -Destination (Join-Path $stage 'config.json')
 if(!(Test-Path -LiteralPath $codes)){
  $null=New-Item -ItemType Directory -Path $codes
  # Inherit the existing reviewed code directory's ACL, never the private keys.
  $acl=Get-Acl -LiteralPath $remote;Set-Acl -LiteralPath $codes -AclObject $acl
 }else{Require (!(Get-ChildItem -LiteralPath $codes -Force)) 'Unexpected existing member-code runtime folder'}
 foreach($file in $runtimeFiles){Copy-Item -LiteralPath (Join-Path $PSScriptRoot $file) -Destination (Join-Path $codes $file)}
 $files=@(foreach($file in $mutable+@('config.json')){[ordered]@{path=$file;sha256=(Get-FileHash -LiteralPath (Join-Path $stage $file)).Hash.ToLowerInvariant()}})
 $codeFiles=@(foreach($file in $runtimeFiles){[ordered]@{path=$file;sha256=(Get-FileHash -LiteralPath (Join-Path $codes $file)).Hash.ToLowerInvariant()}})
 $manifest=[ordered]@{scope='SCCRM-HQ-MEMBER-CODES-V1';sourceCommit=$Commit;stagedAt=[DateTime]::UtcNow.ToString('o');files=$files;memberCodeFiles=$codeFiles;nativeCustomersModified=$false}
 [IO.File]::WriteAllText((Join-Path $backup 'staged-manifest.json'),($manifest|ConvertTo-Json -Depth 6),(New-Object Text.UTF8Encoding $false))
 [ordered]@{ok=$true;action=$Action;sourceCommit=$Commit;backup=$backup;serviceRestarted=$false}|ConvertTo-Json -Compress;return
}
$manifest=Get-Content -LiteralPath (Join-Path $backup 'staged-manifest.json') -Raw|ConvertFrom-Json
Require ($manifest.scope -ceq 'SCCRM-HQ-MEMBER-CODES-V1' -and $manifest.sourceCommit -ceq $Commit) 'Owned staged manifest required'
if($Action -ceq 'Activate'){
 foreach($entry in $manifest.files){Require ($entry.path -cin @($mutable+@('config.json'))) 'Unexpected staged file';Require ((Get-FileHash -LiteralPath (Join-Path $backup ('staged\'+$entry.path))).Hash.ToLowerInvariant() -ceq $entry.sha256) 'Staged file hash changed'}
 foreach($entry in $manifest.memberCodeFiles){Require ($entry.path -cin $runtimeFiles) 'Unexpected runtime file';Require ((Get-FileHash -LiteralPath (Join-Path $codes $entry.path)).Hash.ToLowerInvariant() -ceq $entry.sha256) 'Member code runtime hash changed'}
 Stop-Owned
 foreach($entry in $manifest.files){Copy-Item -LiteralPath (Join-Path $backup ('staged\'+$entry.path)) -Destination (Join-Path $remote $entry.path) -Force}
 Copy-Item -LiteralPath (Join-Path $backup 'staged-manifest.json') -Destination (Join-Path $remote 'member-code-manifest.json') -Force
 Start-Owned
}else{
 Stop-Owned
 foreach($file in $mutable+@('config.json','package-manifest.json')){Copy-Item -LiteralPath (Join-Path $backup $file) -Destination (Join-Path $remote $file) -Force}
 Copy-Item -LiteralPath (Join-Path $backup 'credentials.hybrid.json') -Destination (Join-Path $remote 'runtime\credentials.hybrid.json') -Force
 Start-Owned
 # Native AR rows/aliases and durable queues remain. Rollback changes code only;
 # pause the HQ creator wrapper separately before using an older deployment.
}
[ordered]@{ok=$true;action=$Action;service='SCCRMHQMemberFanout';otherServicesChanged=$false;memberRowsDeleted=$false}|ConvertTo-Json -Compress
