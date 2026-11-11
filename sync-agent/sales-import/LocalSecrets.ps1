param()
$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security
[Console]::InputEncoding=[Text.Encoding]::UTF8;[Console]::OutputEncoding=[Text.Encoding]::UTF8
$bytes=$null
try{$p=[Console]::In.ReadToEnd()|ConvertFrom-Json;$file=Join-Path $PSScriptRoot 'runtime\credentials.dpapi'
 if($null -ne $p.value){$bytes=[Text.Encoding]::UTF8.GetBytes(($p.value|ConvertTo-Json -Depth 20 -Compress));[IO.File]::WriteAllBytes($file,[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser));@{ok=$true}|ConvertTo-Json -Compress}
 else{$bytes=[Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($file),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::WriteLine('{"ok":true,"value":'+[Text.Encoding]::UTF8.GetString($bytes)+'}')}
}catch{[Console]::WriteLine('{"ok":false,"code":"SALES_LOCAL_SECRET_REFUSED"}');exit 1}finally{if($bytes){[Array]::Clear($bytes,0,$bytes.Length)}}
