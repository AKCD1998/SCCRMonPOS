param([ValidateSet('Read','Write')][string]$Action='Read')
$ErrorActionPreference='Stop';$file=Join-Path $PSScriptRoot 'runtime\credentials.dpapi'
if($Action -ceq 'Write'){$plain=[Console]::In.ReadToEnd();$sec=ConvertTo-SecureString $plain -AsPlainText -Force;$enc=ConvertFrom-SecureString $sec;[IO.File]::WriteAllText($file,$enc);$plain=$null;[Console]::WriteLine('PROTECTED')}
else{$sec=Get-Content -LiteralPath $file -Raw|ConvertTo-SecureString;$cred=New-Object Management.Automation.PSCredential 'sccrm-live-provision',$sec;[Console]::WriteLine([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($cred.GetNetworkCredential().Password)))}
