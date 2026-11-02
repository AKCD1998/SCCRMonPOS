[CmdletBinding()]
param([switch]$ValidateOnly)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.Encoding]::UTF8
$scope='SCCRM-ADA-PRIMARY-POINTS-SERVICE-V1'
$marker='c25c42de-d85d-4fac-bd60-794de1abdb7c'
$service='SCCRMHQPointSync'
$source=[IO.Path]::GetFullPath($PSScriptRoot)
$localRoot='D:\SCCRM-HQ-LiveSync-20261024\points'
$parent='\\100.90.166.72\D\SCCRM-HQ-LiveSync-20261024'
$destination=Join-Path $parent 'points'
$runtime=Join-Path $source 'runtime'
$runtimeFiles=@('run-service.cjs','worker.cjs','export.cjs','model.cjs','projection.cjs','compensation.cjs','store.cjs','delivery.cjs','native-adapter.cjs','Read-NativePoints.ps1','Invoke-PointNative.ps1','secrets.cjs','SecretBridge.ps1','Prepare-PrivateRuntime.ps1','Install-Service.ps1','DEPLOY_TH.md')
$stage='local-review'
function Sha([string]$text){$h=[Security.Cryptography.SHA256]::Create();try{return ([BitConverter]::ToString($h.ComputeHash([Text.Encoding]::UTF8.GetBytes($text)))).Replace('-','').ToLowerInvariant()}finally{$h.Dispose()}}
function FileHash([string]$file){return (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()}
function No-Reparse([string]$file){if(((Get-Item -LiteralPath $file).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'POINT_PACKAGE_REPARSE_REFUSED'}}
function No-Secrets([object]$value){
 if($null -eq $value){return}
 if($value -is [string]){if($value -match '(?i)(?:password|pwd|user id|uid|token)\s*=|postgres(?:ql)?://|BEGIN .*PRIVATE KEY'){throw 'POINT_PUBLIC_CONFIG_SECRET_REFUSED'};return}
 if($value -is [Collections.IDictionary]){foreach($key in $value.Keys){if([string]$key -match '(?i)password|passwd|credential|secret|token|api[_-]?key|service[_-]?role|private[_-]?key|connection[_-]?string|pg[_-]?url|encrypted[_-]?key|ciphertext|^pwd$'){throw 'POINT_PUBLIC_CONFIG_SECRET_REFUSED'};No-Secrets $value[$key]};return}
 if($value -is [Collections.IEnumerable]){foreach($item in $value){No-Secrets $item};return}
 if($value -is [pscustomobject]){foreach($property in $value.PSObject.Properties){if($property.Name -match '(?i)password|passwd|credential|secret|token|api[_-]?key|service[_-]?role|private[_-]?key|connection[_-]?string|pg[_-]?url|encrypted[_-]?key|ciphertext|^pwd$'){throw 'POINT_PUBLIC_CONFIG_SECRET_REFUSED'};No-Secrets $property.Value}}
}
function Check-Config([object]$config){
 No-Secrets $config
 if($config.scope -cne $scope -or $config.mode -cne 'Live'){throw 'POINT_LIVE_CONFIG_REQUIRED'}
 foreach($field in @('sources','targets')){if(@($config.$field).Count -ne 5 -or (@($config.$field|ForEach-Object{$_.branchCode}|Sort-Object) -join ',') -cne '000,001,003,004,005'){throw 'POINT_FIVE_CONFIGURED_DATABASES_REQUIRED'}}
 $machines=@{'000'='SERVER';'001'='SC_001';'003'='POSSRV';'004'='SERVER004';'005'='POSSRV'}
 foreach($entry in $config.sources){if($entry.machine -cne $machines[$entry.branchCode] -or $entry.databaseIdentity -cne ($entry.branchCode+'/'+$entry.machine+'/AdaAcc')){throw 'POINT_CONFIG_IDENTITY_REFUSED'}}
 foreach($target in $config.targets){$entry=@($config.sources|Where-Object{$_.branchCode -ceq $target.branchCode});if($entry.Count -ne 1 -or $target.databaseIdentity -cne $entry[0].databaseIdentity -or $target.enabled -isnot [bool] -or $target.targetId -cnotmatch '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$'){throw 'POINT_CONFIG_TARGET_REFUSED'}}
 if($config.runtimeDirectory -and $config.runtimeDirectory -cne ($localRoot+'\runtime')){throw 'POINT_CONFIG_RUNTIME_PATH_REFUSED'}
}
function Owned-Acl([string]$path,[string]$owner,[bool]$private){
 $acl=[IO.Directory]::GetAccessControl($path,[Security.AccessControl.AccessControlSections]::Access)
 $acl.SetAccessRuleProtection($true,$false)
 foreach($rule in @($acl.GetAccessRules($true,$false,[Security.Principal.SecurityIdentifier]))){$acl.RemoveAccessRuleSpecific($rule)}
 $rights=@{'S-1-5-18'='FullControl';'S-1-5-32-544'='FullControl'};$rights[$owner]='FullControl';$rights['S-1-5-19']=if($private){'Modify'}else{'ReadAndExecute'}
 if(!$private){$rights['S-1-5-32-545']='ReadAndExecute'}
 foreach($sidText in $rights.Keys){$sid=New-Object Security.Principal.SecurityIdentifier $sidText;$rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,$rights[$sidText],'ContainerInherit,ObjectInherit','None','Allow');$acl.AddAccessRule($rule)}
 [IO.Directory]::SetAccessControl($path,$acl)
}
try{
 No-Reparse $source
 $configFile=Join-Path $runtime 'config.json';if(!(Test-Path -LiteralPath $configFile -PathType Leaf)){throw 'POINT_REVIEWED_PUBLIC_CONFIG_REQUIRED'};$config=Get-Content -LiteralPath $configFile -Raw -Encoding UTF8|ConvertFrom-Json;Check-Config $config
 foreach($check in @(@('native-copy-result.json',30),@('store-copy-result.json',22))){$report=Get-Content -LiteralPath (Join-Path $runtime $check[0]) -Raw -Encoding UTF8|ConvertFrom-Json;if($report.ok -ne $true -or $report.passed -lt $check[1] -or $report.productionWrites -ne 0 -or $report.pinRead -ne $false){throw 'POINT_COPY_ACCEPTANCE_REQUIRED'}}
 foreach($file in $runtimeFiles){$path=Join-Path $source $file;No-Reparse $path;if(!(Test-Path -LiteralPath $path -PathType Leaf)){throw 'POINT_RUNTIME_FILE_MISSING'}}
 $certificate=Join-Path $source '..\live\supabase-ca.crt';No-Reparse $certificate;$pem=Get-Content -LiteralPath $certificate -Raw;if($pem -notmatch '-----BEGIN CERTIFICATE-----' -or $pem -match 'PRIVATE KEY'){throw 'POINT_PUBLIC_CA_REQUIRED'}
 $hostSource=Join-Path $source 'ServiceHost.cs';No-Reparse $hostSource;$hostText=Get-Content -LiteralPath $hostSource -Raw
 foreach($pattern in @('ServiceName="SCCRMHQPointSync"','ProcessPriorityClass.BelowNormal','ProcessWindowStyle.Hidden','CreateNoWindow=true','AssignProcessToJobObject','0x2000')){if(!$hostText.Contains($pattern)){throw 'POINT_HEADLESS_SERVICE_HOST_REQUIRED'}}
 $sourceFiles=@(foreach($name in $runtimeFiles){[ordered]@{path=$name;sha256=FileHash (Join-Path $source $name)}})
 $sourceFiles+=@([ordered]@{path='ServiceHost.cs';sha256=FileHash $hostSource},[ordered]@{path='runtime/config.json';sha256=FileHash $configFile},[ordered]@{path='supabase-ca.crt';sha256=FileHash $certificate},[ordered]@{path='Stage-Service.ps1';sha256=FileHash $PSCommandPath})
 $repo=(& git -C $source rev-parse --show-toplevel);if($LASTEXITCODE -ne 0){throw 'POINT_SOURCE_REPOSITORY_REQUIRED'}
 $commit=(& git -C $repo rev-parse HEAD);if($LASTEXITCODE -ne 0){throw 'POINT_SOURCE_REVISION_REQUIRED'}
 $diff=(& git -C $repo diff --binary HEAD -- sync-agent/points);if($LASTEXITCODE -ne 0){throw 'POINT_SOURCE_DIFF_REQUIRED'}
 $patchDigest=Sha (([ordered]@{commit=[string]$commit;trackedDiffHash=Sha ($diff -join "`n");sourceFiles=$sourceFiles})|ConvertTo-Json -Depth 6 -Compress)
 $stage='local-compile'
 $null=New-Item -ItemType Directory -Path $runtime -Force
 $exe=Join-Path $runtime 'SCCRMHQPointSync.exe';$csc=Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
 if(!(Test-Path -LiteralPath $csc)){$csc=Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe'}
 & $csc /nologo /optimize+ /target:winexe /platform:anycpu /reference:System.ServiceProcess.dll /out:$exe $hostSource
 if($LASTEXITCODE -ne 0){throw 'POINT_SERVICE_COMPILE_FAILED'}
 if($ValidateOnly){[ordered]@{validated=$true;sourcePatchDigest=$patchDigest;compiled=$true;sourceCommit=[string]$commit;remoteAccessed=$false;serviceInstalled=$false;credentialsTransferred=$false}|ConvertTo-Json -Compress;exit 0}
 $stage='remote-fresh-folder'
 if([IO.Path]::GetFullPath($destination) -cne $destination -or (Test-Path -LiteralPath $destination)){throw 'POINT_FRESH_FOLDER_REQUIRED_NO_OVERWRITE'}
 No-Reparse $parent
 if(!(Test-Path -LiteralPath (Join-Path $parent 'node.exe') -PathType Leaf)){throw 'POINT_EXISTING_NODE_REQUIRED'}
 $pgPackage=Join-Path $parent 'node_modules\pg\package.json';$pg=Get-Content -LiteralPath $pgPackage -Raw|ConvertFrom-Json;if($pg.version -cne '8.16.3'){throw 'POINT_EXISTING_PG_RUNTIME_REFUSED'}
 $dependencies=@([ordered]@{path='..\node.exe';sha256=FileHash (Join-Path $parent 'node.exe')},[ordered]@{path='..\node_modules\pg\package.json';sha256=FileHash $pgPackage})
 $null=New-Item -ItemType Directory -Path $destination
 $owner=(Get-Acl -LiteralPath $destination).GetOwner([Security.Principal.SecurityIdentifier]).Value;if($owner -ceq 'S-1-5-19'){throw 'POINT_SERVICE_MUST_NOT_OWN_PACKAGE'}
 Owned-Acl $destination $owner $false
 foreach($sub in @('runtime','status')){$directory=Join-Path $destination $sub;$null=New-Item -ItemType Directory -Path $directory;Owned-Acl $directory $owner $true}
 foreach($file in $runtimeFiles){Copy-Item -LiteralPath (Join-Path $source $file) -Destination (Join-Path $destination $file)}
 Copy-Item -LiteralPath $configFile -Destination (Join-Path $destination 'config.json')
 Copy-Item -LiteralPath $certificate -Destination (Join-Path $destination 'supabase-ca.crt')
 Copy-Item -LiteralPath $exe -Destination (Join-Path $destination 'SCCRMHQPointSync.exe')
 $ownerFile=[ordered]@{scope=$scope;marker=$marker;service=$service;machine='SERVER';root=$localRoot;createdAt=[DateTime]::UtcNow.ToString('o')}
 [IO.File]::WriteAllText((Join-Path $destination '.point-service-owner.json'),($ownerFile|ConvertTo-Json -Compress),(New-Object Text.UTF8Encoding $false))
 $files=@(foreach($file in @($runtimeFiles)+@('config.json','supabase-ca.crt','SCCRMHQPointSync.exe','.point-service-owner.json')){[ordered]@{path=$file;sha256=FileHash (Join-Path $destination $file)}})
 # Refuse a source changing while another agent is finishing a patch. No partial
 # package is installed or silently replaced; the new folder remains for review.
 foreach($entry in $sourceFiles){$original=if($entry.path -ceq 'supabase-ca.crt'){$certificate}else{Join-Path $source $entry.path};if((FileHash $original) -cne $entry.sha256){throw 'POINT_SOURCE_CHANGED_DURING_STAGING'}}
 $manifest=[ordered]@{scope=$scope;marker=$marker;service=$service;machine='SERVER';root=$localRoot;account='NT AUTHORITY\LocalService';sourceCommit=[string]$commit;sourcePatchDigest=$patchDigest;stagedAt=[DateTime]::UtcNow.ToString('o');files=$files;dependencies=$dependencies}
 [IO.File]::WriteAllText((Join-Path $destination 'package-manifest.json'),($manifest|ConvertTo-Json -Depth 8),(New-Object Text.UTF8Encoding $false))
 foreach($file in $files){if((FileHash (Join-Path $destination $file.path)) -cne $file.sha256){throw 'POINT_REMOTE_PACKAGE_READBACK_FAILED'}}
 [ordered]@{staged=$true;folder=$localRoot;sourcePatchDigest=$patchDigest;sourceCommit=[string]$commit;packageFiles=$files.Count;packageReadbackVerified=$true;serviceInstalled=$false;credentialsTransferred=$false;otherFilesChanged=$false}|ConvertTo-Json -Compress
}catch{$code=if($_.Exception.Message -cmatch '^[A-Z][A-Z_0-9]{4,100}$'){$_.Exception.Message}else{'POINT_STAGE_FAILED'};[ordered]@{staged=$false;code=$code;stage=$stage;serviceInstalled=$false;credentialsTransferred=$false;detailsWithheld=$true}|ConvertTo-Json -Compress;exit 1}
