param([ValidateSet('Copy','Live')][string]$Mode='Copy')
$ErrorActionPreference='Stop'
[Console]::InputEncoding=[Text.Encoding]::UTF8;[Console]::OutputEncoding=[Text.Encoding]::UTF8
$db=$null;$builder=$null;$p=$null;$stage='packet'
function Rows([string]$sql){
 $q=$db.CreateCommand();$q.CommandText=$sql;$q.CommandTimeout=10;$r=$null;$rows=New-Object Collections.Generic.List[object]
 try{$r=$q.ExecuteReader();while($r.Read()){$v=[ordered]@{};for($i=0;$i -lt $r.FieldCount;$i++){$x=if($r.IsDBNull($i)){$null}else{$r.GetValue($i)};if($x -is [datetime]){$x=$x.ToString('yyyy-MM-ddTHH:mm:ss.fff',[Globalization.CultureInfo]::InvariantCulture)}elseif($x -is [guid]){$x=$x.ToString().ToLowerInvariant()}elseif($x -is [long] -or $x -is [decimal]){$x=$x.ToString([Globalization.CultureInfo]::InvariantCulture)}elseif($x -is [double]){$x=$x.ToString('R',[Globalization.CultureInfo]::InvariantCulture)};$v[$r.GetName($i)]=$x};$rows.Add([pscustomobject]$v)};return ,$rows.ToArray()}finally{if($r){$r.Dispose()};$q.Dispose()}
}
function Run([string]$sql){$q=$db.CreateCommand();$q.CommandText=$sql;$q.CommandTimeout=15;try{return $q.ExecuteNonQuery()}finally{$q.Dispose()}}
function Hash([object]$x){$h=[Security.Cryptography.SHA256]::Create();try{return ([BitConverter]::ToString($h.ComputeHash([Text.Encoding]::UTF8.GetBytes(($x|ConvertTo-Json -Depth 12 -Compress))))).Replace('-','').ToLowerInvariant()}finally{$h.Dispose()}}
try{
 $p=[Console]::In.ReadToEnd()|ConvertFrom-Json
 if($p.scope -cne 'SCCRM-ADA-POINT-NATIVE-V1' -or $p.target.branch -cnotmatch '^(000|001|003|004|005)$'){throw 'POINT_NATIVE_SCOPE_REFUSED'}
 $t=$p.target;$branch=[string]$t.branch
 if($Mode -ceq 'Copy'){
  if($t.server -cne 'tcp:100.90.166.72,49800' -or $t.machine -cne 'SERVER' -or $t.database -cne ('SCCRM_PointCopy_20261102_'+$branch) -or $t.identity -cne ('copy'+$branch+'/SERVER/'+$t.database)){throw 'POINT_COPY_TARGET_REFUSED'}
 }else{
  $expected=@{'000'=@('tcp:100.90.166.72,49800','SERVER');'001'=@('tcp:100.81.137.41,49754','SC_001');'003'=@('tcp:100.77.101.94,49703','POSSRV');'004'=@('tcp:100.113.59.42,49976','SERVER004');'005'=@('tcp:100.106.107.80,49711','POSSRV')}
  if($t.server -cne $expected[$branch][0] -or $t.machine -cne $expected[$branch][1] -or $t.database -cne 'AdaAcc' -or $t.identity -cne ($branch+'/'+$t.machine+'/AdaAcc') -or $p.action -cnotin @('apply','rights')){throw 'POINT_LIVE_TARGET_REFUSED'}
  if($p.credentials.user -cne ('sccrm_point_sync_'+$branch)){throw 'POINT_LIVE_WORKER_LOGIN_REQUIRED'}
 }
 $builder=New-Object Data.SqlClient.SqlConnectionStringBuilder;$builder['Data Source']=$t.server;$builder['Initial Catalog']=$t.database;$builder['User ID']=$p.credentials.user;$builder['Password']=$p.credentials.password;$builder['Connect Timeout']=5;$builder['Pooling']=$false;$builder['Application Name']='SCCRM-PointSync-'+$Mode
 $stage='connect';$db=New-Object Data.SqlClient.SqlConnection $builder.ConnectionString;$db.Open();$builder['Password']='';$p.credentials.password=''
 $identity=Rows "SET DEADLOCK_PRIORITY LOW;SET LOCK_TIMEOUT 1000;SELECT CONVERT(varchar(128),SERVERPROPERTY('MachineName')) machine,DB_NAME() db"
 if($identity.Count -ne 1 -or $identity[0].machine -cne $t.machine -or $identity[0].db -cne $t.database){throw 'POINT_NATIVE_SERVER_REFUSED'}
 if($Mode -ceq 'Live'){
  $binding=Rows "SELECT CASE WHEN worker_login=ORIGINAL_LOGIN() AND worker_sid=SUSER_SID(ORIGINAL_LOGIN()) AND target_identity='$($t.identity)' AND branch_code='$branch' AND marker='238ecf14-fda8-46a8-bc34-d663659b2202' THEN 1 ELSE 0 END bound FROM dbo.SCCRM_PointSyncMeta WHERE singleton=1"
  if($binding.Count -ne 1 -or $binding[0].bound -ne 1){throw 'POINT_LIVE_WORKER_SID_REFUSED'}
  $permissions=(Rows "SELECT IS_SRVROLEMEMBER('sysadmin') sysadmin,IS_MEMBER('db_owner') db_owner,IS_MEMBER('db_datawriter') datawriter,HAS_PERMS_BY_NAME('dbo.TCNMCst','OBJECT','UPDATE') customer_update,HAS_PERMS_BY_NAME('dbo.TCNMCst','OBJECT','DELETE') customer_delete,HAS_PERMS_BY_NAME('dbo.TCNTCstPoint','OBJECT','INSERT') point_insert,HAS_PERMS_BY_NAME('dbo.TCNTCstPoint','OBJECT','UPDATE') point_update,HAS_PERMS_BY_NAME('dbo.TCNTCstPoint','OBJECT','DELETE') point_delete")[0]
  foreach($field in @('sysadmin','db_owner','datawriter','customer_update','customer_delete','point_insert','point_update','point_delete')){if($permissions.$field -ne 0){throw 'POINT_LIVE_WORKER_RIGHTS_EXCESSIVE'}}
 }
 $stage=[string]$p.action;$result=$null
 switch -CaseSensitive ($p.action){
  'upgrade-copy'{
   if($Mode -cne 'Copy'){throw 'POINT_COPY_ONLY'}
   $meta=Rows 'SELECT CONVERT(varchar(36),marker) marker,target_identity FROM dbo.SCCRM_PointSyncMeta WHERE singleton=1'
   if($meta.Count -ne 1 -or ([string]$meta[0].marker).ToLowerInvariant() -cne '238ecf14-fda8-46a8-bc34-d663659b2202' -or $meta[0].target_identity -cne $t.identity){throw 'POINT_COPY_MARKER_REFUSED'}
   $missing=Rows "SELECT COL_LENGTH('dbo.SCCRM_PointSyncReceipts','generation') generation,OBJECT_ID('dbo.SCCRM_PointSyncHeads') heads"
   if(($null -eq $missing[0].generation -or $null -eq $missing[0].heads) -and (Rows 'SELECT COUNT(*) n FROM dbo.SCCRM_PointSyncReceipts')[0].n -ne 0){throw 'POINT_COPY_ALREADY_ADVANCED'}
   $null=Run "IF COL_LENGTH('dbo.SCCRM_PointSyncReceipts','generation') IS NULL ALTER TABLE dbo.SCCRM_PointSyncReceipts ADD generation bigint NOT NULL;IF OBJECT_ID('dbo.SCCRM_PointSyncHeads') IS NULL CREATE TABLE dbo.SCCRM_PointSyncHeads(ada_code varchar(20) PRIMARY KEY,last_generation bigint NOT NULL,last_revision char(64) NOT NULL,last_target bigint NOT NULL,last_operation uniqueidentifier NOT NULL)"
   $sql=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'native-receiver.sql')).Replace('CREATE PROCEDURE','ALTER PROCEDURE').Replace('__DATABASE__',[string]$t.database).Replace('__BRANCH__',$branch).Replace('__IDENTITY__',[string]$t.identity)
   $null=Run $sql;$result=@{upgraded=$true}
  }
  'apply'{
   $j=$p.job
   if($j.adaCode -cnotmatch '^[A-Za-z0-9_-]{1,20}$' -or $j.projectionVersion -cnotmatch '^[a-f0-9]{64}$' -or $j.operationId -cnotmatch '^[a-f0-9-]{36}$' -or [string]$j.generation -cnotmatch '^[1-9][0-9]{0,15}$'){throw 'POINT_NATIVE_JOB_REFUSED'}
   $q=$db.CreateCommand();$q.CommandTimeout=10;$q.CommandType=[Data.CommandType]::StoredProcedure;$q.CommandText='dbo.SCCRM_ApplyPointProjection'
   $null=$q.Parameters.Add('@OperationId',[Data.SqlDbType]::UniqueIdentifier);$q.Parameters['@OperationId'].Value=[guid]$j.operationId
   $null=$q.Parameters.Add('@AdaCode',[Data.SqlDbType]::VarChar,20);$q.Parameters['@AdaCode'].Value=[string]$j.adaCode
   foreach($k in @('TargetBalance','Generation')){$null=$q.Parameters.Add('@'+$k,[Data.SqlDbType]::BigInt);$field=if($k -ceq 'TargetBalance'){'targetBalance'}else{'generation'};$q.Parameters['@'+$k].Value=[long]::Parse([string]$j.$field,[Globalization.CultureInfo]::InvariantCulture)}
   $null=$q.Parameters.Add('@ExpectedIntrinsicBalance',[Data.SqlDbType]::Float);$q.Parameters['@ExpectedIntrinsicBalance'].Value=[double]::Parse([string]$j.expectedIntrinsic,[Globalization.CultureInfo]::InvariantCulture)
   $null=$q.Parameters.Add('@Revision',[Data.SqlDbType]::Char,64);$q.Parameters['@Revision'].Value=[string]$j.projectionVersion
   $r=$null;try{$r=$q.ExecuteReader();if(-not $r.Read()){throw 'POINT_NATIVE_ACK_MISSING'};$ack=[ordered]@{};for($i=0;$i -lt $r.FieldCount;$i++){$ack[$r.GetName($i)]=[string]$r.GetValue($i)};if($r.Read()){throw 'POINT_NATIVE_ACK_MULTIPLE'};$result=$ack}finally{if($r){$r.Dispose()};$q.Dispose()}
  }
  'rights'{$result=(Rows "SELECT IS_SRVROLEMEMBER('sysadmin') sysadmin,HAS_DBACCESS('AdaAcc') live_access,HAS_PERMS_BY_NAME('dbo.TCNMCst','OBJECT','UPDATE') customer_update,HAS_PERMS_BY_NAME('dbo.TCNTCstPoint','OBJECT','INSERT') point_insert,HAS_PERMS_BY_NAME('dbo.SCCRM_ApplyPointProjection','OBJECT','EXECUTE') receiver_execute")[0]}
  'baseline'{
   if($Mode -cne 'Copy'){throw 'POINT_COPY_ONLY'}
   $cols=Rows "SELECT name FROM sys.columns WHERE object_id=OBJECT_ID('dbo.TCNMCst') AND name NOT LIKE '%pin%' AND name NOT LIKE '%password%' AND name NOT LIKE '%secret%' AND name NOT LIKE '%token%' ORDER BY column_id"
   if($cols.Count -ne 101){throw 'POINT_COPY_CUSTOMER_COLUMNS_REFUSED'}
   $names=@($cols|ForEach-Object{if($_.name -cnotmatch '^[A-Za-z0-9_]+$'){throw 'POINT_COPY_COLUMN_REFUSED'};'['+$_.name+']'})
   $customers=Rows ('SELECT '+($names -join ',')+' FROM dbo.TCNMCst ORDER BY FTCstCode')
   $originals=Rows "SELECT p.* FROM dbo.TCNTCstPoint p WHERE NOT EXISTS(SELECT 1 FROM dbo.SCCRM_PointSyncReceipts r WHERE r.branch_code=p.FTBchCode AND r.ada_code=p.FTCstCode AND r.ref_doc=p.FTPntRefDoc AND p.FTSplCode='') AND p.FTPntRefDoc NOT LIKE 'COPYPOINT-%' ORDER BY p.FTBchCode,p.FTCstCode,p.FTPntRefDoc,p.FTSplCode"
   $result=@{customerCount=$customers.Count;customerColumns=$cols.Count;customerHash=(Hash $customers);originalEvents=$originals.Count;originalEventHash=(Hash $originals);productionWrites=0;pinRead=$false}
  }
  'copy-race-event'{
   if($Mode -cne 'Copy' -or $p.adaCode -cne 'AR000-000017'){throw 'POINT_COPY_FIXTURE_REFUSED'}
   $null=Run "INSERT dbo.TCNTCstPoint(FTBchCode,FTCstCode,FTPntRefDoc,FTSplCode,FDPntDate,FCPntPointbyOne,FCPntAmtRcv,FNPntPoint,FNPntPointOld,FTPntExpired,FTPntStaPrcDoc,FTPntCardType,FTWhoIns) VALUES('$branch','AR000-000017','COPYPOINT-RACE','',GETDATE(),100,300,3,0,'N','N','1','SCCRM_COPY_TEST')";$result=@{added=$true}
  }
  default{throw 'POINT_NATIVE_ACTION_REFUSED'}
 }
 [ordered]@{ok=$true;mode=$Mode;branch=$branch;identity=$t.identity;result=$result}|ConvertTo-Json -Depth 15 -Compress
}catch{$e=$_.Exception.GetBaseException();$code=if($e.Message -cmatch '^(POINT_[A-Z_0-9]+)$'){$e.Message}else{'POINT_NATIVE_OPERATION_FAILED'};[ordered]@{ok=$false;code=$code;stage=$stage;sqlNumber=if($e -is [Data.SqlClient.SqlException]){$e.Number}else{$null}}|ConvertTo-Json -Compress;exit 1}
finally{if($db){$db.Dispose()};if($builder){$builder['Password']=''};if($p){$p.credentials.password=''}}
