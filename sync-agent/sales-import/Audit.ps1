param()
$ErrorActionPreference='Stop';[Console]::InputEncoding=[Text.Encoding]::UTF8;[Console]::OutputEncoding=[Text.Encoding]::UTF8
$db=$null;$p=$null
try{
 $p=[Console]::In.ReadToEnd()|ConvertFrom-Json;if($p.scope -cne 'SCCRM-HQ-SALES-IMPORT-V1'){throw 'SALES_SCOPE_REFUSED'}
 $b=New-Object Data.SqlClient.SqlConnectionStringBuilder;$b['Data Source']=$p.target.server;$b['Initial Catalog']=$p.target.database;$b['User ID']=$p.target.user;$b['Password']=$p.target.password;$b['Connect Timeout']=5;$b['Application Name']='SCCRM-Sales-Preservation-ReadOnly'
 $db=New-Object Data.SqlClient.SqlConnection $b.ConnectionString;$db.Open();$b['Password']='';$p.target.password=''
 function Table([string]$sql){$q=$db.CreateCommand();$q.CommandTimeout=20;$q.CommandText='SET LOCK_TIMEOUT 750;SET DEADLOCK_PRIORITY LOW;'+$sql;$a=New-Object Data.SqlClient.SqlDataAdapter $q;$dt=New-Object Data.DataTable;try{$null=$a.Fill($dt);return ,$dt}finally{$a.Dispose();$q.Dispose()}}
 function Digest($row,$names){$values=@();foreach($n in $names){$v=$row[$n];$values+=if($v -is [DBNull]){$null}elseif($v -is [DateTime]){$v.ToString('o',[Globalization.CultureInfo]::InvariantCulture)}elseif($v -is [double] -or $v -is [single]){$v.ToString('R',[Globalization.CultureInfo]::InvariantCulture)}elseif($v -is [IFormattable]){$v.ToString($null,[Globalization.CultureInfo]::InvariantCulture)}else{[string]$v}};$sha=[Security.Cryptography.SHA256]::Create();try{[BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject @($values) -Depth 5 -Compress)))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}}
 $result=@{}
 foreach($table in @('TCNMCst','TCNTCstPoint','TPSTSalHD','TPSTSalDT','TPSTSalRC','TPSTSalPD','TPSTSalPG','TPSTSalPH','TPSTSalInvCsm','TPSTVoidDT')){
  $cols=Table ("SELECT name FROM sys.columns WHERE object_id=OBJECT_ID('dbo."+$table+"') AND name NOT LIKE '%pin%' AND name NOT LIKE '%password%' AND name NOT LIKE '%secret%' AND name NOT LIKE '%token%' ORDER BY column_id")
  $names=@($cols.Rows|ForEach-Object{if($_.name -cnotmatch '^[A-Za-z0-9_]+$'){throw 'SALES_COLUMN_REFUSED'};[string]$_.name})
  $where=if($table -in @('TCNMCst','TCNTCstPoint')){''}else{" WHERE FTShdDocNo LIKE '_2611%'"}
  $dt=Table ('SELECT '+(@($names|ForEach-Object{'['+$_+']'}) -join ',')+' FROM dbo.['+$table+']'+$where+' OPTION(MAXDOP 1)')
  $hashes=@{};foreach($row in $dt.Rows){$key=if($table -ceq 'TCNMCst'){[string]$row.FTCstCode}elseif($table -ceq 'TCNTCstPoint'){([string]$row.FTBchCode)+'|'+([string]$row.FTCstCode)+'|'+([string]$row.FTPntRefDoc)+'|'+([string]$row.FTSplCode)}else{[string]$row.FTShdDocNo};$h=Digest $row $names;if(!$hashes.ContainsKey($key)){$hashes[$key]=@()};$hashes[$key]+=$h}
  foreach($key in @($hashes.Keys)){$hashes[$key]=@($hashes[$key]|Sort-Object)}
  $result[$table]=@{rows=$dt.Rows.Count;columns=$names.Count;hashes=$hashes}
 }
 @{ok=$true;branch=$p.branch;at=[DateTime]::UtcNow.ToString('o');tables=$result;pinRead=$false;dataWrites=0}|ConvertTo-Json -Depth 12 -Compress
}catch{@{ok=$false;code='SALES_AUDIT_FAILED';type=$_.Exception.GetBaseException().GetType().Name}|ConvertTo-Json -Compress;exit 1}finally{if($db){$db.Dispose()};if($p){$p.target.password=''}}
