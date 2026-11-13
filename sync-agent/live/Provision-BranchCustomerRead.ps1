param([ValidateSet('Copy','Live')][string]$Mode='Copy',[ValidateSet('001','003','004','005')][string]$Branch='003')
$ErrorActionPreference='Stop';[Console]::InputEncoding=[Text.Encoding]::UTF8;[Console]::OutputEncoding=[Text.Encoding]::UTF8
$p=$null;$db=$null;$builder=$null;$marker='ef76cc14-1b6b-49c9-8da7-1bfaea3dd92b'
try{
 $p=[Console]::In.ReadToEnd()|ConvertFrom-Json;$a=$p.admin
 $targets=@{'000'=@('tcp:100.90.166.72,49800','SERVER');'001'=@('100.81.137.41\SQLEXPRESS','SC_001');'003'=@('100.77.101.94\SQLEXPRESS','POSSRV');'004'=@('100.113.59.42\SQLEXPRESS','SERVER004');'005'=@('100.106.107.80\SQLEXPRESS','POSSRV')}
 $sourceBranch=if($Mode -ceq 'Copy'){'000'}else{$Branch};$target=$targets[$sourceBranch]
 if($p.scope -cne 'SCCRM-BRANCH-PROFILE-READ-CAPABILITY-V1' -or $a.branch -cne $sourceBranch -or $a.database -cne 'AdaAcc' -or $a.server -cne $target[0] -or $a.machine -ine $target[1] -or !$a.provenance.effectiveConfigRead -or !$a.provenance.readonlySqlIdentityVerified -or $a.provenance.remoteFilesWritten -ne 0){throw 'PROFILE_READ_TARGET_REFUSED'}
 $sourceHash=(Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash
 if($Mode -ceq 'Live' -and (!$p.copyProof.ok -or $p.copyProof.productionWrites -ne 0 -or $p.copyProof.sourceHash -cne $sourceHash -or $p.copyProof.checks -ne 4)){throw 'PROFILE_READ_COPY_PROOF_REQUIRED'}
 $builder=New-Object Data.SqlClient.SqlConnectionStringBuilder;$builder['Data Source']=$a.server;$builder['Initial Catalog']='AdaAcc';$builder['User ID']=$a.user;$builder['Password']=$a.password;$builder['Connect Timeout']=5;$builder['Pooling']=$false;$builder['Application Name']='SCCRM-Owned-Profile-Read-Capability'
 function Connect([string]$database){if($script:db){$script:db.Dispose()};$builder['Initial Catalog']=$database;$script:db=New-Object Data.SqlClient.SqlConnection $builder.ConnectionString;$script:db.Open()}
 function Run([string]$sql){$q=$db.CreateCommand();$q.CommandTimeout=8;$q.CommandText=$sql;$r=$null;$rows=New-Object Collections.Generic.List[object];try{$r=$q.ExecuteReader();do{while($r.Read()){$row=[ordered]@{};for($i=0;$i -lt $r.FieldCount;$i++){$row[$r.GetName($i)]=if($r.IsDBNull($i)){$null}else{$r.GetValue($i)}};$rows.Add([pscustomobject]$row)}}while($r.NextResult());return ,$rows.ToArray()}finally{if($r){$r.Dispose()};$q.Dispose()}}
 Connect 'AdaAcc';$identity=Run "SELECT CONVERT(varchar(128),SERVERPROPERTY('MachineName')) machine,DB_NAME() db"
 if($identity.Count -ne 1 -or $identity[0].machine -ine $target[1] -or $identity[0].db -cne 'AdaAcc'){throw 'PROFILE_READ_IDENTITY_REFUSED'}
 $database='AdaAcc';$branches=@($Branch);$user='sccrm_sales_export_'+$Branch
 if($Mode -ceq 'Copy'){
  $database='SCCRM_HistorySourceCopy_20261113';Connect 'master'
  $databaseExisted=(Run ("SELECT CASE WHEN DB_ID('"+$database+"') IS NULL THEN 0 ELSE 1 END present"))[0].present -eq 1
  $null=Run ("IF DB_ID('"+$database+"') IS NULL CREATE DATABASE ["+$database+"] COLLATE Thai_CI_AS;")
  Connect $database
  $exists=Run "SELECT OBJECT_ID('dbo.HistoryReadCopyOwner') marker,OBJECT_ID('dbo.TCNMCst') customers"
  if($exists[0].marker){$own=Run 'SELECT marker FROM dbo.HistoryReadCopyOwner';if($own.Count -ne 1 -or [string]$own[0].marker -cne $marker){throw 'PROFILE_READ_COPY_OWNER_REFUSED'}}
  else{
   if($databaseExisted){throw 'PROFILE_READ_COPY_OWNER_REQUIRED'}
   if($exists[0].customers){throw 'PROFILE_READ_COPY_COLLISION_REFUSED'}
   $null=Run ("CREATE TABLE dbo.HistoryReadCopyOwner(marker varchar(36) PRIMARY KEY);INSERT dbo.HistoryReadCopyOwner VALUES('"+$marker+"');CREATE TABLE dbo.TCNMCst(FTCstCode varchar(20) PRIMARY KEY,FTCstName varchar(100),FTCstTel varchar(30),FTCstEmail varchar(100),FTBchCode varchar(3),FTCstStaActive varchar(1),FTCstPin varchar(100));CREATE USER sccrm_history_source_copy WITHOUT LOGIN;")
   foreach($b in @('001','003','004','005')){$null=Run ("INSERT dbo.TCNMCst VALUES('AR"+$b+"-900001','Synthetic fixture','0990000001',NULL,'"+$b+"','1','SYNTHETIC_PRIVATE_PIN');")}
   $null=Run "INSERT dbo.TCNMCst VALUES('AR003-900002','Wrong home branch',NULL,NULL,'004','1','SYNTHETIC_PRIVATE_PIN');"
  }
  $branches=@('001','003','004','005');$user='sccrm_history_source_copy'
 }
 $checks=0
 foreach($b in $branches){
  if($Mode -ceq 'Live'){$user='sccrm_sales_export_'+$b;$actor=Run ("SELECT IS_SRVROLEMEMBER('sysadmin','"+$user+"') elevated,USER_ID('"+$user+"') actor");if($actor[0].elevated -ne 0 -or !$actor[0].actor){throw 'PROFILE_READ_RUNTIME_ROLE_REFUSED'}}
  $existing=Run "SELECT OBJECT_ID('dbo.SCCRM_HistoryExport_LocalCustomers') view_id"
  if($existing[0].view_id){$owner=Run "SELECT CONVERT(varchar(36),value) marker FROM sys.extended_properties WHERE class=1 AND major_id=OBJECT_ID('dbo.SCCRM_HistoryExport_LocalCustomers') AND name='SCCRM_HistoryReadMarker'";if($owner.Count -ne 1 -or $owner[0].marker -cne $marker){throw 'PROFILE_READ_VIEW_COLLISION_REFUSED'}}
  $verb=if($existing[0].view_id){'ALTER'}else{'CREATE'}
  $null=Run ($verb+" VIEW dbo.SCCRM_HistoryExport_LocalCustomers AS SELECT FTCstCode,FTCstName,FTCstTel,FTCstEmail,FTBchCode,FTCstStaActive FROM dbo.TCNMCst WHERE FTBchCode='"+$b+"' AND FTCstCode LIKE 'AR"+$b+"-[0-9][0-9][0-9][0-9][0-9][0-9]' AND LEN(FTCstCode)=12;")
  if(!$existing[0].view_id){$null=Run ("EXEC sys.sp_addextendedproperty @name='SCCRM_HistoryReadMarker',@value='"+$marker+"',@level0type='SCHEMA',@level0name='dbo',@level1type='VIEW',@level1name='SCCRM_HistoryExport_LocalCustomers';")}
  $null=Run ("GRANT SELECT ON dbo.SCCRM_HistoryExport_LocalCustomers TO ["+$user+"];")
  $proof=Run ("EXECUTE AS USER='"+$user+"';SELECT HAS_PERMS_BY_NAME('dbo.SCCRM_HistoryExport_LocalCustomers','OBJECT','SELECT') view_read,ISNULL(HAS_PERMS_BY_NAME('dbo.TCNMCst','OBJECT','SELECT'),0) raw_read,ISNULL(HAS_PERMS_BY_NAME('dbo.TCNMCst','OBJECT','SELECT','FTCstPin','COLUMN'),0) pin_read,ISNULL(HAS_PERMS_BY_NAME('dbo.TCNMCst','OBJECT','UPDATE'),0) native_update;REVERT;")
  if($proof.Count -ne 1 -or $proof[0].view_read -ne 1 -or $proof[0].raw_read -ne 0 -or $proof[0].pin_read -ne 0 -or $proof[0].native_update -ne 0){throw 'PROFILE_READ_RIGHTS_REFUSED'}
  $cols=Run "SELECT name FROM sys.columns WHERE object_id=OBJECT_ID('dbo.SCCRM_HistoryExport_LocalCustomers') ORDER BY column_id"
  if(($cols.name -join ',') -cne 'FTCstCode,FTCstName,FTCstTel,FTCstEmail,FTBchCode,FTCstStaActive'){throw 'PROFILE_READ_COLUMNS_REFUSED'}
  if($Mode -ceq 'Copy'){$rows=Run ("EXECUTE AS USER='"+$user+"';SELECT COUNT(*) n FROM dbo.SCCRM_HistoryExport_LocalCustomers;REVERT;");if($rows[0].n -ne 1){throw 'PROFILE_READ_FILTER_FAILED'}}
  $checks++
 }
 @{ok=$true;mode=$Mode;branch=$Branch;checks=$checks;sourceHash=$sourceHash;productionWrites=0;productionSchemaChanged=($Mode -ceq 'Live');nativeCustomerWrites=0;pinRead=$false;ownedView='SCCRM_HistoryExport_LocalCustomers'}|ConvertTo-Json -Compress
}catch{$e=$_.Exception.GetBaseException();@{ok=$false;code=$(if($e.Message -cmatch '^PROFILE_READ_[A-Z_]+$'){$e.Message}else{'PROFILE_READ_PROVISION_FAILED'});sqlNumber=$(if($e -is [Data.SqlClient.SqlException]){$e.Number}else{$null});detailsWithheld=$true}|ConvertTo-Json -Compress;exit 1}
finally{if($db){$db.Dispose()};if($builder){$builder.Password=''};if($p){$p.admin.password=''}}
