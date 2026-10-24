$ErrorActionPreference='Stop';Add-Type -AssemblyName System.IO.Compression;Add-Type -AssemblyName System.IO.Compression.FileSystem
$root=$PSScriptRoot;$dest='\\100.90.166.72\D\SCCRM-HQ-SyncSandbox-20261024';$dist=Join-Path $root 'dist'
if(Test-Path -LiteralPath (Join-Path $root 'runtime\pgdata\postmaster.pid')){throw 'PRIVATE_POSTGRES_MUST_BE_STOPPED'}
$test=Get-Content -LiteralPath (Join-Path $root 'runtime\integration-result.json') -Raw|ConvertFrom-Json;if(-not $test.ok -or $test.passed -lt 31){throw 'TESTS_REQUIRED'}
$null=New-Item -ItemType Directory -Path $dist -Force;$archivePath=Join-Path $dist 'runtime-bundle-20261024.zip'
$stream=[IO.File]::Open($archivePath,[IO.FileMode]::CreateNew);$zip=New-Object IO.Compression.ZipArchive($stream,[IO.Compression.ZipArchiveMode]::Create,$false)
try{
 foreach($spec in @(@((Join-Path $root 'node_modules'),'node_modules'),@((Join-Path $root 'runtime\pgdata'),'runtime/pgdata'),@('C:\Program Files\PostgreSQL\18\bin','postgres/bin'),@('C:\Program Files\PostgreSQL\18\lib','postgres/lib'),@('C:\Program Files\PostgreSQL\18\share','postgres/share'))){
  $source=[string]$spec[0];$prefix=[string]$spec[1];foreach($f in @(Get-ChildItem -LiteralPath $source -File -Recurse)){$entry=$prefix+'/'+$f.FullName.Substring($source.Length+1).Replace('\','/');$null=[IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip,$f.FullName,$entry,[IO.Compression.CompressionLevel]::Fastest)}
 }
 $null=[IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip,(Join-Path $root 'runtime\config.json'),'runtime/config.json',[IO.Compression.CompressionLevel]::Fastest)
 $null=[IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip,'\\100.90.166.72\C\Program Files\nodejs\node.exe','node.exe',[IO.Compression.CompressionLevel]::Fastest)
}finally{$zip.Dispose();$stream.Dispose()}
if(-not(Test-Path -LiteralPath $dest)){$null=New-Item -ItemType Directory -Path $dest};foreach($sub in @('runtime','status','test')){if(-not(Test-Path -LiteralPath (Join-Path $dest $sub))){$null=New-Item -ItemType Directory -Path (Join-Path $dest $sub)}}
$code=@(Get-ChildItem -LiteralPath $root -File | Where-Object {$_.Extension -in @('.cjs','.json','.ps1','.cmd','.cs','.sql','.md') -and $_.Name -notin @('WORKPLAN.md','prepare-local.cjs','Stage-HqSandbox.ps1','Stage-HqSandboxArchive.ps1')})
$manifest=New-Object Collections.Generic.List[object]
foreach($f in $code){Copy-Item -LiteralPath $f.FullName -Destination (Join-Path $dest $f.Name) -Force;$manifest.Add([pscustomobject]@{path=$f.Name;sha256=(Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash})}
foreach($f in @(Get-ChildItem -LiteralPath (Join-Path $root 'test') -File)){Copy-Item -LiteralPath $f.FullName -Destination (Join-Path $dest ('test\'+$f.Name)) -Force;$manifest.Add([pscustomobject]@{path='test\'+$f.Name;sha256=(Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash})}
Copy-Item -LiteralPath $archivePath -Destination (Join-Path $dest 'runtime-bundle.zip')
$hash=(Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash;if((Get-FileHash -LiteralPath (Join-Path $dest 'runtime-bundle.zip') -Algorithm SHA256).Hash -cne $hash){throw 'TRANSFER_HASH_MISMATCH'};$manifest.Add([pscustomobject]@{path='runtime-bundle.zip';sha256=$hash})
Copy-Item -LiteralPath (Join-Path $root 'runtime\integration-result.json') -Destination (Join-Path $dest 'status\local-integration-result.json') -Force
[IO.File]::WriteAllText((Join-Path $dest 'package-manifest.json'),($manifest.ToArray()|ConvertTo-Json -Depth 4),(New-Object Text.UTF8Encoding $false))
[ordered]@{ok=$true;folder='D:\SCCRM-HQ-SyncSandbox-20261024';archiveBytes=(Get-Item -LiteralPath $archivePath).Length;archiveHash=$hash;postgresCopiedCold=$true;serviceInstalled=$false}|ConvertTo-Json
