$ErrorActionPreference='Stop';. (Join-Path $PSScriptRoot 'BranchSecrets.ps1')
$rsa=New-Object Security.Cryptography.RSACryptoServiceProvider 2048;$rsa.PersistKeyInCsp=$false
function Seal-Fixture($cfg){
 $rng=[Security.Cryptography.RandomNumberGenerator]::Create();$key=New-Object byte[] 64;$iv=New-Object byte[] 16;$rng.GetBytes($key);$rng.GetBytes($iv);$rng.Dispose()
 $aes=[Security.Cryptography.Aes]::Create();$aes.Key=$key[0..31];$aes.IV=$iv;$enc=$aes.CreateEncryptor();$plain=[Text.Encoding]::UTF8.GetBytes(($cfg|ConvertTo-Json -Depth 8 -Compress));$cipher=$enc.TransformFinalBlock($plain,0,$plain.Length)
 $prefix=[Text.Encoding]::UTF8.GetBytes("SCCRM-SALES-SECRETS-V1`0");$inputBytes=New-Object byte[] ($prefix.Length+16+$cipher.Length);[Array]::Copy($prefix,0,$inputBytes,0,$prefix.Length);[Array]::Copy($iv,0,$inputBytes,$prefix.Length,16);[Array]::Copy($cipher,0,$inputBytes,$prefix.Length+16,$cipher.Length)
 $mac=[Security.Cryptography.HMACSHA256]::new([byte[]]$key[32..63]);$packet=@{encryptedKey=[Convert]::ToBase64String($rsa.Encrypt($key,$true));iv=[Convert]::ToBase64String($iv);ciphertext=[Convert]::ToBase64String($cipher);mac=[Convert]::ToBase64String($mac.ComputeHash($inputBytes))}
 $mac.Dispose();$enc.Dispose();$aes.Dispose();[Array]::Clear($key,0,$key.Length);[Array]::Clear($plain,0,$plain.Length);return $packet
}
try{
 $cfg=@{scope='SCCRM-HQ-SALES-IMPORT-V1';hq=@{password='synthetic-HQ-writer-must-not-leave'};sources=@{}}
 $targets=@{'001'=@('100.81.137.41\SQLEXPRESS','SC_001');'003'=@('100.77.101.94\SQLEXPRESS','POSSRV');'004'=@('100.113.59.42\SQLEXPRESS','SERVER004');'005'=@('100.106.107.80\SQLEXPRESS','POSSRV')}
 foreach($branch in $targets.Keys){$cfg.sources[$branch]=@{server=$targets[$branch][0];machine=$targets[$branch][1];database='AdaAcc';user=('sccrm_sales_export_'+$branch);password=('synthetic-read-only-'+$branch)}}
 $packet=Seal-Fixture $cfg;$sources=Unseal-HistorySources $packet $rsa
 if($sources.Count -ne 4 -or $sources.ContainsKey('hq') -or $sources['005'].password -cne 'synthetic-read-only-005'){throw 'FIXTURE_SOURCE_FILTER_FAILED'}
 $bad=@{};foreach($key in $packet.Keys){$bad[$key]=$packet[$key]};$bytes=[Convert]::FromBase64String($bad.mac);$bytes[0]=$bytes[0] -bxor 1;$bad.mac=[Convert]::ToBase64String($bytes)
 $refused=$false;try{$null=Unseal-HistorySources $bad $rsa}catch{if($_.Exception.Message -ceq 'BRANCH_SECRETS_MAC_REFUSED'){$refused=$true}else{throw}}
 if(!$refused){throw 'FIXTURE_MAC_TAMPER_ACCEPTED'}
 $cfg.sources['005'].server='127.0.0.1';$refused=$false
 try{$null=Unseal-HistorySources (Seal-Fixture $cfg) $rsa}catch{if($_.Exception.Message -ceq 'BRANCH_SECRETS_TARGET_REFUSED'){$refused=$true}else{throw}}
 if(!$refused){throw 'FIXTURE_UNPINNED_TARGET_ACCEPTED'}
 @{ok=$true;checks=3;liveSecretsRead=$false;productionWrites=0}|ConvertTo-Json -Compress
}finally{$rsa.Dispose()}
