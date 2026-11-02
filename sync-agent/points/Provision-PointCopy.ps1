$ErrorActionPreference='Stop'
[Console]::InputEncoding=[Text.Encoding]::UTF8;[Console]::OutputEncoding=[Text.Encoding]::UTF8
$db=$null;$b=$null;$packet=$null;$stage='packet'
function Run([string]$sql){$q=$db.CreateCommand();$q.CommandTimeout=20;$q.CommandText=$sql;try{return $q.ExecuteNonQuery()}finally{$q.Dispose()}}
function Table([string]$sql){$q=$db.CreateCommand();$q.CommandTimeout=10;$q.CommandText=$sql;$t=New-Object Data.DataTable;$r=$q.ExecuteReader();try{$t.Load($r);return ,$t}finally{$r.Dispose();$q.Dispose()}}
try{
 $packet=[Console]::In.ReadToEnd()|ConvertFrom-Json
 if($packet.scope -cne 'SCCRM-ADA-POINT-COPY-PROVISION-20261102' -or $packet.branch -cnotmatch '^(000|001|003|004|005)$' -or $packet.snapshot.branch -cne $packet.branch -or $packet.snapshot.mode -cne 'Live' -or $packet.snapshot.pinRead -ne $false){throw 'POINT_COPY_SCOPE_REFUSED'}
 $name='SCCRM_PointCopy_20261102_'+[string]$packet.branch;$login='sccrm_point_copy_'+[string]$packet.branch
 if($packet.copyPassword -cnotmatch '^[A-Za-z0-9!]{32,120}$'){throw 'POINT_COPY_PASSWORD_REFUSED'}
 $b=New-Object Data.SqlClient.SqlConnectionStringBuilder;$b['Data Source']='tcp:100.90.166.72,49800';$b['Initial Catalog']='master';$b['User ID']=$packet.admin.user;$b['Password']=$packet.admin.password;$b['Connect Timeout']=8;$b['Pooling']=$false;$b['Application Name']='SCCRM-Points-Copy-Provision-Only'
 $db=New-Object Data.SqlClient.SqlConnection $b.ConnectionString;$db.Open();$b['Password']='';$packet.admin.password=''
 $identity=Table "SET DEADLOCK_PRIORITY LOW;SET LOCK_TIMEOUT 1000;SELECT CONVERT(varchar(128),SERVERPROPERTY('MachineName')) machine"
 if($identity.Rows.Count -ne 1 -or $identity.Rows[0].machine -cne 'SERVER'){throw 'POINT_COPY_SERVER_REFUSED'}
 $collation=[string](Table "SELECT CONVERT(varchar(128),DATABASEPROPERTYEX('AdaAcc','Collation')) c").Rows[0].c
 if($collation -cnotmatch '^[A-Za-z0-9_]+$'){throw 'POINT_COPY_COLLATION_REFUSED'}
 $exists=Table "SELECT name FROM sys.databases WHERE name='$name'";$resuming=$exists.Rows.Count -gt 0
 if($resuming){
  $null=Run "USE [$name]"
  $owned=Table "SELECT CONVERT(varchar(36),value) marker FROM sys.extended_properties WHERE class=0 AND name='SCCRM_PointCopyMarker'"
  if($owned.Rows.Count -ne 1 -or $owned.Rows[0].marker -cne '238ecf14-fda8-46a8-bc34-d663659b2202'){throw 'POINT_COPY_ALREADY_EXISTS_NO_OVERWRITE'}
  $uninitialized=Table "SELECT OBJECT_ID('dbo.SCCRM_PointSyncMeta') receiver,(SELECT COUNT(*) FROM dbo.TCNTCstPoint) points"
  if($uninitialized.Rows[0].receiver -ne [DBNull]::Value -or $uninitialized.Rows[0].points -ne 0){throw 'POINT_COPY_ALREADY_INITIALIZED'}
  $null=Run "ALTER DATABASE [$name] COLLATE $collation"
 }else{
  $stage='create-owned-copy';$null=Run "CREATE DATABASE [$name] COLLATE $collation";$null=Run "USE [$name]"
  $null=Run "EXEC sys.sp_addextendedproperty @name=N'SCCRM_PointCopyMarker',@value=N'238ecf14-fda8-46a8-bc34-d663659b2202'"
 }
 $cols=Table "SELECT name FROM AdaAcc.sys.columns WHERE object_id=OBJECT_ID('AdaAcc.dbo.TCNMCst') AND name NOT LIKE '%pin%' AND name NOT LIKE '%password%' AND name NOT LIKE '%secret%' AND name NOT LIKE '%token%' ORDER BY column_id"
 if($cols.Rows.Count -ne 101){throw 'POINT_COPY_CUSTOMER_SCHEMA_CHANGED'}
 $names=@($cols.Rows|ForEach-Object{if($_.name -cnotmatch '^[A-Za-z_][A-Za-z0-9_]*$'){throw 'POINT_COPY_COLUMN_REFUSED'};'['+$_.name+']'})
 if(-not $resuming){
  $null=Run ('SELECT '+($names -join ',')+' INTO dbo.TCNMCst FROM AdaAcc.dbo.TCNMCst;ALTER TABLE dbo.TCNMCst ADD CONSTRAINT PK_PointCopyCustomer PRIMARY KEY(FTCstCode)')
  $null=Run "SELECT TOP(0) FTBchCode,FTCstCode,FTPntRefDoc,FTSplCode,FDPntDate,FCPntPointbyOne,FCPntAmtRcv,FNPntPoint,FNPntPointOld,FTPntExpired,FTPntStaPrcDoc,FTPntCardType,FTCptJDate,FTCptTime,FDPntSplStart,FDPntSplExpired,FTPntStaExpired,FDDateUpd,FTTimeUpd,FTWhoUpd,FDDateIns,FTTimeIns,FTWhoIns INTO dbo.TCNTCstPoint FROM AdaAcc.dbo.TCNTCstPoint;ALTER TABLE dbo.TCNTCstPoint ADD CONSTRAINT PK_PointCopyPoint PRIMARY KEY(FTBchCode,FTCstCode,FTPntRefDoc,FTSplCode)"
 }
 # Only point/provenance values are copied from other verified branches. These
 # updates are confined to the newly created marked copy, never the source.
 $stage='seed-copy-masters'
 $null=Run "CREATE TABLE #PointCopyMasters(FTCstCode varchar(20) COLLATE $collation,FCCstRetPoint float,FCCstRetAmt float,FCCstWhsPoint float,FCCstDailyPoint float,FTBchCode varchar(3) COLLATE $collation)"
 $masterSeed=Table 'SELECT TOP(0) * FROM #PointCopyMasters'
 foreach($c in $packet.snapshot.customers){
  $row=$masterSeed.NewRow();$row.FTCstCode=$c.FTCstCode
  foreach($k in @('FCCstRetPoint','FCCstRetAmt','FCCstWhsPoint','FCCstDailyPoint')){$v=$c.$k;$row[$k]=if($null -eq $v){[DBNull]::Value}else{[double]::Parse([string]$v,[Globalization.CultureInfo]::InvariantCulture)}}
  $row.FTBchCode=if($null -eq $c.FTBchCode){[DBNull]::Value}else{$c.FTBchCode};$masterSeed.Rows.Add($row)
 }
 $bulk=New-Object Data.SqlClient.SqlBulkCopy $db;$bulk.DestinationTableName='#PointCopyMasters';$bulk.BatchSize=1000;$bulk.BulkCopyTimeout=20
 try{foreach($c in $masterSeed.Columns){$null=$bulk.ColumnMappings.Add($c.ColumnName,$c.ColumnName)};$bulk.WriteToServer($masterSeed)}finally{$bulk.Dispose()}
 $null=Run 'INSERT dbo.TCNMCst(FTCstCode) SELECT s.FTCstCode FROM #PointCopyMasters s WHERE NOT EXISTS(SELECT 1 FROM dbo.TCNMCst c WHERE c.FTCstCode=s.FTCstCode);UPDATE c SET FCCstRetPoint=s.FCCstRetPoint,FCCstRetAmt=s.FCCstRetAmt,FCCstWhsPoint=s.FCCstWhsPoint,FCCstDailyPoint=s.FCCstDailyPoint,FTBchCode=s.FTBchCode FROM dbo.TCNMCst c JOIN #PointCopyMasters s ON s.FTCstCode=c.FTCstCode'
 $stage='seed-copy-events';$schema=Table 'SELECT TOP(0) * FROM dbo.TCNTCstPoint'
 foreach($p in $packet.snapshot.points){$row=$schema.NewRow();foreach($c in $schema.Columns){$v=$p.($c.ColumnName);if($null -eq $v){$row[$c.ColumnName]=[DBNull]::Value}elseif($c.DataType -eq [datetime]){$row[$c.ColumnName]=[datetime]::ParseExact([string]$v,'yyyy-MM-ddTHH:mm:ss.fff',[Globalization.CultureInfo]::InvariantCulture)}else{$row[$c.ColumnName]=[Convert]::ChangeType($v,$c.DataType,[Globalization.CultureInfo]::InvariantCulture)}};$schema.Rows.Add($row)}
 $bulk=New-Object Data.SqlClient.SqlBulkCopy $db;$bulk.DestinationTableName='dbo.TCNTCstPoint';$bulk.BatchSize=1000;$bulk.BulkCopyTimeout=20
 try{foreach($c in $schema.Columns){$null=$bulk.ColumnMappings.Add($c.ColumnName,$c.ColumnName)};$bulk.WriteToServer($schema)}finally{$bulk.Dispose()}
 $stage='native-view';$null=Run ([string]$packet.snapshot.schema.viewDefinition)
 $identityValue='copy'+[string]$packet.branch+'/SERVER/'+$name
 $null=Run "CREATE TABLE dbo.SCCRM_PointSyncMeta(singleton int PRIMARY KEY CHECK(singleton=1),marker uniqueidentifier NOT NULL,target_identity varchar(160) NOT NULL,branch_code varchar(3) NOT NULL);INSERT dbo.SCCRM_PointSyncMeta VALUES(1,'238ecf14-fda8-46a8-bc34-d663659b2202','$identityValue','$($packet.branch)');CREATE TABLE dbo.SCCRM_PointSyncReceipts(operation_id uniqueidentifier PRIMARY KEY,ada_code varchar(20) NOT NULL,branch_code varchar(3) NOT NULL,ref_doc varchar(30) NOT NULL UNIQUE,revision char(64) NOT NULL,generation bigint NOT NULL,expected_intrinsic float NOT NULL,previous_balance float NOT NULL,target_balance bigint NOT NULL,delta_points bigint NOT NULL,created_at datetime NOT NULL);CREATE INDEX IX_SCCRM_PointSyncCst ON dbo.SCCRM_PointSyncReceipts(ada_code);CREATE TABLE dbo.SCCRM_PointSyncHeads(ada_code varchar(20) PRIMARY KEY,last_generation bigint NOT NULL,last_revision char(64) NOT NULL,last_target bigint NOT NULL,last_operation uniqueidentifier NOT NULL)"
 $sql=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'native-receiver.sql')).Replace('__DATABASE__',$name).Replace('__BRANCH__',[string]$packet.branch).Replace('__IDENTITY__',$identityValue)
 $stage='copy-only-receiver';$null=Run $sql
 $password=[string]$packet.copyPassword
 if((Table "SELECT name FROM sys.server_principals WHERE name='$login'").Rows.Count){throw 'POINT_COPY_LOGIN_COLLISION'}
 $null=Run "CREATE LOGIN [$login] WITH PASSWORD='$password',CHECK_POLICY=ON;CREATE USER [$login] FOR LOGIN [$login];GRANT CONNECT TO [$login];GRANT SELECT ON dbo.SCCRM_PointSyncMeta TO [$login];GRANT SELECT ON dbo.SCCRM_PointSyncReceipts TO [$login];GRANT SELECT ON dbo.VCN_TCNMPdtCstPointAmt TO [$login];GRANT SELECT ON dbo.TCNTCstPoint TO [$login];GRANT EXECUTE ON dbo.SCCRM_ApplyPointProjection TO [$login];DENY INSERT,UPDATE,DELETE ON dbo.TCNMCst TO [$login];DENY INSERT,UPDATE,DELETE ON dbo.TCNTCstPoint TO [$login]"
 [ordered]@{ok=$true;scope='SCCRM-ADA-POINT-COPY-PROVISION-20261102';branch=$packet.branch;database=$name;identity=$identityValue;customerColumns=101;events=$schema.Rows.Count;productionWrites=0;pinRead=$false}|ConvertTo-Json -Compress
}catch{$e=$_.Exception.GetBaseException();[ordered]@{ok=$false;code=if($e.Message -cmatch '^[A-Z_]{5,100}$'){$e.Message}else{'POINT_COPY_PROVISION_FAILED'};stage=$stage;sqlNumber=if($e -is [Data.SqlClient.SqlException]){$e.Number}else{$null};productionWrites=0;pinRead=$false}|ConvertTo-Json -Compress;exit 1}
finally{if($db){$db.Dispose()};if($b){$b['Password']=''};if($packet){$packet.admin.password='';$packet.copyPassword=''}}
