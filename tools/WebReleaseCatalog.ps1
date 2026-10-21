# Shared, side-effect-free catalog helpers. Private keys are used only by the
# explicit publishing entry point, never by the website or these helpers.
function Read-PosSignedDocument($Json, [string]$PublicKey) {
    if ($Json -is [byte[]]) { $Json = [Text.Encoding]::UTF8.GetString($Json) }
    $envelope = [string]$Json | ConvertFrom-Json
    $payload = [Convert]::FromBase64String($envelope.payload)
    $verifier = [Security.Cryptography.RSACryptoServiceProvider]::new()
    $verifier.PersistKeyInCsp = $false
    try {
        $verifier.FromXmlString($PublicKey)
        if (!$verifier.VerifyData($payload, [Security.Cryptography.CryptoConfig]::MapNameToOID('SHA256'), [Convert]::FromBase64String($envelope.signature))) { throw 'Invalid catalog/release signature.' }
        return ([Text.Encoding]::UTF8.GetString($payload) | ConvertFrom-Json)
    } finally { $verifier.Dispose() }
}

function Get-PosWebHighlights([string]$Notes) {
    $lines = @($Notes -split '\r?\n' | Where-Object { $_ -match '^\s*[-*]\s+\S' } | ForEach-Object {
        $text = $_ -replace '^\s*[-*]\s+', '' -replace '\[([^\]]+)\]\([^)]+\)', '$1' -replace '[*`]', ''
        $text.Trim().Substring(0, [Math]::Min(240, $text.Trim().Length))
    } | Select-Object -First 3)
    if (!$lines.Count) {
        $lines = @($Notes -split '\r?\n' | Where-Object { $_.Trim() -and $_ -notmatch '^\s*#' } | Select-Object -First 3 | ForEach-Object { $_.Trim().Substring(0, [Math]::Min(240, $_.Trim().Length)) })
    }
    if (!$lines.Count) { $lines = @('ปรับปรุงโปรแกรม SCCRM') }
    return $lines
}

function Get-PosIsoDate($Value) {
    if ($Value -is [DateTime]) { return $Value.ToUniversalTime().ToString('o', [Globalization.CultureInfo]::InvariantCulture) }
    return [DateTimeOffset]::Parse([string]$Value, [Globalization.CultureInfo]::InvariantCulture).ToUniversalTime().ToString('o')
}

function New-PosWebRelease($Metadata, $Manifest, $Installer) {
    if ($Metadata.isDraft -or $Metadata.isPrerelease -or !$Metadata.publishedAt -or
        $Manifest.sourceDirty -or $Manifest.schemaVersion -ne 1 -or
        $Manifest.version -notmatch '^\d+\.\d+\.\d+(\.\d+)?$' -or
        $Metadata.tagName -ne "pos-$($Manifest.version)" -or $Manifest.releaseId -ne $Metadata.tagName -or
        $Manifest.downloadUrl -ne "https://github.com/AKCD1998/SCCRMonPOS/releases/download/$($Metadata.tagName)/SCCRMonPOS.exe") { throw 'Release is not a reviewed published POS release.' }
    $restricted = $Manifest.deviceAccessVersion -eq 1
    if ($restricted -and !$Installer) { throw 'A restricted release must have its verified Windows installer before announcement.' }
    if (!$restricted -and $Installer) { throw 'Unrestricted releases are historical notes only.' }
    return [pscustomobject]@{
        releaseId = $Manifest.releaseId; version = $Manifest.version; publishedAt = (Get-PosIsoDate $Metadata.publishedAt)
        highlights = @(Get-PosWebHighlights $Manifest.notes)
        deviceAccessVersion = $(if ($restricted) { 1 } else { 0 })
        installer = $Installer
        downloadNote = $(if (!$restricted) { 'รุ่นนี้ยังไม่มีระบบตรวจสิทธิ์เครื่องบริษัท จึงไม่เปิดดาวน์โหลดจากหน้านี้' } else { $null })
    }
}

function New-PosWebCatalog([object[]]$Releases, [string]$RecommendedReleaseId) {
    $selected = @($Releases | Where-Object { $_.releaseId -eq $RecommendedReleaseId })
    if ($selected.Count -ne 1 -or $selected[0].deviceAccessVersion -ne 1 -or !$selected[0].installer.downloadUrl) { throw 'Recommended release must have a device-restricted installer.' }
    if (@($Releases.releaseId | Select-Object -Unique).Count -ne $Releases.Count) { throw 'Duplicate release IDs in catalog.' }
    foreach ($release in $Releases) { $release.publishedAt = Get-PosIsoDate $release.publishedAt }
    $sorted = @($Releases | Sort-Object { [DateTimeOffset]::Parse($_.publishedAt, [Globalization.CultureInfo]::InvariantCulture) } -Descending)
    $recent = @($sorted | Select-Object -First 100)
    if ($RecommendedReleaseId -notin $recent.releaseId) { $recent = @($recent | Select-Object -First 99) + $selected }
    return [ordered]@{
        schemaVersion = 1; generatedAt = [DateTime]::UtcNow.ToString('o')
        recommendedReleaseId = $RecommendedReleaseId
        releases = $recent
    }
}
