param()
$ErrorActionPreference='Stop';[Console]::InputEncoding=[Text.Encoding]::UTF8;[Console]::OutputEncoding=[Text.Encoding]::UTF8
$p=$null;$db=$null;$stage='input'
try{
 $p=[Console]::In.ReadToEnd()|ConvertFrom-Json
 if($p.scope -cne 'SCCRM-HQ-SALES-IMPORT-V1'){throw 'SALES_SCOPE_REFUSED'}
 $b=New-Object Data.SqlClient.SqlConnectionStringBuilder;$b['Data Source']=$p.target.server;$b['Initial Catalog']=$p.target.database;$b['User ID']=$p.target.user;$b['Password']=$p.target.password;$b['Pooling']=$false;$b['Connect Timeout']=5;$b['Application Name']='SCCRM-Sales-Control'
 $db=New-Object Data.SqlClient.SqlConnection $b.ConnectionString;$stage='connect';$db.Open();$b['Password']='';$p.target.password=''
 $q=$db.CreateCommand();$q.CommandTimeout=5;$q.CommandText="SET LOCK_TIMEOUT 750;SET DEADLOCK_PRIORITY LOW;SET ANSI_NULLS ON;SET ANSI_PADDING ON;SET ANSI_WARNINGS ON;SET ARITHABORT ON;SET CONCAT_NULL_YIELDS_NULL ON;SET QUOTED_IDENTIFIER ON;SET NUMERIC_ROUNDABORT OFF;SELECT CONVERT(varchar(128),SERVERPROPERTY('MachineName')),DB_NAME()";$r=$q.ExecuteReader();if(!$r.Read() -or $r.GetString(0) -cne $p.target.machine -or $r.GetString(1) -cne $p.target.database){throw 'SALES_TARGET_REFUSED'};$r.Dispose();$q.Dispose()
 $stage='execute';$sets=@();foreach($statement in @($p.statements)){$q=$db.CreateCommand();$q.CommandTimeout=30;$q.CommandText=[string]$statement;$r=$null;try{$r=$q.ExecuteReader();do{$rows=@();while($r.Read()){$row=[ordered]@{};for($i=0;$i -lt $r.FieldCount;$i++){$v=$r.GetValue($i);if($v -is [DBNull]){$v=$null}elseif($v -is [DateTime]){$v=$v.ToString('o',[Globalization.CultureInfo]::InvariantCulture)};$row[$r.GetName($i)]=$v};$rows+=[pscustomobject]$row};if($r.FieldCount -gt 0){$sets+=,@($rows)}}while($r.NextResult())}finally{if($r){$r.Dispose()};$q.Dispose()}}
 @{ok=$true;sets=$sets}|ConvertTo-Json -Depth 20 -Compress
}catch{$e=$_.Exception.GetBaseException();@{ok=$false;stage=$stage;code=$(if($e.Message -cmatch '^SALES_[A-Z_]+$'){$e.Message}else{'SALES_SQL_FAILED'});sqlNumber=$(if($e -is [Data.SqlClient.SqlException]){$e.Number}else{$null});detail=$(if($p.target.database -like 'SCCRM_SalesLab_20261111_*'){$e.Message}else{'withheld'})}|ConvertTo-Json -Compress;exit 1}
finally{if($db){$db.Dispose()};if($p){$p.target.password=''}}
