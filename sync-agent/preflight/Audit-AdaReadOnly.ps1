$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.Encoding]::UTF8
$settings=@{};$db=$null;$b=$null
try {
 foreach($line in [IO.File]::ReadAllLines('\\100.90.166.72\C\Users\Administrator\Desktop\Stockdays\SC-StockDay-Ordering\apps\adapos-sync\.env')){if($line -match '^\s*(ADAPOS_SQLSERVER_USER|ADAPOS_SQLSERVER_PASSWORD|ADAPOS_SYNC_BRANCH_CODE)\s*=\s*(.*)$'){$settings[$Matches[1]]=$Matches[2].Trim().Trim([char]34,[char]39)}}
 if($settings.ADAPOS_SYNC_BRANCH_CODE -cne '000'){throw 'WRONG_BRANCH'}
 $b=New-Object Data.SqlClient.SqlConnectionStringBuilder;$b['Data Source']='tcp:100.90.166.72,49800';$b['Initial Catalog']='AdaAcc';$b['User ID']=$settings.ADAPOS_SQLSERVER_USER;$b['Password']=$settings.ADAPOS_SQLSERVER_PASSWORD;$b['Connect Timeout']=4;$b['Application Name']='SCCRM-SELECT-only-full-member-preflight'
 $db=New-Object Data.SqlClient.SqlConnection $b.ConnectionString;$db.Open()
 $q=$db.CreateCommand();$q.CommandText='SET LOCK_TIMEOUT 1000; SET DEADLOCK_PRIORITY LOW;';$null=$q.ExecuteNonQuery();$q.Dispose()
 function Read-Only([string]$sql){
  if($sql.TrimStart() -notmatch '^SELECT\b' -or $sql -match '(?i)\b(INSERT|UPDATE|DELETE|MERGE|ALTER|CREATE|DROP|TRUNCATE|INTO|EXEC)\b'){throw 'NON_SELECT_REFUSED'}
  $q=$db.CreateCommand();$q.CommandTimeout=8;$q.CommandText=$sql;$r=$q.ExecuteReader();$rows=New-Object Collections.Generic.List[object]
  try{while($r.Read()){$row=[ordered]@{};for($i=0;$i -lt $r.FieldCount;$i++){$v=if($r.IsDBNull($i)){$null}else{$r.GetValue($i)};if($v -is [datetime]){$v=$v.ToString('yyyy-MM-ddTHH:mm:ss')};$row[$r.GetName($i)]=$v};$rows.Add([pscustomobject]$row)}}finally{$r.Dispose();$q.Dispose()};return ,$rows.ToArray()
 }
 $identity=Read-Only "SELECT CAST(SERVERPROPERTY('MachineName') AS nvarchar(128)) machine,DB_NAME() db"
 if($identity[0].machine -cne 'SERVER' -or $identity[0].db -cne 'AdaAcc'){throw 'WRONG_SOURCE'}
 $customers=Read-Only "SELECT TOP(20001) FTCstCode code,ISNULL(FTCstName,'') name,ISNULL(FTCstTel,'') phone,ISNULL(FTCstEmail,'') email,FTBchCode branch,FTCstStaActive active,FDDateUpd updated_date,FTTimeUpd updated_time FROM dbo.TCNMCst ORDER BY FTCstCode OPTION(MAXDOP 1)"
 if($customers.Count -gt 20000){throw 'CUSTOMER_AUDIT_LIMIT'}
 $tables=Read-Only "SELECT t.name table_name,SUM(p.rows) estimated_rows FROM sys.tables t JOIN sys.partitions p ON p.object_id=t.object_id AND p.index_id IN(0,1) WHERE t.name IN('TPSTSalHD','TPSTSalDT','TCNMCst','TCNTCstPoint') GROUP BY t.name ORDER BY t.name"
 $columns=Read-Only "SELECT t.name table_name,c.name column_name,ty.name type_name,c.max_length,c.is_nullable FROM sys.tables t JOIN sys.columns c ON c.object_id=t.object_id JOIN sys.types ty ON ty.user_type_id=c.user_type_id WHERE t.name IN('TPSTSalHD','TPSTSalDT') ORDER BY t.name,c.column_id"
 $statuses=Read-Only "SELECT FTShdDocType doc_type,FTShdStaPaid paid_status,FTShdStaDoc doc_status,COUNT_BIG(*) documents,COUNT_BIG(CASE WHEN NULLIF(LTRIM(RTRIM(FTCstCode)),'') IS NOT NULL THEN 1 END) with_customer,COUNT(DISTINCT NULLIF(LTRIM(RTRIM(FTCstCode)),'')) customer_codes FROM dbo.TPSTSalHD GROUP BY FTShdDocType,FTShdStaPaid,FTShdStaDoc OPTION(MAXDOP 1)"
 $salesByCustomer=Read-Only "SELECT TOP(20) FTCstCode code,COUNT_BIG(*) documents FROM dbo.TPSTSalHD WHERE FTShdDocType='1' AND FTShdStaPaid='3' GROUP BY FTCstCode ORDER BY COUNT_BIG(*) DESC OPTION(MAXDOP 1)"
 $indexes=Read-Only "SELECT t.name table_name,i.name index_name,i.is_unique,ic.key_ordinal,c.name column_name FROM sys.tables t JOIN sys.indexes i ON i.object_id=t.object_id JOIN sys.index_columns ic ON ic.object_id=i.object_id AND ic.index_id=i.index_id JOIN sys.columns c ON c.object_id=ic.object_id AND c.column_id=ic.column_id WHERE t.name IN('TPSTSalHD','TPSTSalDT') AND ic.is_included_column=0 ORDER BY t.name,i.index_id,ic.key_ordinal"
 [ordered]@{ok=$true;at=[datetime]::UtcNow.ToString('o');customers=$customers;tables=$tables;columns=$columns;statuses=$statuses;salesByCustomer=$salesByCustomer;indexes=$indexes;productionWrites=0;pinRead=$false}|ConvertTo-Json -Depth 7 -Compress
}catch{[ordered]@{ok=$false;code='ADA_PREFLIGHT_FAILED';type=$_.Exception.GetBaseException().GetType().Name;productionWrites=0;detailsWithheld=$true}|ConvertTo-Json -Compress;exit 1}
finally{if($db){$db.Dispose()};if($b){$b.Password=''};$settings.Clear();$line=$null;$Matches=$null}
