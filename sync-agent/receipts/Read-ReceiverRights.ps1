param()
$ErrorActionPreference='Stop';[Console]::InputEncoding=[Text.Encoding]::UTF8;[Console]::OutputEncoding=[Text.Encoding]::UTF8
$p=$null;$db=$null;$builder=$null;$q=$null;$r=$null
try{
 $p=[Console]::In.ReadToEnd()|ConvertFrom-Json;$b=[string]$p.branch
 $peers=@{'000'=@('tcp:100.90.166.72,49800','SERVER');'001'=@('100.81.137.41\SQLEXPRESS','SC_001');'003'=@('100.77.101.94\SQLEXPRESS','POSSRV');'004'=@('100.113.59.42\SQLEXPRESS','SERVER004');'005'=@('100.106.107.80\SQLEXPRESS','POSSRV')}
 if(!$peers.ContainsKey($b) -or $p.credentials.user -cne ('sccrm_receipt_sync_'+$b)){throw 'RECEIPT_RIGHTS_SCOPE_REFUSED'}
 $builder=New-Object Data.SqlClient.SqlConnectionStringBuilder;$builder['Data Source']=$peers[$b][0];$builder['Initial Catalog']='AdaAcc';$builder['User ID']=$p.credentials.user;$builder['Password']=$p.credentials.password;$builder['Connect Timeout']=5;$builder['Pooling']=$false;$builder['Application Name']='SCCRM-Receipt-Rights-ReadOnly'
 $db=New-Object Data.SqlClient.SqlConnection $builder.ConnectionString;$db.Open();$builder['Password']='';$p.credentials.password=''
 $q=$db.CreateCommand();$q.CommandTimeout=5;$q.CommandText=@'
SELECT CONVERT(varchar(128),SERVERPROPERTY('MachineName')) machine,DB_NAME() database_name,ORIGINAL_LOGIN() actor,
 IS_SRVROLEMEMBER('sysadmin') elevated,IS_MEMBER('db_owner') owner_role,IS_MEMBER('db_datawriter') writer_role,
 HAS_PERMS_BY_NAME('dbo.TCNMCst','OBJECT','SELECT') customer_read,HAS_PERMS_BY_NAME('dbo.TCNMCst','OBJECT','UPDATE') customer_update,
 HAS_PERMS_BY_NAME('dbo.TPSTSalHD','OBJECT','UPDATE') sale_update,HAS_PERMS_BY_NAME('dbo.TCNTCstPoint','OBJECT','INSERT') point_insert,
 HAS_PERMS_BY_NAME('dbo.SCCRM_AttachReceiptMember','OBJECT','EXECUTE') receiver_execute
'@
 $r=$q.ExecuteReader();if(!$r.Read() -or $r['machine'] -cne $peers[$b][1] -or $r['database_name'] -cne 'AdaAcc' -or $r['actor'] -cne ('sccrm_receipt_sync_'+$b)){throw 'RECEIPT_RIGHTS_IDENTITY_REFUSED'}
 $result=[ordered]@{ok=$true;branch=$b;database='AdaAcc';worker=[string]$r['actor'];customerDataRead=$false;productionWrites=0}
 foreach($name in @('elevated','owner_role','writer_role','customer_read','customer_update','sale_update','point_insert')){if($r[$name] -is [DBNull] -or [int]$r[$name] -ne 0){throw 'RECEIPT_RIGHTS_EXCESSIVE_OR_UNKNOWN'};$result[$name]=0}
 if($r['receiver_execute'] -is [DBNull] -or [int]$r['receiver_execute'] -ne 1){throw 'RECEIPT_RECEIVER_EXECUTE_REQUIRED'};$result.receiver_execute=1
 $result|ConvertTo-Json -Compress
}catch{@{ok=$false;code='RECEIPT_RIGHTS_VERIFY_FAILED';branch=$(if($p){$p.branch}else{$null});detailsWithheld=$true;productionWrites=0}|ConvertTo-Json -Compress;exit 1}
finally{if($r){$r.Dispose()};if($q){$q.Dispose()};if($db){$db.Dispose()};if($builder){$builder['Password']=''};if($p){$p.credentials.password=''}}
