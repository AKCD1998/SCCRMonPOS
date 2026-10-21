param(
    [string]$KeyPath = (Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'SCCRMonPOS-Admin/update-signing-key.dpapi')
)
$ErrorActionPreference = 'Stop'
$posPublicPath = Join-Path $PSScriptRoot '../SCCRMonPOS/Assets/UpdatePublicKey.xml'
if ((Test-Path -LiteralPath $KeyPath) -or (Test-Path -LiteralPath $posPublicPath)) {
    throw 'Signing key already exists. Preserve the original key; do not silently rotate it.'
}
$posRsa = [System.Security.Cryptography.RSACryptoServiceProvider]::new(3072)
$posRsa.PersistKeyInCsp = $false
try {
    $posPrivateBytes = [Text.Encoding]::UTF8.GetBytes($posRsa.ToXmlString($true))
    $posProtected = [Security.Cryptography.ProtectedData]::Protect($posPrivateBytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    New-Item -ItemType Directory -Path (Split-Path -Parent $KeyPath) -Force | Out-Null
    [IO.File]::WriteAllBytes($KeyPath, $posProtected)
    [IO.File]::WriteAllText($posPublicPath, $posRsa.ToXmlString($false), [Text.UTF8Encoding]::new($false))
    Write-Output "Signing key protected for the current Windows user: $KeyPath"
    Write-Output 'Only the public key belongs in the repository. Keep a secure administrative backup of the signing key and its Windows profile.'
}
finally {
    if ($posPrivateBytes) { [Array]::Clear($posPrivateBytes, 0, $posPrivateBytes.Length) }
    $posRsa.Dispose()
}
