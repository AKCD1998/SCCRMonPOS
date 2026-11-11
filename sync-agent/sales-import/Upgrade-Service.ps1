param()
$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.Encoding]::UTF8
$root='\\100.90.166.72\D\SCCRM-HQ-LiveSync-20261024\sales-import';$service='SCCRMHQSalesImport';$remote='\\100.90.166.72';$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
function OwnSC([string]$action){if($action -cnotin @('query','stop','start')){throw 'SALES_SERVICE_SCOPE_REFUSED'};$old=$ErrorActionPreference;try{$ErrorActionPreference='Continue';$out=@(& "$env:WINDIR\System32\sc.exe" $remote $action $service 2>&1);$code=$LASTEXITCODE}finally{$ErrorActionPreference=$old};if($code -ne 0){throw 'SALES_SERVICE_CONTROL_FAILED'};return ($out -join "`n")}
try{
 foreach($path in @($root,(Join-Path $root '.sales-import-owner.json'),(Join-Path $root ($service+'.exe')))){if(((Get-Item -LiteralPath $path).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'SALES_SERVICE_REPARSE_REFUSED'}}
 $owned=Get-Content -LiteralPath (Join-Path $root '.sales-import-owner.json') -Raw|ConvertFrom-Json
 if($owned.marker -cne 'b740db43-5811-44cb-b072-0480a0b26f19' -or $owned.service -cne $service -or $owned.root -cne 'D:\SCCRM-HQ-LiveSync-20261024\sales-import'){throw 'SALES_FOLDER_NOT_OWNED'}
 $dirty=@(& git -C $repo status --porcelain --untracked-files=all);if($dirty.Count -or $LASTEXITCODE -ne 0){throw 'SALES_COMMITTED_SOURCE_REQUIRED'}
 $proof=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'runtime\copy-proof.json') -Raw|ConvertFrom-Json
 $memory=New-Object IO.MemoryStream;foreach($file in @('SalesImport.cs','schema.cjs','queue.sql')){$bytes=[IO.File]::ReadAllBytes((Join-Path $PSScriptRoot $file));$memory.Write($bytes,0,$bytes.Length)};$sha=[Security.Cryptography.SHA256]::Create();$sourceHash=[BitConverter]::ToString($sha.ComputeHash($memory.ToArray())).Replace('-','').ToLowerInvariant();$memory.Dispose();$sha.Dispose()
 if(!$proof.ok -or $proof.sourceHash -cne $sourceHash -or @($proof.tests).Count -lt 30 -or $proof.productionWrites -ne 0){throw 'SALES_COPY_PROOF_REQUIRED'}
 $exe=Join-Path $root ($service+'.exe');if((Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant() -cne $owned.exeHash){throw 'SALES_INSTALLED_EXE_CHANGED'}
 if((OwnSC 'query') -notmatch 'STATE\s*:\s*1\s+STOPPED'){$null=OwnSC 'stop'};$stopped=$false;for($i=0;$i -lt 30;$i++){if((OwnSC 'query') -match 'STATE\s*:\s*1\s+STOPPED'){$stopped=$true;break};Start-Sleep -Milliseconds 500};if(!$stopped){throw 'SALES_SERVICE_STOP_TIMEOUT'}
 $built=Join-Path $repo 'build-verify\sales-import\SCCRMHQSalesImport.exe';Copy-Item -LiteralPath $exe -Destination (Join-Path $root 'SCCRMHQSalesImport.previous.exe') -Force
 $copied=$false;for($i=0;$i -lt 5;$i++){try{Copy-Item -LiteralPath $built -Destination $exe -Force;$copied=$true;break}catch{if($_.Exception -isnot [IO.IOException]){throw};Start-Sleep -Milliseconds 500}};if(!$copied){throw 'SALES_SERVICE_EXE_STILL_LOCKED'}
 $owned.exeHash=(Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant();$owned.sourceHash=$sourceHash;$owned.sourceCommit=(& git -C $repo rev-parse HEAD).Trim()
 [IO.File]::WriteAllText((Join-Path $root '.sales-import-owner.json'),($owned|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false));Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'README.md') -Destination (Join-Path $root 'README.md') -Force
 @{ok=$true;stopped=$true;service=$service;sourceHash=$sourceHash;sourceCommit=$owned.sourceCommit;awaitingReviewedSqlUpgrade=$true;otherServicesChanged=0}|ConvertTo-Json -Compress
}catch{@{ok=$false;code=$(if($_.Exception.Message -cmatch '^SALES_[A-Z_]+$'){$_.Exception.Message}else{'SALES_SERVICE_UPGRADE_FAILED'});otherServicesChanged=0}|ConvertTo-Json -Compress;exit 1}
