param(
    [string]$ReleaseDirectory = (Join-Path $PSScriptRoot '../build-verify/releases/pos-1.3.0'),
    [string]$CompilerPath,
    [string]$OutputDirectory = (Join-Path $PSScriptRoot '../build-verify/installer/1.3.0'),
    [ValidatePattern('^SCCRM-INSTALLER-TEST-[a-fA-F0-9]{32}$')][string]$TestAppId
)
$ErrorActionPreference = 'Stop'
$posRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$posRelease = (Resolve-Path -LiteralPath $ReleaseDirectory).Path
if (!$CompilerPath) {
    $posCandidates = @(
        (Join-Path $posRoot 'build-verify/installer-tools/inno-6.7.3/ISCC.exe'),
        'C:/Program Files (x86)/Inno Setup 6/ISCC.exe',
        'C:/Program Files/Inno Setup 6/ISCC.exe'
    )
    $CompilerPath = $posCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
}
if (!$CompilerPath -or !(Test-Path -LiteralPath $CompilerPath)) { throw 'Install Inno Setup 6.7.3 or pass -CompilerPath. https://jrsoftware.org/isdl.php' }
$posVerifier = Join-Path $posRoot 'build-verify/desktop-feature-check/DesktopFeatureCheck.exe'
if (!(Test-Path -LiteralPath $posVerifier)) { throw 'Build tools/DesktopFeatureCheck.csproj before building Setup.' }
& $posVerifier --verify-release (Join-Path $posRelease 'stable.json')
if ($LASTEXITCODE -ne 0) { throw 'Release signature or EXE verification failed.' }
$posEnvelope = Get-Content -LiteralPath (Join-Path $posRelease 'stable.json') -Raw | ConvertFrom-Json
$posMetadata = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($posEnvelope.payload)) | ConvertFrom-Json
if ($posMetadata.deviceAccessVersion -ne 1 -or [Version]$posMetadata.version -lt [Version]'1.3.0') { throw 'Setup requires a signed device-restricted release, version 1.3.0 or later.' }
if ($posMetadata.sourceDirty -or $posMetadata.version -notmatch '^\d+\.\d+\.\d+(\.\d+)?$') { throw 'Setup requires a reviewed numeric release version.' }
& (Join-Path $PSScriptRoot 'Generate-InstallerBranding.ps1')
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$posOutput = (Resolve-Path -LiteralPath $OutputDirectory).Path
# Compile in a fresh temporary folder, then copy the result. No security or
# antivirus settings are changed if a scanner briefly locks a new EXE.
$posBuild = Join-Path ([IO.Path]::GetTempPath()) ('SCCRMonPOS-installer-build-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $posBuild | Out-Null
$posCompilerArguments = @((Join-Path $posRoot 'installer/SCCRMonPOS.iss'),('/DReleaseDir=' + $posRelease),('/DReleaseVersion=' + $posMetadata.version),('/O' + $posBuild))
if ($TestAppId) { $posCompilerArguments += '/DTestAppId=' + $TestAppId }
& $CompilerPath @posCompilerArguments
if ($LASTEXITCODE -ne 0) { throw 'Installer compilation failed.' }
$posSetupName = if ($TestAppId) { 'SCCRMonPOS-Setup-TEST-' + $posMetadata.version + '.exe' } else { 'SCCRMonPOS-Setup-' + $posMetadata.version + '.exe' }
$posSetup = Join-Path $posOutput $posSetupName
Copy-Item -LiteralPath (Join-Path $posBuild $posSetupName) -Destination $posSetup -Force
Get-Item -LiteralPath $posSetup | Select-Object FullName,Length
