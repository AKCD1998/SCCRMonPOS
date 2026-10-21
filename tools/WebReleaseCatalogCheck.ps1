$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'WebReleaseCatalog.ps1')
function Assert-Pos([bool]$Condition, [string]$Message) { if (!$Condition) { throw $Message } }
function Assert-PosReject([scriptblock]$Action) { $rejected = $false; try { & $Action | Out-Null } catch { $rejected = $true }; Assert-Pos $rejected 'Unsafe catalog input was accepted.' }
$metadata = [pscustomobject]@{ tagName = 'pos-1.3.2'; publishedAt = '2026-10-21T13:00:00Z'; isDraft = $false; isPrerelease = $false }
$manifest = [pscustomobject]@{ schemaVersion = 1; version = '1.3.2'; releaseId = 'pos-1.3.2'; sourceDirty = $false; deviceAccessVersion = 1; downloadUrl = 'https://github.com/AKCD1998/SCCRMonPOS/releases/download/pos-1.3.2/SCCRMonPOS.exe'; notes = "# Version`n- First change`n- **Second** change`n- [Third](https://example.invalid) change" }
$installer = [pscustomobject]@{ downloadUrl = 'https://github.com/AKCD1998/SCCRMonPOS/releases/download/pos-1.3.2/SCCRMonPOS-Setup-1.3.2.exe'; sha256 = ('a' * 64); size = 2048 }
$entry = New-PosWebRelease $metadata $manifest $installer
$metadata.publishedAt = [DateTime]::Parse('2026-10-21T13:00:00Z', [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind)
Assert-Pos ((New-PosWebRelease $metadata $manifest $installer).publishedAt.StartsWith('2026-10-21T13:00:00')) 'PowerShell date conversion must preserve the UTC publication instant.'
Assert-Pos ($entry.highlights.Count -eq 3 -and $entry.highlights[0] -is [string]) 'Release summaries must be a flat string array.'
Assert-Pos ($entry.highlights[1] -eq 'Second change') 'Markdown should be rendered as plain text.'
$old = [pscustomobject]@{ releaseId = 'pos-1.3.1'; version = '1.3.1'; publishedAt = '2026-10-20T13:00:00Z'; deviceAccessVersion = 1; installer = $installer }
$catalog = New-PosWebCatalog @($old, $entry) $entry.releaseId
Assert-Pos ($catalog.releases[0].releaseId -eq $entry.releaseId) 'New release should be first.'
Assert-Pos ((New-PosWebCatalog @($old, $entry) $old.releaseId).recommendedReleaseId -eq $old.releaseId) 'Explicit rollback must be preserved.'
Assert-PosReject { New-PosWebCatalog @($entry, $entry) $entry.releaseId }
Assert-PosReject { New-PosWebCatalog @($entry) 'missing' }
Assert-PosReject { New-PosWebRelease $metadata $manifest $null }
$metadata.isDraft = $true; Assert-PosReject { New-PosWebRelease $metadata $manifest $installer }; $metadata.isDraft = $false
$metadata.isPrerelease = $true; Assert-PosReject { New-PosWebRelease $metadata $manifest $installer }; $metadata.isPrerelease = $false
$manifest.sourceDirty = $true; Assert-PosReject { New-PosWebRelease $metadata $manifest $installer }; $manifest.sourceDirty = $false
$manifest.deviceAccessVersion = 0
Assert-PosReject { New-PosWebRelease $metadata $manifest $installer }
$legacy = New-PosWebRelease $metadata $manifest $null
Assert-Pos ($null -eq $legacy.installer) 'Legacy installer must remain unavailable.'
Assert-PosReject { New-PosWebCatalog @($legacy) $legacy.releaseId }
$signer = [Security.Cryptography.RSACryptoServiceProvider]::new(2048)
$signer.PersistKeyInCsp = $false
try {
    $bytes = [Text.Encoding]::UTF8.GetBytes(($catalog | ConvertTo-Json -Depth 12 -Compress))
    $signed = @{ payload = [Convert]::ToBase64String($bytes); signature = [Convert]::ToBase64String($signer.SignData($bytes, [Security.Cryptography.CryptoConfig]::MapNameToOID('SHA256'))) } | ConvertTo-Json -Compress
    Assert-Pos ((Read-PosSignedDocument $signed $signer.ToXmlString($false)).recommendedReleaseId -eq $entry.releaseId) 'Signed catalog must verify.'
    Assert-Pos ((Read-PosSignedDocument ([Text.Encoding]::UTF8.GetBytes($signed)) $signer.ToXmlString($false)).recommendedReleaseId -eq $entry.releaseId) 'Binary GitHub responses must decode as UTF-8.'
    $tampered = $signed | ConvertFrom-Json; $tampered.payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('{}'))
    Assert-PosReject { Read-PosSignedDocument ($tampered | ConvertTo-Json -Compress) $signer.ToXmlString($false) }
} finally { $signer.Dispose() }
Write-Output 'Web release catalog checks passed: promotion, archive, rollback, signatures, legacy restrictions and summaries.'
