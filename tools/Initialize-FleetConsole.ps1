[CmdletBinding()]
param([string]$ConsoleExe=(Join-Path $PSScriptRoot '../build-verify/fleet-console/SCCRM-Fleet-Control.exe'))
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
if($env:COMPUTERNAME -ine 'SCPRODUCTDEV'){throw 'This console is authorized on SCProductDev only.'}
$root=Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'SCCRMonPOS-Admin'
$keyFile=Join-Path $root 'fleet-admin-token.dpapi'
$registration=Join-Path $root 'fleet-admin-registration.json'
New-Item -ItemType Directory -Path $root -Force|Out-Null
$bytes=$null;$random=$null
try{
 if(!(Test-Path -LiteralPath $keyFile)){
  $random=New-Object byte[] 32;$rng=[Security.Cryptography.RandomNumberGenerator]::Create()
  try{$rng.GetBytes($random)}finally{$rng.Dispose()}
  $bytes=[Text.Encoding]::UTF8.GetBytes([Convert]::ToBase64String($random).TrimEnd('=').Replace('+','-').Replace('/','_'))
  [IO.File]::WriteAllBytes($keyFile,[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))
 }else{$bytes=[Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($keyFile),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)}
 $sha=[Security.Cryptography.SHA256]::Create();try{$hash=([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}
 if(Test-Path -LiteralPath $registration){$meta=Get-Content -LiteralPath $registration -Raw|ConvertFrom-Json;if($meta.token_hash -cne $hash){throw 'Existing admin registration does not match its protected key.'}}
 else{$meta=[ordered]@{id=[guid]::NewGuid().ToString('D');station='SCPRODUCTDEV';token_hash=$hash};[IO.File]::WriteAllText($registration,($meta|ConvertTo-Json -Compress),(New-Object Text.UTF8Encoding $false))}
 $source=(Resolve-Path -LiteralPath $ConsoleExe).Path
 $destination=Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Programs\SCCRM-Fleet-Control'
 New-Item -ItemType Directory -Path $destination -Force|Out-Null
 $target=Join-Path $destination 'SCCRM-Fleet-Control.exe';Copy-Item -LiteralPath $source -Destination $target -Force
 $shell=New-Object -ComObject WScript.Shell
 $shortcut=$shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'SCCRM - Update branches.lnk'))
 $shortcut.TargetPath=$target;$shortcut.WorkingDirectory=$destination;$shortcut.Description='SCCRM branch update console';$shortcut.Save()
 [pscustomobject]@{ok=$true;console=$target;registrationFile=$registration;protectedCredential=$true;rawCredentialPrinted=$false}|ConvertTo-Json -Compress
}finally{if($bytes){[Array]::Clear($bytes,0,$bytes.Length)};if($random){[Array]::Clear($random,0,$random.Length)}}
