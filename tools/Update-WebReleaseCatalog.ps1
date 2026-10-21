[CmdletBinding()]
param(
    [switch]$Bootstrap,
    [string]$ReleaseId,
    [string]$ManifestPath,
    [string]$InstallerPath,
    [string]$RecommendReleaseId,
    [string]$KeyPath = (Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'SCCRMonPOS-Admin/update-signing-key.dpapi')
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'WebReleaseCatalog.ps1')
$catalogRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$catalogPublicKey = [IO.File]::ReadAllText((Join-Path $catalogRoot 'SCCRMonPOS/Assets/UpdatePublicKey.xml'))
$catalogPath = Join-Path $catalogRoot 'releases/web-catalog.json'
$catalogEntries = @()
if (!$Bootstrap -and (Test-Path -LiteralPath $catalogPath)) {
    $existing = Read-PosSignedDocument ([IO.File]::ReadAllText($catalogPath)) $catalogPublicKey
    if ($existing.schemaVersion -ne 1) { throw 'Unsupported existing catalog.' }
    $catalogEntries = @($existing.releases)
    if (!$ReleaseId -and $RecommendReleaseId -eq $existing.recommendedReleaseId) {
        Write-Output "Website catalog already recommends $RecommendReleaseId."
        return
    }
}
if ($Bootstrap -and $ReleaseId) { throw 'Bootstrap and single-release publication cannot be combined.' }
if (!$Bootstrap -and !$ReleaseId -and !$RecommendReleaseId) { throw 'Specify a release to publish or recommend.' }
if ($Bootstrap) {
    $catalogReleaseIds = & gh release list --repo AKCD1998/SCCRMonPOS --limit 100 --json tagName,isDraft,isPrerelease
    if ($LASTEXITCODE -ne 0) { throw 'Cannot read published releases.' }
    $catalogReleaseIds = @($catalogReleaseIds | ConvertFrom-Json | Where-Object { !$_.isDraft -and !$_.isPrerelease -and $_.tagName -match '^pos-\d+\.\d+\.\d+(\.\d+)?$' } | ForEach-Object { $_.tagName })
} elseif ($ReleaseId) { $catalogReleaseIds = @($ReleaseId) } else { $catalogReleaseIds = @() }
foreach ($catalogReleaseId in $catalogReleaseIds) {
    if ($catalogReleaseId -notmatch '^pos-\d+\.\d+\.\d+(\.\d+)?$') { throw 'Invalid release identifier.' }
    $metadataJson = & gh release view $catalogReleaseId --repo AKCD1998/SCCRMonPOS --json tagName,isDraft,isPrerelease,publishedAt,assets
    if ($LASTEXITCODE -ne 0) { throw 'Cannot read the published release.' }
    $metadata = $metadataJson | ConvertFrom-Json
    if ($Bootstrap) {
        $manifestJson = (Invoke-WebRequest -Uri "https://github.com/AKCD1998/SCCRMonPOS/releases/download/$catalogReleaseId/stable.json" -UseBasicParsing).Content
    } else { $manifestJson = [IO.File]::ReadAllText((Resolve-Path -LiteralPath $ManifestPath).Path) }
    $manifest = Read-PosSignedDocument $manifestJson $catalogPublicKey
    $installer = $null
    if ($manifest.deviceAccessVersion -eq 1) {
        $setupName = "SCCRMonPOS-Setup-$($manifest.version).exe"
        $setupUrl = "https://github.com/AKCD1998/SCCRMonPOS/releases/download/$catalogReleaseId/$setupName"
        $asset = @($metadata.assets | Where-Object { $_.name -eq $setupName -and $_.url -eq $setupUrl })
        if ($asset.Count -ne 1 -or $asset[0].digest -notmatch '^sha256:[a-f0-9]{64}$') { throw 'Missing or unverified installer asset.' }
        if ($Bootstrap) {
            $setupFile = Join-Path $catalogRoot "build-verify/web-catalog/$setupName"
            New-Item -ItemType Directory -Force -Path (Split-Path $setupFile) | Out-Null
            Invoke-WebRequest -Uri $setupUrl -OutFile $setupFile -UseBasicParsing
        } else { $setupFile = (Resolve-Path -LiteralPath $InstallerPath).Path }
        $hash = (Get-FileHash -LiteralPath $setupFile -Algorithm SHA256).Hash.ToLowerInvariant()
        $size = (Get-Item -LiteralPath $setupFile).Length
        if ("sha256:$hash" -ne $asset[0].digest -or $size -ne $asset[0].size) { throw 'Published installer differs from the verified artifact.' }
        $installer = [pscustomobject]@{ downloadUrl = $setupUrl; sha256 = $hash; size = $size }
    }
    $entry = New-PosWebRelease $metadata $manifest $installer
    $catalogEntries = @($catalogEntries | Where-Object { $_.releaseId -ne $entry.releaseId }) + @($entry)
}
if (!$RecommendReleaseId) {
    $recommended = Read-PosSignedDocument ([IO.File]::ReadAllText((Join-Path $catalogRoot 'releases/stable.json'))) $catalogPublicKey
    $RecommendReleaseId = $recommended.releaseId
}
$catalogPayload = New-PosWebCatalog $catalogEntries $RecommendReleaseId
$catalogPayloadBytes = [Text.Encoding]::UTF8.GetBytes(($catalogPayload | ConvertTo-Json -Depth 12 -Compress))
$catalogPrivate = [Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($KeyPath), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
$catalogSigner = [Security.Cryptography.RSACryptoServiceProvider]::new()
$catalogSigner.PersistKeyInCsp = $false
try {
    $catalogSigner.FromXmlString([Text.Encoding]::UTF8.GetString($catalogPrivate))
    if ($catalogSigner.ToXmlString($false) -ne $catalogPublicKey) { throw 'Signing key does not match the existing POS public key.' }
    $catalogSignature = $catalogSigner.SignData($catalogPayloadBytes, [Security.Cryptography.CryptoConfig]::MapNameToOID('SHA256'))
    $catalogEnvelope = @{ payload = [Convert]::ToBase64String($catalogPayloadBytes); signature = [Convert]::ToBase64String($catalogSignature) } | ConvertTo-Json -Compress
    $null = Read-PosSignedDocument $catalogEnvelope $catalogPublicKey
    [IO.File]::WriteAllText($catalogPath, $catalogEnvelope, [Text.UTF8Encoding]::new($false))
} finally { [Array]::Clear($catalogPrivate, 0, $catalogPrivate.Length); $catalogSigner.Dispose() }
Write-Output "Prepared signed website catalog: $($catalogEntries.Count) releases; recommended $RecommendReleaseId. Commit with the matching stable.json announcement."
