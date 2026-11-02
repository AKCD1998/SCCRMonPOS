param([ValidateSet('Preflight','Install')][string]$Action='Preflight')
# Explicit one-time operator only. The service never loads this administrator tool.
$ErrorActionPreference='Stop'
[Console]::InputEncoding=[Text.Encoding]::UTF8;[Console]::OutputEncoding=[Text.Encoding]::UTF8
$db=$null;$builder=$null;$p=$null;$stage='packet';$tx=$null
function Rows([string]$sql){$q=$db.CreateCommand();$q.CommandText=$sql;$q.CommandTimeout=8;if($tx){$q.Transaction=$tx};$r=$null;$rows=New-Object Collections.Generic.List[object];try{$r=$q.ExecuteReader();while($r.Read()){$x=[ordered]@{};for($i=0;$i -lt $r.FieldCount;$i++){$x[$r.GetName($i)]=if($r.IsDBNull($i)){$null}else{$r.GetValue($i)}};$rows.Add([pscustomobject]$x)};return ,$rows.ToArray()}finally{if($r){$r.Dispose()};$q.Dispose()}}
function Run([string]$sql){$q=$db.CreateCommand();$q.CommandText=$sql;$q.CommandTimeout=8;if($tx){$q.Transaction=$tx};try{return $q.ExecuteNonQuery()}finally{$q.Dispose()}}
try{
 $p=[Console]::In.ReadToEnd()|ConvertFrom-Json;$t=$p.target;$branch=[string]$t.branch
 $expected=@{'000'=@('tcp:100.90.166.72,49800','SERVER');'001'=@('tcp:100.81.137.41,49754','SC_001');'003'=@('tcp:100.77.101.94,49703','POSSRV');'004'=@('tcp:100.113.59.42,49976','SERVER004');'005'=@('tcp:100.106.107.80,49711','POSSRV')}
 if($p.scope -cne 'SCCRM-ADA-PRIMARY-POINTS-LIVE-PROVISION-V1' -or -not $expected.ContainsKey($branch) -or $t.server -cne $expected[$branch][0] -or $t.machine -cne $expected[$branch][1] -or $t.database -cne 'AdaAcc' -or $t.identity -cne ($branch+'/'+$t.machine+'/AdaAcc')){throw 'POINT_LIVE_SCOPE_REFUSED'}
 if($Action -ceq 'Install' -and($p.worker.user -cne ('sccrm_point_sync_'+$branch) -or $p.worker.password -cnotmatch '^Sc![a-f0-9]{56,96}9A$' -or $p.copyVerified -ne $true)){throw 'POINT_LIVE_CREDENTIAL_OR_COPY_PROOF_REQUIRED'}
 $builder=New-Object Data.SqlClient.SqlConnectionStringBuilder;$builder['Data Source']=$t.server;$builder['Initial Catalog']='AdaAcc';$builder['User ID']=$p.admin.user;$builder['Password']=$p.admin.password;$builder['Connect Timeout']=5;$builder['Pooling']=$false;$builder['Application Name']='SCCRM-PointSync-Operator-'+$Action
 $stage='connect';$db=New-Object Data.SqlClient.SqlConnection $builder.ConnectionString;$db.Open();$builder['Password']='';$p.admin.password=''
 $identity=Rows "SET DEADLOCK_PRIORITY LOW;SET LOCK_TIMEOUT 1000;SELECT CONVERT(varchar(128),SERVERPROPERTY('MachineName')) machine,DB_NAME() db"
 if($identity.Count -ne 1 -or $identity[0].machine -cne $t.machine -or $identity[0].db -cne 'AdaAcc'){throw 'POINT_LIVE_DATABASE_REFUSED'}
 $stage='preflight'
 $triggers=Rows "SELECT name FROM sys.triggers WHERE parent_id IN(OBJECT_ID('dbo.TCNTCstPoint'),OBJECT_ID('dbo.TCNMCst')) AND is_disabled=0"
 if($triggers.Count -ne 0){throw 'POINT_LIVE_ACTIVE_TRIGGER_REVIEW_REQUIRED'}
 $view=Rows "SELECT definition FROM sys.sql_modules WHERE object_id=OBJECT_ID('dbo.VCN_TCNMPdtCstPointAmt')"
 if($view.Count -ne 1){throw 'POINT_LIVE_VIEW_REQUIRED'}
 $text=([string]$view[0].definition -replace '\s+',' ').Trim().ToLowerInvariant();$h=[Security.Cryptography.SHA256]::Create();try{$viewHash=([BitConverter]::ToString($h.ComputeHash([Text.Encoding]::UTF8.GetBytes($text)))).Replace('-','').ToLowerInvariant()}finally{$h.Dispose()}
 if($viewHash -cne 'e6e48b1f9c1a69a3bdf53098530c2dbaffb7e2a9b3f7ee0440c78202cf3a7fa4'){throw 'POINT_LIVE_VIEW_CHANGED'}
 $key=Rows "SELECT c.name FROM sys.indexes i JOIN sys.index_columns k ON k.object_id=i.object_id AND k.index_id=i.index_id JOIN sys.columns c ON c.object_id=k.object_id AND c.column_id=k.column_id WHERE i.object_id=OBJECT_ID('dbo.TCNTCstPoint') AND i.is_primary_key=1 ORDER BY k.key_ordinal"
 if(($key.name -join ',') -cne 'FTBchCode,FTCstCode,FTPntRefDoc,FTSplCode'){throw 'POINT_LIVE_KEY_CHANGED'}
 $nativeForeign=Rows "SELECT name FROM sys.foreign_keys WHERE parent_object_id=OBJECT_ID('dbo.TCNTCstPoint') AND is_disabled=0"
 if($nativeForeign.Count -ne 0){throw 'POINT_LIVE_FOREIGN_KEY_REVIEW_REQUIRED'}
 $owned=Rows "SELECT name FROM sys.objects WHERE schema_id=SCHEMA_ID('dbo') AND name IN('SCCRM_PointSyncMeta','SCCRM_PointSyncReceipts','SCCRM_PointSyncHeads','SCCRM_ApplyPointProjection')"
 if($owned.Count -gt 0){throw 'POINT_LIVE_OBJECT_ALREADY_EXISTS_REVIEW_REQUIRED'}
 $login='sccrm_point_sync_'+$branch
 if((Rows "SELECT name FROM sys.server_principals WHERE name='$login'").Count -gt 0 -or (Rows "SELECT name FROM sys.database_principals WHERE name='$login'").Count -gt 0){throw 'POINT_LIVE_LOGIN_COLLISION'}
 $counts=(Rows 'SELECT (SELECT COUNT(*) FROM dbo.TCNMCst) customers,(SELECT COUNT(*) FROM dbo.TCNTCstPoint) point_rows')[0]
 $report=[ordered]@{ok=$true;scope=$p.scope;action=$Action;branch=$branch;identity=$t.identity;viewHash=$viewHash;activeNativeTriggers=0;nativeForeignKeys=0;customers=$counts.customers;pointRows=$counts.point_rows;profileWrites=0;nativePointWrites=0;pinRead=$false}
 if($Action -ceq 'Install'){
  $stage='install-owned-receiver';$tx=$db.BeginTransaction();$password=[string]$p.worker.password
  $null=Run "CREATE TABLE dbo.SCCRM_PointSyncMeta(singleton int PRIMARY KEY CHECK(singleton=1),marker uniqueidentifier NOT NULL,target_identity varchar(160) NOT NULL,branch_code varchar(3) NOT NULL,worker_login sysname NOT NULL,worker_sid varbinary(85) NOT NULL);CREATE LOGIN [$login] WITH PASSWORD='$password',CHECK_POLICY=ON,DEFAULT_DATABASE=[AdaAcc];CREATE USER [$login] FOR LOGIN [$login];INSERT dbo.SCCRM_PointSyncMeta VALUES(1,'238ecf14-fda8-46a8-bc34-d663659b2202','$($t.identity)','$branch','$login',SUSER_SID('$login'));CREATE TABLE dbo.SCCRM_PointSyncReceipts(operation_id uniqueidentifier PRIMARY KEY,ada_code varchar(20) NOT NULL,branch_code varchar(3) NOT NULL,ref_doc varchar(30) NOT NULL UNIQUE,revision char(64) NOT NULL,generation bigint NOT NULL,expected_intrinsic float NOT NULL,previous_balance float NOT NULL,target_balance bigint NOT NULL,delta_points bigint NOT NULL,created_at datetime NOT NULL);CREATE INDEX IX_SCCRM_PointSyncCst ON dbo.SCCRM_PointSyncReceipts(ada_code);CREATE TABLE dbo.SCCRM_PointSyncHeads(ada_code varchar(20) PRIMARY KEY,last_generation bigint NOT NULL,last_revision char(64) NOT NULL,last_target bigint NOT NULL,last_operation uniqueidentifier NOT NULL)"
  $sql=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'native-receiver.sql')).Replace('__DATABASE__','AdaAcc').Replace('__BRANCH__',$branch).Replace('__IDENTITY__',[string]$t.identity)
  $null=Run $sql
  $null=Run "GRANT CONNECT TO [$login];GRANT SELECT(FTCstCode,FCCstRetPoint,FCCstRetAmt,FCCstWhsPoint,FCCstDailyPoint,FTBchCode,FDCstLastPoint,FDDateUpd,FTTimeUpd) ON dbo.TCNMCst TO [$login];GRANT SELECT ON dbo.TCNTCstPoint TO [$login];GRANT SELECT ON dbo.VCN_TCNMPdtCstPointAmt TO [$login];GRANT VIEW DEFINITION ON dbo.TCNMCst TO [$login];GRANT VIEW DEFINITION ON dbo.TCNTCstPoint TO [$login];GRANT VIEW DEFINITION ON dbo.VCN_TCNMPdtCstPointAmt TO [$login];GRANT SELECT ON dbo.SCCRM_PointSyncMeta TO [$login];GRANT SELECT ON dbo.SCCRM_PointSyncReceipts TO [$login];GRANT EXECUTE ON dbo.SCCRM_ApplyPointProjection TO [$login];DENY INSERT,UPDATE,DELETE,ALTER ON dbo.TCNMCst TO [$login];DENY INSERT,UPDATE,DELETE,ALTER ON dbo.TCNTCstPoint TO [$login];DENY INSERT,UPDATE,DELETE,ALTER ON dbo.SCCRM_PointSyncMeta TO [$login];DENY INSERT,UPDATE,DELETE,ALTER ON dbo.SCCRM_PointSyncReceipts TO [$login];DENY INSERT,UPDATE,DELETE,ALTER ON dbo.SCCRM_PointSyncHeads TO [$login]"
  $private=Rows "SELECT name FROM sys.columns WHERE object_id=OBJECT_ID('dbo.TCNMCst') AND(name LIKE '%pin%' OR name LIKE '%password%' OR name LIKE '%secret%' OR name LIKE '%token%')"
  foreach($column in $private){if($column.name -cnotmatch '^[A-Za-z0-9_]+$'){throw 'POINT_LIVE_COLUMN_REFUSED'};$name=[string]$column.name;$null=Run "DENY SELECT([$name]) ON dbo.TCNMCst TO [$login]"}
  $tx.Commit();$tx.Dispose();$tx=$null;$report.worker=$login;$report.receiverInstalled=$true;$report.deliveryEnabled=$false
 }
 $report|ConvertTo-Json -Depth 8 -Compress
}catch{if($tx){try{$tx.Rollback()}catch{}};$e=$_.Exception.GetBaseException();[ordered]@{ok=$false;code=if($e.Message -cmatch '^POINT_[A-Z_0-9]+$'){$e.Message}else{'POINT_LIVE_PROVISION_FAILED'};stage=$stage;sqlNumber=if($e -is [Data.SqlClient.SqlException]){$e.Number}else{$null};detailsWithheld=$true}|ConvertTo-Json -Compress;exit 1}
finally{if($tx){$tx.Dispose()};if($db){$db.Dispose()};if($builder){$builder['Password']=''};if($p){$p.admin.password='';if($p.worker){$p.worker.password=''}}}
