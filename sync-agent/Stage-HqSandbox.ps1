$ErrorActionPreference='Stop'
$root=$PSScriptRoot;$dest='\\100.90.166.72\D\SCCRM-HQ-SyncSandbox-20261024'
if(Test-Path -LiteralPath $dest){throw 'HQ_STAGE_ALREADY_EXISTS_NO_OVERWRITE'}
if(Test-Path -LiteralPath (Join-Path $root 'runtime\pgdata\postmaster.pid')){throw 'PRIVATE_POSTGRES_MUST_BE_STOPPED_BEFORE_COPY'}
$result=Get-Content -LiteralPath (Join-Path $root 'runtime\integration-result.json') -Raw | ConvertFrom-Json;if(-not $result.ok -or $result.passed -lt 31){throw 'INTEGRATION_TESTS_REQUIRED'}
$null=New-Item -ItemType Directory -Path $dest
foreach($file in @(Get-ChildItem -LiteralPath $root -File | Where-Object {$_.Extension -in @('.cjs','.json','.ps1','.cmd','.cs','.sql','.md') -and $_.Name -notin @('WORKPLAN.md','prepare-local.cjs','Stage-HqSandbox.ps1')})){Copy-Item -LiteralPath $file.FullName -Destination (Join-Path $dest $file.Name)}
Copy-Item -LiteralPath (Join-Path $root 'node_modules') -Destination (Join-Path $dest 'node_modules') -Recurse
Copy-Item -LiteralPath (Join-Path $root 'test') -Destination (Join-Path $dest 'test') -Recurse
$null=New-Item -ItemType Directory -Path (Join-Path $dest 'runtime');$null=New-Item -ItemType Directory -Path (Join-Path $dest 'status');$null=New-Item -ItemType Directory -Path (Join-Path $dest 'postgres')
Copy-Item -LiteralPath (Join-Path $root 'runtime\config.json') -Destination (Join-Path $dest 'runtime\config.json')
Copy-Item -LiteralPath (Join-Path $root 'runtime\integration-result.json') -Destination (Join-Path $dest 'status\local-integration-result.json')
Copy-Item -LiteralPath (Join-Path $root 'runtime\pgdata') -Destination (Join-Path $dest 'runtime\pgdata') -Recurse
foreach($folder in @('bin','lib','share')){Copy-Item -LiteralPath (Join-Path 'C:\Program Files\PostgreSQL\18' $folder) -Destination (Join-Path $dest ('postgres\'+$folder)) -Recurse}
Copy-Item -LiteralPath '\\100.90.166.72\C\Program Files\nodejs\node.exe' -Destination (Join-Path $dest 'node.exe')
$manifest=@(Get-ChildItem -LiteralPath $dest -File -Recurse | Where-Object {$_.FullName -notlike ($dest+'\runtime\*') -and $_.FullName -notlike ($dest+'\status\*')} | ForEach-Object {[ordered]@{path=$_.FullName.Substring($dest.Length+1);sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash}})
[IO.File]::WriteAllText((Join-Path $dest 'package-manifest.json'),($manifest|ConvertTo-Json -Depth 4),(New-Object Text.UTF8Encoding $false))
[ordered]@{ok=$true;stagedFolder='D:\SCCRM-HQ-SyncSandbox-20261024';filesVerified=$manifest.Count;postgresCopiedCold=$true;serviceInstalled=$false;onlyTwoTestCopies=$true}|ConvertTo-Json
