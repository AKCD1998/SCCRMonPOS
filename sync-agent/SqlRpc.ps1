param([Parameter(Mandatory=$true)][string]$ConfigFile,[switch]$Setup)
$ErrorActionPreference='Stop';[Console]::InputEncoding=[Text.Encoding]::UTF8;[Console]::OutputEncoding=[Text.Encoding]::UTF8;$db=$null;$password=$null;$stage='config'
try{
 $c=Get-Content -LiteralPath $ConfigFile -Raw -Encoding UTF8 | ConvertFrom-Json
 if($c.scope -cne 'SCCRM-HQ-SANDBOX-ONLY' -or $c.sql.database -cne 'SCCRM_UiSandbox_20261024_142127' -or $c.sql.marker -cne '6d42574b-3e90-4d92-aa5d-4c4920a08cbe' -or $c.sql.user -cne 'sccrm_ui_20261024_142127' -or $c.sql.server -notin @('tcp:100.90.166.72,49800','tcp:127.0.0.1,49800')){throw 'SANDBOX_TARGET_REQUIRED'}
 $stage='secret';if($c.sql.machineSecret){Add-Type -AssemblyName System.Security;$raw=[Convert]::FromBase64String([IO.File]::ReadAllText($c.sql.machineSecret));$password=[Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($raw,$null,[Security.Cryptography.DataProtectionScope]::LocalMachine));$raw=$null}
 elseif($c.sql.secretFile){$sec=Get-Content -LiteralPath $c.sql.secretFile -Raw | ConvertTo-SecureString;$cred=New-Object Management.Automation.PSCredential $c.sql.user,$sec;$password=$cred.GetNetworkCredential().Password}
 else{
  if($c.sql.secretIni -cne 'D:\SCCRM-NativeUiLab-20261024-142127\AdaTools\AdaIni.ada'){throw 'TEST_INI_REQUIRED'}
  $ini=New-Object Data.OleDb.OleDbConnection ('Provider=Microsoft.Jet.OLEDB.4.0;Data Source='+$c.sql.secretIni+';Mode=Read;');$ini.Open();$cmd=$ini.CreateCommand();$cmd.CommandText="SELECT FTCfgCode,FTCfgOn FROM TConfig WHERE FTCfgCode IN ('SqlDB','SqlUsrC','SqlUsrP')";$r=$cmd.ExecuteReader();$v=@{};try{while($r.Read()){$v[$r.GetString(0)]=[string]$r.GetValue(1)}}finally{$r.Dispose();$ini.Dispose()};if($v.SqlDB -cne $c.sql.database -or $v.SqlUsrC -cne $c.sql.user){throw 'TEST_INI_MISMATCH'};$password=$v.SqlUsrP;$v.Clear()
 }
 $stage='connect';$b=New-Object Data.SqlClient.SqlConnectionStringBuilder;$b['Data Source']=$c.sql.server;$b['Initial Catalog']=$c.sql.database;$b['User ID']=$c.sql.user;$b['Password']=$password;$b['Connect Timeout']=5;$b['Application Name']='SCCRM-HQ-Sandbox-Worker';$db=New-Object Data.SqlClient.SqlConnection $b.ConnectionString;$db.Open();$password=$null;$b.Password=''
 while($null -ne ($line=[Console]::ReadLine())){
  $req=$line|ConvertFrom-Json;if($req.action -ceq 'close'){break};$q=$null;$r=$null
  try{
   $sql=[string]$req.sql
   if($sql -match '(?i)\b(AdaAcc|USE|DELETE|DROP|TRUNCATE|OPENROWSET|OPENDATASOURCE|BACKUP|RESTORE|SHUTDOWN)\b|\bxp_|\bsp_configure' -or (-not $Setup -and $sql.TrimStart() -notmatch '^(SELECT|INSERT|UPDATE|EXEC)\b')){throw 'UNSAFE_COMMAND'}
   $q=$db.CreateCommand();$q.CommandTimeout=5;$guard="IF DB_NAME()<>'SCCRM_UiSandbox_20261024_142127' OR IS_SRVROLEMEMBER('sysadmin')<>0 OR NOT EXISTS(SELECT 1 FROM sys.extended_properties WHERE name='SCCRM_SandboxMarker' AND CONVERT(nvarchar(36),value)='6d42574b-3e90-4d92-aa5d-4c4920a08cbe') BEGIN RAISERROR('WRONG_COPY',16,1);RETURN;END;"
   if($Setup -and $sql -match '(?i)^\s*(CREATE|ALTER) PROCEDURE dbo\.SCCRM_'){$q.CommandText=$guard+'EXEC sys.sp_executesql @ddl';$null=$q.Parameters.AddWithValue('@ddl',$sql)}else{$q.CommandText=$guard+$sql}
   foreach($p in $req.parameters.PSObject.Properties){$value=$p.Value;if($null -eq $value){$value=[DBNull]::Value};$null=$q.Parameters.AddWithValue('@'+$p.Name,$value)}
   $r=$q.ExecuteReader();$rows=New-Object Collections.Generic.List[object];do{while($r.Read()){$row=[ordered]@{};for($i=0;$i -lt $r.FieldCount;$i++){$row[$r.GetName($i)]=if($r.IsDBNull($i)){$null}else{$r.GetValue($i)}};$rows.Add([pscustomobject]$row)}}while($r.NextResult());[Console]::WriteLine(([ordered]@{id=$req.id;ok=$true;rows=$rows.ToArray()}|ConvertTo-Json -Depth 8 -Compress))
  }catch{$code='SQL_OPERATION_FAILED';if($_.Exception.GetBaseException().Message -match '([A-Z][A-Z_]{5,})'){$code=$Matches[1]};[Console]::WriteLine(([ordered]@{id=$req.id;ok=$false;code=$code}|ConvertTo-Json -Compress))}finally{if($r){$r.Dispose()};if($q){$q.Dispose()}}
 }
}catch{[Console]::WriteLine(([ordered]@{ok=$false;code='SANDBOX_SQL_SETUP_FAILED';stage=$stage;errorType=$_.Exception.GetBaseException().GetType().Name;hresult=$_.Exception.GetBaseException().HResult}|ConvertTo-Json -Compress));exit 1}finally{if($db){$db.Dispose()};$password=$null;$cred=$null;$sec=$null}
