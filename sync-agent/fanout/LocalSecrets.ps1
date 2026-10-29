param([ValidateSet('Read','Write')][string]$Action='Read')
$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security
$file=Join-Path $PSScriptRoot 'runtime\credentials.dpapi';$bytes=$null
try{
 if($Action -ceq 'Write'){$bytes=[Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd());$protected=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[IO.File]::WriteAllBytes($file,$protected);[Console]::WriteLine('PROTECTED')}
 else{$bytes=[Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($file),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::WriteLine([Convert]::ToBase64String($bytes))}
}catch{[Console]::Error.WriteLine('FANOUT_LOCAL_SECRET_REFUSED');exit 1}
finally{if($bytes){[Array]::Clear($bytes,0,$bytes.Length)}}
