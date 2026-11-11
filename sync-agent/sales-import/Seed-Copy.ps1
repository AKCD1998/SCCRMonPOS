param()
$ErrorActionPreference='Stop';[Console]::InputEncoding=[Text.Encoding]::UTF8;[Console]::OutputEncoding=[Text.Encoding]::UTF8
$p=$null;$src=$null;$dst=$null;$tx=$null
try{
 $p=[Console]::In.ReadToEnd()|ConvertFrom-Json
 if($p.scope -cne 'SCCRM-HQ-SALES-IMPORT-V1' -or $p.target.database -cnotmatch '^SCCRM_SalesLab_20261111_(001|003|004|005)$' -or $p.target.machine -cne 'SERVER'){throw 'SALES_COPY_SEED_REFUSED'}
 function Open($t){$b=New-Object Data.SqlClient.SqlConnectionStringBuilder;$b['Data Source']=$t.server;$b['Initial Catalog']=$t.database;$b['User ID']=$t.user;$b['Password']=$t.password;$b['Connect Timeout']=5;$b['Application Name']='SCCRM-Sales-Copy-Seed';$d=New-Object Data.SqlClient.SqlConnection $b.ConnectionString;$d.Open();$t.password='';return $d}
 $src=Open $p.source;$dst=Open $p.target
 $q=$dst.CreateCommand();$q.CommandText="IF NOT EXISTS(SELECT 1 FROM dbo.SCCRM_SalesMeta WHERE marker='b740db43-5811-44cb-b072-0480a0b26f19') RAISERROR('SALES_COPY_MARKER_REQUIRED',16,1);";$null=$q.ExecuteNonQuery();$q.Dispose();$tx=$dst.BeginTransaction();$counts=@{}
 foreach($table in @('TPSTSalHD','TPSTSalDT','TPSTSalRC','TPSTSalPD','TPSTSalPG','TPSTSalPH','TPSTSalInvCsm','TPSTVoidDT')){
  $names=@($p.columns|Where-Object{$_.table_name -ceq $table}|ForEach-Object{if($_.column_name -cnotmatch '^[A-Za-z0-9_]+$' -or $_.column_name -match 'pin|password|secret|token'){throw 'SALES_COLUMN_REFUSED'};'['+$_.column_name+']'})
  $q=$src.CreateCommand();$q.CommandTimeout=8;$q.CommandText='SET LOCK_TIMEOUT 750;SET DEADLOCK_PRIORITY LOW;SELECT '+($names -join ',')+' FROM dbo.['+$table+'] WHERE FTShdDocNo=@doc';$null=$q.Parameters.Add('@doc',[Data.SqlDbType]::VarChar,20);$q.Parameters['@doc'].Value=$p.doc
  $dt=New-Object Data.DataTable;$a=New-Object Data.SqlClient.SqlDataAdapter $q;$null=$a.Fill($dt);$a.Dispose();$q.Dispose();if($dt.Rows.Count -gt 1000){throw 'SALES_COPY_TOO_LARGE'}
  if($dt.Rows.Count){$bulk=New-Object Data.SqlClient.SqlBulkCopy($dst,([Data.SqlClient.SqlBulkCopyOptions]::CheckConstraints -bor [Data.SqlClient.SqlBulkCopyOptions]::KeepNulls),$tx);try{$bulk.DestinationTableName='dbo.['+$table+']';$bulk.BulkCopyTimeout=8;foreach($col in $dt.Columns){$null=$bulk.ColumnMappings.Add($col.ColumnName,$col.ColumnName)};$bulk.WriteToServer($dt)}finally{$bulk.Close();$bulk.Dispose()}}
  $counts[$table]=$dt.Rows.Count
 }
 $tx.Commit();$tx.Dispose();$tx=$null;@{ok=$true;doc=$p.doc;rows=$counts;productionWrites=0;pinRead=$false}|ConvertTo-Json -Compress
}catch{$e=$_.Exception.GetBaseException();@{ok=$false;code='SALES_COPY_SEED_FAILED';detail=$e.Message}|ConvertTo-Json -Compress;exit 1}finally{if($tx){$tx.Rollback();$tx.Dispose()};if($src){$src.Dispose()};if($dst){$dst.Dispose()};if($p){$p.source.password='';$p.target.password=''}}
