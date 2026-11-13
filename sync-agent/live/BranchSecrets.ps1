# Private in-process reader for the already provisioned read-only sales sources.
# No output, key creation, credential transfer or file modification occurs here.
function Unseal-HistorySources($packet,$rsa){
 $key=$null;$plain=$null;$akey=$null;$mkey=$null;$cfg=$null;$aes=$null;$hmac=$null;$decryptor=$null
 try{
  $key=$rsa.Decrypt([Convert]::FromBase64String([string]$packet.encryptedKey),$true)
  $iv=[Convert]::FromBase64String([string]$packet.iv);$cipher=[Convert]::FromBase64String([string]$packet.ciphertext);$mac=[Convert]::FromBase64String([string]$packet.mac)
  if($key.Length -ne 64 -or $iv.Length -ne 16 -or $mac.Length -ne 32 -or !$cipher.Length -or $cipher.Length -gt 65536){throw 'BRANCH_SECRETS_PACKET_REFUSED'}
  $akey=New-Object byte[] 32;$mkey=New-Object byte[] 32;[Array]::Copy($key,0,$akey,0,32);[Array]::Copy($key,32,$mkey,0,32)
  $prefix=[Text.Encoding]::UTF8.GetBytes("SCCRM-SALES-SECRETS-V1`0");$inputBytes=New-Object byte[] ($prefix.Length+$iv.Length+$cipher.Length)
  [Array]::Copy($prefix,0,$inputBytes,0,$prefix.Length);[Array]::Copy($iv,0,$inputBytes,$prefix.Length,$iv.Length);[Array]::Copy($cipher,0,$inputBytes,$prefix.Length+$iv.Length,$cipher.Length)
  $hmac=[Security.Cryptography.HMACSHA256]::new($mkey);$computed=$hmac.ComputeHash($inputBytes);$diff=0;for($i=0;$i -lt 32;$i++){$diff=$diff -bor ($computed[$i] -bxor $mac[$i])}
  if($diff -ne 0){throw 'BRANCH_SECRETS_MAC_REFUSED'}
  $aes=[Security.Cryptography.Aes]::Create();$aes.Key=$akey;$aes.IV=$iv;$decryptor=$aes.CreateDecryptor();$plain=$decryptor.TransformFinalBlock($cipher,0,$cipher.Length)
  $cfg=[Text.Encoding]::UTF8.GetString($plain)|ConvertFrom-Json
  if($cfg.scope -cne 'SCCRM-HQ-SALES-IMPORT-V1' -or @($cfg.sources.PSObject.Properties).Count -ne 4){throw 'BRANCH_SECRETS_SCOPE_REFUSED'}
  $targets=@{'001'=@('100.81.137.41\SQLEXPRESS','SC_001');'003'=@('100.77.101.94\SQLEXPRESS','POSSRV');'004'=@('100.113.59.42\SQLEXPRESS','SERVER004');'005'=@('100.106.107.80\SQLEXPRESS','POSSRV')}
  $sources=@{}
  foreach($branch in @('001','003','004','005')){
   $s=$cfg.sources.$branch;$expected=$targets[$branch]
   if($s.server -cne $expected[0] -or $s.machine -cne $expected[1] -or $s.database -cne 'AdaAcc' -or $s.user -cne ('sccrm_sales_export_'+$branch) -or !([string]$s.password)){throw 'BRANCH_SECRETS_TARGET_REFUSED'}
   $sources[$branch]=[pscustomobject]@{server=$s.server;machine=$s.machine;database='AdaAcc';user=$s.user;password=$s.password}
  }
  return $sources
 }finally{
  if($cfg){if($cfg.hq){$cfg.hq.password=''};foreach($s in @($cfg.sources.PSObject.Properties)){$s.Value.password=''}}
  if($decryptor){$decryptor.Dispose()};if($aes){$aes.Dispose()};if($hmac){$hmac.Dispose()}
  foreach($bytes in @($key,$plain,$akey,$mkey)){if($bytes){[Array]::Clear($bytes,0,$bytes.Length)}}
 }
}
function Read-HistorySources {
 Add-Type -AssemblyName System.Security
 if($env:COMPUTERNAME -cne 'SERVER' -or [Security.Principal.WindowsIdentity]::GetCurrent().User.Value -cne 'S-1-5-19' -or [Diagnostics.Process]::GetCurrentProcess().SessionId -ne 0){throw 'BRANCH_SECRETS_HOST_REFUSED'}
 $root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\sales-import'))
 if($root -ine 'D:\SCCRM-HQ-LiveSync-20261024\sales-import'){throw 'BRANCH_SECRETS_PATH_REFUSED'}
 $owner=Get-Content -LiteralPath (Join-Path $root '.sales-import-owner.json') -Raw|ConvertFrom-Json
 if($owner.marker -cne 'b740db43-5811-44cb-b072-0480a0b26f19' -or $owner.service -cne 'SCCRMHQSalesImport'){throw 'BRANCH_SECRETS_OWNER_REFUSED'}
 $keyFile=Join-Path $root 'runtime\bootstrap-key.dpapi';$packetFile=Join-Path $root 'runtime\credentials.hybrid.json'
 if((Get-Item -LiteralPath $keyFile).Length -gt 32768 -or (Get-Item -LiteralPath $packetFile).Length -gt 131072){throw 'BRANCH_SECRETS_SIZE_REFUSED'}
 $rsa=$null;$raw=$null
 try{
  $rsa=New-Object Security.Cryptography.RSACryptoServiceProvider 4096;$rsa.PersistKeyInCsp=$false
  $raw=[Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($keyFile),$null,[Security.Cryptography.DataProtectionScope]::LocalMachine)
  $rsa.FromXmlString([Text.Encoding]::UTF8.GetString($raw));$packet=Get-Content -LiteralPath $packetFile -Raw|ConvertFrom-Json
  return Unseal-HistorySources $packet $rsa
 }finally{if($raw){[Array]::Clear($raw,0,$raw.Length)};if($rsa){$rsa.Dispose()}}
}
