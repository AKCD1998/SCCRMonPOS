$ErrorActionPreference='Stop'
$repo='AKCD1998/SCCRMonPOS';$tag=$env:POS_RELEASE_ID;$runId=$env:POS_DESKTOP_RUN_ID;$commit=$env:POS_SOURCE_COMMIT
if($env:GITHUB_ACTIONS -cne 'true' -or $tag -cnotmatch '^pos-\d+\.\d+\.\d+$' -or $runId -cnotmatch '^\d+$' -or $commit -cnotmatch '^[a-f0-9]{40}$'){throw 'Invalid CI input'}
function Invoke-InstallerGh([string[]]$Arguments){$result=& gh @Arguments;if($LASTEXITCODE -ne 0){throw 'GitHub operation failed'};return $result}
$run=Invoke-InstallerGh @('run','view',$runId,'--repo',$repo,'--json','headSha,headBranch,event,conclusion,name')|ConvertFrom-Json
if($run.headSha -cne $commit -or $run.headBranch -cne 'master' -or $run.event -cne 'push' -or $run.conclusion -cne 'success' -or $run.name -cne 'Desktop checks' -or (git rev-parse HEAD) -cne $commit){throw 'Unverified master CI source'}
$draft=Invoke-InstallerGh @('release','view',$tag,'--repo',$repo,'--json','isDraft,tagName')|ConvertFrom-Json
if(!$draft.isDraft -or $draft.tagName -cne $tag){throw 'Draft release required'}
$root=Join-Path (Get-Location).Path 'build-verify/ci-installer';New-Item -ItemType Directory -Path $root|Out-Null
$null=Invoke-InstallerGh @('run','download',$runId,'--repo',$repo,'--name',('pos-desktop-'+$commit),'--dir',($root+'/checked'))
$null=Invoke-InstallerGh @('release','download',$tag,'--repo',$repo,'--pattern','stable.json','--pattern','SCCRMonPOS.exe','--dir',($root+'/candidate'))
$proof=Get-Content ($root+'/checked/provenance.json') -Raw|ConvertFrom-Json
$envelope=Get-Content ($root+'/candidate/stable.json') -Raw|ConvertFrom-Json
$metadata=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($envelope.payload))|ConvertFrom-Json
if($proof.commit -cne $commit -or [string]$proof.runId -cne $runId -or $metadata.sourceCommit -cne $commit -or $metadata.sourceDirty -or $metadata.releaseId -cne $tag -or $metadata.sha256 -cne $proof.sha256 -or (Get-FileHash ($root+'/candidate/SCCRMonPOS.exe') -Algorithm SHA256).Hash.ToLowerInvariant() -cne $proof.sha256){throw 'Candidate/source hash mismatch'}
Copy-Item -LiteralPath ($root+'/checked/verifier') -Destination 'build-verify/desktop-feature-check' -Recurse
# Immutable official vendor download, pinned to the previously approved 6.7.3.
$compilerInstaller=Join-Path $root 'innosetup-6.7.3.exe'
Invoke-WebRequest 'https://github.com/jrsoftware/issrc/releases/download/is-6_7_3/innosetup-6.7.3.exe' -OutFile $compilerInstaller
if((Get-FileHash $compilerInstaller -Algorithm SHA256).Hash -cne '9C73C3BAE7ED48D44112A0F48E66742C00090BDB5BEF71D9D3C056C66E97B732'){throw 'Compiler installer hash mismatch'}
$compilerRoot=Join-Path $root 'inno';$install=Start-Process -FilePath $compilerInstaller -ArgumentList @('/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/SP-',('/DIR="'+$compilerRoot+'"')) -WindowStyle Hidden -Wait -PassThru
if($install.ExitCode -ne 0){throw 'CI compiler installation failed'}
& ./tools/Build-Installer.ps1 -ReleaseDirectory ($root+'/candidate') -OutputDirectory ($root+'/setup') -CompilerPath ($compilerRoot+'/ISCC.exe')
if(!$?){throw 'Installer build failed'}
$name='SCCRMonPOS-Setup-'+$metadata.version+'.exe';$setup=Join-Path ($root+'/setup') $name
[IO.File]::WriteAllText(($setup+'.sha256'),((Get-FileHash $setup -Algorithm SHA256).Hash.ToLowerInvariant()+'  '+$name+"`n"),[Text.UTF8Encoding]::new($false))
$null=Invoke-InstallerGh @('release','upload',$tag,'--repo',$repo,$setup,($setup+'.sha256'))
