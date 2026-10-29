param([ValidateSet('Init','Read')][string]$Action='Read')
$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security
$rsa=$null;$aes=$null;$hmac=$null;$keyBytes=$null;$plain=$null
try{
 if($env:COMPUTERNAME -cne 'SERVER'){throw 'HQ_MACHINE_REQUIRED'}
 $keyFile=Join-Path $PSScriptRoot 'runtime\bootstrap-key.dpapi'
 $rsa=New-Object Security.Cryptography.RSACryptoServiceProvider 4096;$rsa.PersistKeyInCsp=$false
 if(!(Test-Path -LiteralPath $keyFile)){
  $private=[Text.Encoding]::UTF8.GetBytes($rsa.ToXmlString($true))
  try{$protected=[Security.Cryptography.ProtectedData]::Protect($private,$null,[Security.Cryptography.DataProtectionScope]::LocalMachine);[IO.File]::WriteAllBytes($keyFile,$protected)}finally{[Array]::Clear($private,0,$private.Length)}
 }else{
  $private=[Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($keyFile),$null,[Security.Cryptography.DataProtectionScope]::LocalMachine)
  try{$rsa.FromXmlString([Text.Encoding]::UTF8.GetString($private))}finally{[Array]::Clear($private,0,$private.Length)}
 }
 if($Action -ceq 'Init'){
  $p=$rsa.ExportParameters($false)
  $public=@{kty='RSA';n=([Convert]::ToBase64String($p.Modulus).TrimEnd('=').Replace('+','-').Replace('/','_'));e=([Convert]::ToBase64String($p.Exponent).TrimEnd('=').Replace('+','-').Replace('/','_'))}
  [IO.File]::WriteAllText((Join-Path $PSScriptRoot 'status\bootstrap-public.json'),($public|ConvertTo-Json -Compress),(New-Object Text.UTF8Encoding $false))
  $identity=@{machine=$env:COMPUTERNAME;sessionId=[Diagnostics.Process]::GetCurrentProcess().SessionId;account=[Security.Principal.WindowsIdentity]::GetCurrent().Name;at=[DateTime]::UtcNow.ToString('o')}
  [IO.File]::WriteAllText((Join-Path $PSScriptRoot 'status\bootstrap-identity.json'),($identity|ConvertTo-Json -Compress),(New-Object Text.UTF8Encoding $false));[Console]::WriteLine('READY');exit
 }
 $packet=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'runtime\credentials.hybrid.json') -Raw -Encoding UTF8 | ConvertFrom-Json
 if($packet.version -ne 1){throw 'SECRET_PACKET_REFUSED'}
 $keyBytes=$rsa.Decrypt([Convert]::FromBase64String($packet.encryptedKey),$true)
 if($keyBytes.Length -ne 64){throw 'SECRET_PACKET_REFUSED'}
 $iv=[Convert]::FromBase64String($packet.iv);$cipher=[Convert]::FromBase64String($packet.ciphertext);$mac=[Convert]::FromBase64String($packet.mac)
 if($iv.Length -ne 16 -or $mac.Length -ne 32 -or $cipher.Length -gt 65536){throw 'SECRET_PACKET_REFUSED'}
 $prefix=[Text.Encoding]::UTF8.GetBytes("SCCRM-FANOUT-SECRETS-V1`0")
 $message=New-Object byte[] ($prefix.Length+$iv.Length+$cipher.Length)
 [Array]::Copy($prefix,0,$message,0,$prefix.Length);[Array]::Copy($iv,0,$message,$prefix.Length,$iv.Length);[Array]::Copy($cipher,0,$message,$prefix.Length+$iv.Length,$cipher.Length)
 $hmac=New-Object Security.Cryptography.HMACSHA256 (,$keyBytes[32..63]);$actual=$hmac.ComputeHash($message);$difference=0
 for($i=0;$i -lt 32;$i++){$difference=$difference -bor ($actual[$i] -bxor $mac[$i])}
 if($difference -ne 0){throw 'SECRET_MAC_REFUSED'}
 $aes=[Security.Cryptography.Aes]::Create();$aes.Mode='CBC';$aes.Padding='PKCS7';$aes.Key=$keyBytes[0..31];$aes.IV=$iv
 $decrypt=$aes.CreateDecryptor();try{$plain=$decrypt.TransformFinalBlock($cipher,0,$cipher.Length)}finally{$decrypt.Dispose()}
 [Console]::WriteLine([Convert]::ToBase64String($plain))
}catch{[Console]::Error.WriteLine('FANOUT_SECRET_BRIDGE_REFUSED');exit 1}
finally{if($plain){[Array]::Clear($plain,0,$plain.Length)};if($keyBytes){[Array]::Clear($keyBytes,0,$keyBytes.Length)};if($aes){$aes.Dispose()};if($hmac){$hmac.Dispose()};if($rsa){$rsa.Dispose()}}
