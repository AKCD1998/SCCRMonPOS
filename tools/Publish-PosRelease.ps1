[CmdletBinding(DefaultParameterSetName = 'Build')]
param(
    [Parameter(Mandatory, ParameterSetName = 'Build')][ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$')][string]$ReleaseId,
    [Parameter(Mandatory, ParameterSetName = 'Build')][ValidateLength(1,60)][string]$Version,
    [Parameter(Mandatory, ParameterSetName = 'Build')][string]$NotesFile,
    [Parameter(Mandatory, ParameterSetName = 'Rollback')][ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$')][string]$RollbackTo,
    [Parameter(ParameterSetName = 'Build')][switch]$PrepareOnly,
    [Parameter(ParameterSetName = 'Build')][string]$InstallerCompilerPath,
    [string]$KeyPath = (Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'SCCRMonPOS-Admin/update-signing-key.dpapi')
)
$ErrorActionPreference = 'Stop'
$posRepository = 'AKCD1998/SCCRMonPOS'
$posRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$posPublicKey = [IO.File]::ReadAllText((Join-Path $posRoot 'SCCRMonPOS/Assets/UpdatePublicKey.xml'))
function Invoke-PosCommand([string]$Command, [string[]]$Arguments) {
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Command failed (exit $LASTEXITCODE). The channel may still point to the previous release; inspect before retrying." }
}
function Read-PosManifest([string]$Path) {
    $posEnvelope = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    $posBytes = [Convert]::FromBase64String($posEnvelope.payload)
    $posVerifier = [Security.Cryptography.RSACryptoServiceProvider]::new()
    $posVerifier.PersistKeyInCsp = $false
    try {
        $posVerifier.FromXmlString($posPublicKey)
        if (!$posVerifier.VerifyData($posBytes, [Security.Cryptography.CryptoConfig]::MapNameToOID('SHA256'), [Convert]::FromBase64String($posEnvelope.signature))) { throw 'Invalid release signature.' }
        return ([Text.Encoding]::UTF8.GetString($posBytes) | ConvertFrom-Json)
    } finally { $posVerifier.Dispose() }
}
Push-Location -LiteralPath $posRoot
try {
    $posDirty = [bool](& git status --porcelain --untracked-files=all)
    if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect source checkout.' }
    if (!$PrepareOnly) {
        if ($posDirty) { throw 'Commit/review the intended source changes first. Publishing requires a clean checkout.' }
        $posBranch = & git branch --show-current
        if ($posBranch -ne 'master') { throw 'Publish from the reviewed master branch.' }
        Invoke-PosCommand 'git' @('fetch','origin','master')
        if ((& git rev-parse HEAD) -ne (& git rev-parse origin/master)) { throw 'Push or fast-forward the reviewed source first; HEAD must match origin/master.' }
    }
    if ($PSCmdlet.ParameterSetName -eq 'Build') {
        if ($ReleaseId.Contains('..')) { throw 'Invalid release identifier.' }
        $posNotes = [IO.File]::ReadAllText((Resolve-Path -LiteralPath $NotesFile).Path)
        if ($posNotes.Length -gt 5000) { throw 'Release notes must be at most 5,000 characters.' }
        $posStage = Join-Path $posRoot ('build-verify/releases/' + $ReleaseId)
        if (Test-Path -LiteralPath $posStage) { throw 'Release staging directory exists; use a new identifier or inspect the existing release.' }
        New-Item -ItemType Directory -Path $posStage -Force | Out-Null
        $posVswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
        $posMsbuild = & $posVswhere -latest -requires Microsoft.Component.MSBuild -find 'MSBuild\**\Bin\MSBuild.exe' | Select-Object -First 1
        if (!$posMsbuild) { throw 'Visual Studio MSBuild with .NET Framework 4.8 targeting support is required.' }
        Invoke-PosCommand $posMsbuild @('SCCRMonPOS/SCCRMonPOS.csproj','/t:Rebuild','/p:Configuration=Release','/nologo','/v:minimal')
        Invoke-PosCommand $posMsbuild @('tools/DesktopFeatureCheck.csproj','/t:Build','/p:Configuration=Release','/nologo','/v:minimal')
        Invoke-PosCommand (Join-Path $posRoot 'build-verify/desktop-feature-check/DesktopFeatureCheck.exe') @()
        Invoke-PosCommand $posMsbuild @('tools/MemberApiCheck.csproj','/t:Build','/p:Configuration=Release','/nologo','/v:minimal')
        Invoke-PosCommand (Join-Path $posRoot 'build-verify/member-api-check/MemberApiCheck.exe') @()
        Invoke-PosCommand $posMsbuild @('tools/DeviceAccessCheck.csproj','/t:Build','/p:Configuration=Release','/nologo','/v:minimal')
        Invoke-PosCommand (Join-Path $posRoot 'build-verify/device-access-check/DeviceAccessCheck.exe') @()
        Invoke-PosCommand $posMsbuild @('tools/PurchaseHistoryCheck.csproj','/t:Build','/p:Configuration=Release','/nologo','/v:minimal')
        Invoke-PosCommand (Join-Path $posRoot 'build-verify/purchase-history-check/PurchaseHistoryCheck.exe') @()
        Invoke-PosCommand $posMsbuild @('tools/AdaPosSetupCheck.csproj','/t:Build','/p:Configuration=Release','/nologo','/v:minimal')
        Invoke-PosCommand (Join-Path $posRoot 'build-verify/adapos-setup-check/AdaPosSetupCheck.exe') @()
        Invoke-PosCommand $posMsbuild @('tools/ReceiptScopeCheck.csproj','/t:Build','/p:Configuration=Release','/nologo','/v:minimal')
        Invoke-PosCommand (Join-Path $posRoot 'build-verify/receipt-scope-check/ReceiptScopeCheck.exe') @()
        $posExe = Join-Path $posStage 'SCCRMonPOS.exe'
        Copy-Item -LiteralPath 'SCCRMonPOS/bin/Release/SCCRMonPOS.exe' -Destination $posExe
        $posManifest = Join-Path $posStage 'stable.json'
        $posPayload = [ordered]@{
            schemaVersion = 1; releaseId = $ReleaseId; version = $Version; deviceAccessVersion = 1; adaposSetupVersion = 1
            downloadUrl = "https://github.com/$posRepository/releases/download/$ReleaseId/SCCRMonPOS.exe"
            sha256 = (Get-FileHash -LiteralPath $posExe -Algorithm SHA256).Hash.ToLowerInvariant()
            size = (Get-Item -LiteralPath $posExe).Length; notes = $posNotes
            sourceCommit = (& git rev-parse HEAD); sourceDirty = $posDirty
            publishedAt = [DateTime]::UtcNow.ToString('o')
        }
        $posPayloadBytes = [Text.Encoding]::UTF8.GetBytes(($posPayload | ConvertTo-Json -Compress))
        $posPrivate = [Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($KeyPath), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
        $posSigner = [Security.Cryptography.RSACryptoServiceProvider]::new()
        $posSigner.PersistKeyInCsp = $false
        try {
            $posSigner.FromXmlString([Text.Encoding]::UTF8.GetString($posPrivate))
            if ($posSigner.ToXmlString($false) -ne $posPublicKey) { throw 'Signing key does not match the public key embedded in this source.' }
            $posSignature = $posSigner.SignData($posPayloadBytes, [Security.Cryptography.CryptoConfig]::MapNameToOID('SHA256'))
            $posEnvelope = @{ payload = [Convert]::ToBase64String($posPayloadBytes); signature = [Convert]::ToBase64String($posSignature) } | ConvertTo-Json -Compress
            [IO.File]::WriteAllText($posManifest, $posEnvelope, [Text.UTF8Encoding]::new($false))
        } finally { [Array]::Clear($posPrivate,0,$posPrivate.Length); $posSigner.Dispose() }
        $null = Read-PosManifest $posManifest
        if ($PrepareOnly -and $posDirty) {
            [IO.File]::WriteAllText((Join-Path $posStage 'notes.md'), $posNotes, [Text.UTF8Encoding]::new($false))
            Write-Output "Prepared locally only: $posStage. Setup requires a reviewed clean source."
            return
        }
        $posSetupDirectory = Join-Path $posStage 'installer'
        & (Join-Path $PSScriptRoot 'Build-Installer.ps1') -ReleaseDirectory $posStage -OutputDirectory $posSetupDirectory -CompilerPath $InstallerCompilerPath
        $posSetup = Join-Path $posSetupDirectory ("SCCRMonPOS-Setup-$Version.exe")
        if (!(Test-Path -LiteralPath $posSetup)) { throw 'Installer was not produced; release has not been published.' }
        $posSetupHash = $posSetup + '.sha256'
        [IO.File]::WriteAllText($posSetupHash, ((Get-FileHash -LiteralPath $posSetup -Algorithm SHA256).Hash.ToLowerInvariant() + '  ' + [IO.Path]::GetFileName($posSetup) + "`n"), [Text.UTF8Encoding]::new($false))
        [IO.File]::WriteAllText((Join-Path $posStage 'notes.md'), $posNotes, [Text.UTF8Encoding]::new($false))
        if ($PrepareOnly) { Write-Output "Prepared locally only: $posStage"; return }
        Invoke-PosCommand 'gh' @('release','create',$ReleaseId,'--repo',$posRepository,'--target',$posPayload.sourceCommit,'--title',"SCCRMonPOS $Version",'--notes-file',(Join-Path $posStage 'notes.md'),$posExe,$posManifest,$posSetup,$posSetupHash)
        & (Join-Path $PSScriptRoot 'Update-WebReleaseCatalog.ps1') -ReleaseId $ReleaseId -ManifestPath $posManifest -InstallerPath $posSetup -RecommendReleaseId $ReleaseId -KeyPath $KeyPath
    } else {
        if ($RollbackTo.Contains('..')) { throw 'Invalid release identifier.' }
        $posStage = Join-Path $posRoot ('build-verify/channel-' + [Guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $posStage | Out-Null
        Invoke-PosCommand 'gh' @('release','download',$RollbackTo,'--repo',$posRepository,'--pattern','stable.json','--dir',$posStage)
        $posManifest = Join-Path $posStage 'stable.json'
        $posPrevious = Read-PosManifest $posManifest
        if ($posPrevious.releaseId -ne $RollbackTo -or $posPrevious.sourceDirty -or $posPrevious.downloadUrl -ne "https://github.com/$posRepository/releases/download/$RollbackTo/SCCRMonPOS.exe") { throw 'Unexpected release metadata.' }
        & (Join-Path $PSScriptRoot 'Update-WebReleaseCatalog.ps1') -RecommendReleaseId $RollbackTo -KeyPath $KeyPath
    }
    # Commit the desktop and website announcements together. Publishing a
    # channel announces a recommendation; clients still require a local click.
    New-Item -ItemType Directory -Force -Path (Join-Path $posRoot 'releases') | Out-Null
    Copy-Item -LiteralPath $posManifest -Destination (Join-Path $posRoot 'releases/stable.json') -Force
    Invoke-PosCommand 'git' @('add','--','releases/stable.json','releases/web-catalog.json')
    & git diff --cached --quiet -- releases/stable.json releases/web-catalog.json
    if ($LASTEXITCODE -eq 0) { Write-Output 'This release is already announced.'; return }
    if ($LASTEXITCODE -ne 1) { throw 'Cannot inspect channel change.' }
    $posAnnounced = Read-PosManifest (Join-Path $posRoot 'releases/stable.json')
    Invoke-PosCommand 'git' @('commit','-m',("Recommend POS release " + $posAnnounced.releaseId),'--','releases/stable.json','releases/web-catalog.json')
    Invoke-PosCommand 'git' @('push','origin','HEAD:master')
    Write-Output "Announced $($posAnnounced.version). Online clients check within five minutes; installation remains optional."
} finally { Pop-Location }
