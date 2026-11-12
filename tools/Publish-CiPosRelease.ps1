[CmdletBinding()]
param(
 [Parameter(Mandatory)][ValidatePattern('^pos-\d+\.\d+\.\d+$')][string]$ReleaseId,
 [Parameter(Mandatory)][ValidatePattern('^\d+\.\d+\.\d+$')][string]$Version,
 [Parameter(Mandatory)][ValidatePattern('^\d+$')][string]$CiRunId,
 [Parameter(Mandatory)][string]$NotesFile,
 [Parameter(Mandatory)][string]$KeyPath,
 [switch]$ResumeDraft
)
$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'));$repo='AKCD1998/SCCRMonPOS'
function Invoke-CiPublishGh([string[]]$Arguments){$r=& gh @Arguments;if($LASTEXITCODE -ne 0){throw 'GitHub publication operation failed; inspect the retained draft and staging directory before retrying.'};return $r}
Push-Location -LiteralPath $root
try {
 if($ReleaseId -cne ('pos-'+$Version) -or (git branch --show-current) -cne 'master' -or (git status --porcelain)){throw 'Clean reviewed master and matching version required'}
 & git fetch origin master;if($LASTEXITCODE -ne 0){throw 'Fetch failed'}
 $commit=git rev-parse HEAD;if($commit -cne (git rev-parse origin/master)){throw 'Master changed; review first'}
 $run=Invoke-CiPublishGh @('run','view',$CiRunId,'--repo',$repo,'--json','headSha,headBranch,event,conclusion,status,name')|ConvertFrom-Json
 if($run.headSha -cne $commit -or $run.headBranch -cne 'master' -or $run.event -cne 'push' -or $run.status -cne 'completed' -or $run.conclusion -cne 'success' -or $run.name -cne 'Desktop checks'){throw 'Successful exact master desktop CI required'}
 $stage=Join-Path $root ('build-verify/releases/'+$ReleaseId);if(Test-Path -LiteralPath $stage){throw 'Staging directory exists; inspect before retrying'}
 New-Item -ItemType Directory -Path $stage|Out-Null
 $null=Invoke-CiPublishGh @('run','download',$CiRunId,'--repo',$repo,'--name',('pos-desktop-'+$commit),'--dir',($stage+'/checked'))
 $proof=Get-Content ($stage+'/checked/provenance.json') -Raw|ConvertFrom-Json
 $exe=Join-Path $stage 'SCCRMonPOS.exe';Copy-Item -LiteralPath ($stage+'/checked/release/SCCRMonPOS.exe') -Destination $exe
 $hash=(Get-FileHash $exe -Algorithm SHA256).Hash.ToLowerInvariant()
 if($proof.commit -cne $commit -or [string]$proof.runId -cne $CiRunId -or $proof.sha256 -cne $hash -or $proof.version -cne ($Version+'.0') -or (Get-Item $exe).VersionInfo.FileVersion -cne ($Version+'.0')){throw 'CI binary provenance mismatch'}
 $notes=[IO.File]::ReadAllText((Resolve-Path -LiteralPath $NotesFile).Path);if($notes.Length -gt 5000){throw 'Notes too long'}
 $payload=[ordered]@{schemaVersion=1;releaseId=$ReleaseId;version=$Version;deviceAccessVersion=1;adaposSetupVersion=1;fleetProtocolVersion=1;downloadUrl="https://github.com/$repo/releases/download/$ReleaseId/SCCRMonPOS.exe";sha256=$hash;size=(Get-Item $exe).Length;notes=$notes;sourceCommit=$commit;sourceDirty=$false;publishedAt=[DateTime]::UtcNow.ToString('o')}
 $bytes=[Text.Encoding]::UTF8.GetBytes(($payload|ConvertTo-Json -Compress));$public=[IO.File]::ReadAllText((Join-Path $root 'SCCRMonPOS/Assets/UpdatePublicKey.xml'))
 $private=[Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($KeyPath),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
 $signer=[Security.Cryptography.RSACryptoServiceProvider]::new();$signer.PersistKeyInCsp=$false
 try {
  $signer.FromXmlString([Text.Encoding]::UTF8.GetString($private));if($signer.ToXmlString($false) -cne $public){throw 'Publisher key mismatch'}
  $signature=$signer.SignData($bytes,[Security.Cryptography.CryptoConfig]::MapNameToOID('SHA256'))
  if(!$signer.VerifyData($bytes,[Security.Cryptography.CryptoConfig]::MapNameToOID('SHA256'),$signature)){throw 'Signature verification failed'}
  $envelope=@{payload=[Convert]::ToBase64String($bytes);signature=[Convert]::ToBase64String($signature)}|ConvertTo-Json -Compress
 } finally {[Array]::Clear($private,0,$private.Length);$signer.Dispose()}
 $manifest=Join-Path $stage 'stable.json';[IO.File]::WriteAllText($manifest,$envelope,[Text.UTF8Encoding]::new($false));[IO.File]::WriteAllText(($stage+'/notes.md'),$notes,[Text.UTF8Encoding]::new($false))
 if($ResumeDraft) {
  $draft=Invoke-CiPublishGh @('release','view',$ReleaseId,'--repo',$repo,'--json','isDraft')|ConvertFrom-Json
  if(!$draft.isDraft){throw 'Resume may only replace an unpublished draft'}
  $null=Invoke-CiPublishGh @('release','edit',$ReleaseId,'--repo',$repo,'--target',$commit,'--title',('SCCRMonPOS '+$Version),'--notes-file',($stage+'/notes.md'))
  $null=Invoke-CiPublishGh @('release','upload',$ReleaseId,'--repo',$repo,'--clobber',$exe,$manifest)
 } else {
  $null=Invoke-CiPublishGh @('release','create',$ReleaseId,'--repo',$repo,'--draft','--target',$commit,'--title',('SCCRMonPOS '+$Version),'--notes-file',($stage+'/notes.md'),$exe,$manifest)
 }
 $null=Invoke-CiPublishGh @('workflow','run','installer-ci.yml','--repo',$repo,'-f',('releaseId='+$ReleaseId),'-f',('desktopRunId='+$CiRunId),'-f',('sourceCommit='+$commit))
 $title='Installer '+$ReleaseId+' / '+$CiRunId;$installerRun=$null
 for($n=0;$n -lt 18 -and !$installerRun;$n++) {
  $runs=Invoke-CiPublishGh @('run','list','--repo',$repo,'--workflow','installer-ci.yml','--limit','20','--json','databaseId,displayTitle,event')|ConvertFrom-Json
  $installerRun=@($runs|Where-Object {$_.displayTitle -ceq $title -and $_.event -ceq 'workflow_dispatch'})|Select-Object -First 1
  if(!$installerRun){Start-Sleep -Seconds 5}
 }
 if(!$installerRun){throw 'Installer dispatch not observed; retain draft'}
 $null=Invoke-CiPublishGh @('run','watch',[string]$installerRun.databaseId,'--repo',$repo,'--exit-status','--interval','5')
 $setupName='SCCRMonPOS-Setup-'+$Version+'.exe';$setupDir=Join-Path $stage 'installer'
 $null=Invoke-CiPublishGh @('release','download',$ReleaseId,'--repo',$repo,'--pattern',$setupName,'--pattern',($setupName+'.sha256'),'--dir',$setupDir)
 $setup=Join-Path $setupDir $setupName;$setupHash=(Get-FileHash $setup -Algorithm SHA256).Hash.ToLowerInvariant()
 if(([IO.File]::ReadAllText(($setup+'.sha256')).Trim()) -cne ($setupHash+'  '+$setupName)){throw 'Installer hash mismatch'}
 if((git status --porcelain)){throw 'Source changed during publication'}
 $null=Invoke-CiPublishGh @('release','edit',$ReleaseId,'--repo',$repo,'--draft=false')
 & (Join-Path $PSScriptRoot 'Update-WebReleaseCatalog.ps1') -ReleaseId $ReleaseId -ManifestPath $manifest -InstallerPath $setup -RecommendReleaseId $ReleaseId -KeyPath $KeyPath
 Copy-Item -LiteralPath $manifest -Destination (Join-Path $root 'releases/stable.json') -Force
 & git add -- releases/stable.json releases/web-catalog.json;if($LASTEXITCODE -ne 0){throw 'Git add failed'}
 & git commit -m ('Recommend POS release '+$ReleaseId) -- releases/stable.json releases/web-catalog.json;if($LASTEXITCODE -ne 0){throw 'Announcement commit failed'}
 & git push origin HEAD:master;if($LASTEXITCODE -ne 0){throw 'Announcement push failed'}
 Write-Output "Published $Version from verified CI $CiRunId; no local compiler or test EXE ran."
}finally{Pop-Location}
