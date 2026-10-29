[CmdletBinding()]
param(
 [ValidateSet('Copy','Live')][string]$Mode='Copy',
 [string]$ApprovedTargetsFile
)
$ErrorActionPreference='Stop'
[Console]::InputEncoding=[Text.Encoding]::UTF8
[Console]::OutputEncoding=[Text.Encoding]::UTF8
$marker='86bfa892-2f57-4f60-a3f8-10b90ab5c7a9'
$db=$null;$workerDb=$null;$transaction=$null;$builder=$null;$workerBuilder=$null;$packet=$null
$stage='packet-validation'

function Refuse([string]$Code){throw $Code}
function Literal([string]$Value){return "N'"+$Value.Replace("'","''")+"'"}
function Command([string]$Text,[hashtable]$Parameters=@{}){
 $q=$db.CreateCommand();$q.CommandTimeout=8;$q.CommandText=$Text
 if($transaction){$q.Transaction=$transaction}
 foreach($key in $Parameters.Keys){$value=$Parameters[$key];if($null -eq $value){$value=[DBNull]::Value};$null=$q.Parameters.AddWithValue('@'+$key,$value)}
 return $q
}
function Scalar([string]$Text,[hashtable]$Parameters=@{}){
 $q=Command $Text $Parameters
 try{$value=$q.ExecuteScalar();if($value -is [DBNull]){return $null};return $value}finally{$q.Dispose()}
}
function Run([string]$Text,[hashtable]$Parameters=@{}){
 $q=Command $Text $Parameters
 try{$null=$q.ExecuteNonQuery()}finally{$q.Dispose()}
}
function Rows([string]$Text,[hashtable]$Parameters=@{}){
 $q=Command $Text $Parameters;$reader=$null;$rows=New-Object Collections.Generic.List[object]
 try{$reader=$q.ExecuteReader();while($reader.Read()){$row=[ordered]@{};for($i=0;$i -lt $reader.FieldCount;$i++){$value=if($reader.IsDBNull($i)){$null}else{$reader.GetValue($i)};$row[$reader.GetName($i)]=$value};$rows.Add([pscustomobject]$row)};return ,$rows.ToArray()}
 finally{if($reader){$reader.Dispose()};$q.Dispose()}
}

try{
 # Secrets enter through stdin, never through process arguments or output.
 $raw=[Console]::In.ReadToEnd()
 if($raw.Length -gt 32768){Refuse 'FANOUT_PROVISION_PACKET_TOO_LARGE'}
 $packet=$raw|ConvertFrom-Json;$raw=$null
 if($packet.scope -cne 'SCCRM-HQ-MEMBER-FANOUT-PROVISION' -or $packet.marker -cne $marker){Refuse 'FANOUT_PROVISION_PACKET_REFUSED'}
 $target=$packet.target
 if(!$target -or ([string]$target.identity) -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._:/@-]{1,159}$' -or
  ([string]$target.machine) -cnotmatch '^[A-Za-z0-9_-]{1,128}$' -or
  ([string]$target.branch) -cnotmatch '^(000|001|003|004|005)$' -or
  ([string]$target.database) -cnotmatch '^[A-Za-z0-9_]{1,128}$' -or
  ([string]$target.server).Length -gt 250 -or
  ([string]$target.server) -cnotmatch '^(tcp:)?(127\.0\.0\.1|100\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3})(,[0-9]{1,5}|\\[A-Za-z0-9_]{1,64})$'){
  Refuse 'FANOUT_TARGET_PACKET_REFUSED'
 }
 $branch=[string]$target.branch;$database=[string]$target.database
 $machine=[string]$target.machine;$identity=[string]$target.identity
 $login=[string]$packet.worker.login;$password=[string]$packet.worker.password
 if($password -cnotmatch '^Sc![a-f0-9]{48,96}9A$'){Refuse 'FANOUT_WORKER_CREDENTIAL_FORMAT_REFUSED'}
 if($Mode -ceq 'Copy'){
  if($database -cne ('SCCRM_FanoutCopy_20261029_'+$branch) -or
   $login -cnotmatch ('^sccrm_member_fanout_'+$branch+'_copy_[a-f0-9]{8,16}$')){Refuse 'FANOUT_COPY_SCOPE_REFUSED'}
 }else{
  if($branch -ceq '000' -or $database -cne 'AdaAcc' -or $login -cne ('sccrm_member_fanout_'+$branch) -or
   !$ApprovedTargetsFile -or !(Test-Path -LiteralPath $ApprovedTargetsFile)){Refuse 'FANOUT_LIVE_APPROVAL_REQUIRED'}
  $approved=Get-Content -LiteralPath $ApprovedTargetsFile -Raw|ConvertFrom-Json
  if($approved.scope -cne 'SCCRM-HQ-MEMBER-FANOUT-TARGETS' -or $approved.marker -cne $marker){Refuse 'FANOUT_TARGET_ALLOWLIST_REFUSED'}
  $matches=@($approved.targets|Where-Object{
   $_.identity -ceq $identity -and $_.server -ceq $target.server -and $_.machine -ceq $machine -and
   $_.database -ceq $database -and $_.branch -ceq $branch -and $_.allowProvision -eq $true
  })
  if($matches.Count -ne 1){Refuse 'FANOUT_TARGET_NOT_EXPLICITLY_APPROVED'}
  if($branch -cne '005' -and $matches[0].productionApproved -ne $true){Refuse 'FANOUT_NONPILOT_APPROVAL_REQUIRED'}
 }
 if(!([string]$packet.admin.user) -or !([string]$packet.admin.password)){Refuse 'FANOUT_BOOTSTRAP_CREDENTIAL_REQUIRED'}
 $builder=New-Object Data.SqlClient.SqlConnectionStringBuilder
 $builder['Data Source']=[string]$target.server;$builder['Initial Catalog']=$database
 $builder['User ID']=[string]$packet.admin.user;$builder['Password']=[string]$packet.admin.password
 $builder['Connect Timeout']=5;$builder['Application Name']='SCCRM-Fanout-Owned-Receiver-Provision'
 $db=New-Object Data.SqlClient.SqlConnection $builder.ConnectionString;$db.Open();$builder['Password']=''
 $stage='native-preflight'
 $actual=Rows "SELECT CONVERT(nvarchar(128),SERVERPROPERTY('MachineName')) machine,DB_NAME() db"
 if($actual.Count -ne 1 -or $actual[0].machine -cne $machine -or $actual[0].db -cne $database){Refuse 'FANOUT_SQL_IDENTITY_REFUSED'}
 Run 'SET LOCK_TIMEOUT 1000; SET DEADLOCK_PRIORITY LOW;'
 if($Mode -ceq 'Copy'){
  if(!(Scalar "SELECT OBJECT_ID('dbo.SCCRM_FanoutCopyMeta','U')")){Refuse 'FANOUT_COPY_MARKER_REQUIRED'}
  $copy=Rows 'SELECT LOWER(CONVERT(varchar(36),marker)) marker,scope,branch_code FROM dbo.SCCRM_FanoutCopyMeta'
  if($copy.Count -ne 1 -or $copy[0].marker -cne 'fa35c153-6692-43b8-afd1-b102a119b002' -or
   $copy[0].scope -cne 'SCCRM-FANOUT-COPY-LAB-20261029' -or $copy[0].branch_code -cne $branch){Refuse 'FANOUT_COPY_MARKER_REFUSED'}
 }

 # Native compatibility checks read metadata only and never read a PIN value.
 $needed=@('FTCstCode','FTCstName','FTCstTel','FTCstEmail','FTBchCode','FTCstStaActive','FDCstCrdIssue','FDCstCrdExpire','FCCstRetPoint','FCCstRetAmt','FCCstWhsPoint','FCCstDailyPoint','FDDateIns','FTTimeIns','FTWhoIns','FDDateUpd','FTTimeUpd','FTWhoUpd')
 $columns=Rows "SELECT c.name,c.max_length,t.name type_name FROM sys.columns c JOIN sys.types t ON t.user_type_id=c.user_type_id WHERE c.object_id=OBJECT_ID('dbo.TCNMCst','U') AND c.name<>('FTCst'+'Pin')"
 foreach($name in $needed){if(@($columns|Where-Object{$_.name -ceq $name}).Count -ne 1){Refuse 'FANOUT_NATIVE_SCHEMA_UNSUPPORTED'}}
 foreach($pair in @(@('FTCstCode',19),@('FTCstName',200),@('FTCstTel',10),@('FTCstEmail',100),@('FTBchCode',3),@('FTCstStaActive',1),@('FTWhoIns',19),@('FTWhoUpd',19))){
  $column=@($columns|Where-Object{$_.name -ceq $pair[0]})[0]
  if($column.type_name -cne 'varchar' -or ($column.max_length -ne -1 -and $column.max_length -lt $pair[1])){Refuse 'FANOUT_NATIVE_TEXT_SCHEMA_UNSUPPORTED'}
 }
 foreach($name in @('FDCstCrdIssue','FDCstCrdExpire')){
  $column=@($columns|Where-Object{$_.name -ceq $name})[0]
  if($column.type_name -cne 'datetime' -or $column.max_length -ne 8){Refuse 'FANOUT_NATIVE_CARD_DATE_SCHEMA_UNSUPPORTED'}
 }
 if((Scalar "SELECT COUNT(*) FROM sys.indexes i WHERE i.object_id=OBJECT_ID('dbo.TCNMCst') AND i.is_unique=1 AND i.is_disabled=0 AND EXISTS(SELECT 1 FROM sys.index_columns ic JOIN sys.columns c ON c.object_id=ic.object_id AND c.column_id=ic.column_id WHERE ic.object_id=i.object_id AND ic.index_id=i.index_id AND ic.key_ordinal=1 AND c.name='FTCstCode') AND NOT EXISTS(SELECT 1 FROM sys.index_columns ic WHERE ic.object_id=i.object_id AND ic.index_id=i.index_id AND ic.key_ordinal>1)") -lt 1){Refuse 'FANOUT_NATIVE_CODE_UNIQUENESS_REQUIRED'}
 if((Scalar "SELECT COUNT(*) FROM sys.triggers WHERE parent_id=OBJECT_ID('dbo.TCNMCst') AND is_disabled=0") -gt 0){Refuse 'FANOUT_NATIVE_TRIGGER_REVIEW_REQUIRED'}
 if((Scalar "SELECT USER_NAME(COALESCE(o.principal_id,s.principal_id)) FROM sys.objects o JOIN sys.schemas s ON s.schema_id=o.schema_id WHERE o.object_id=OBJECT_ID('dbo.TCNMCst')") -cne 'dbo'){Refuse 'FANOUT_NATIVE_OWNER_REVIEW_REQUIRED'}
 $nativeBefore=[int](Scalar 'SELECT COUNT(*) FROM dbo.TCNMCst')

 $transaction=$db.BeginTransaction()
 $stage='owned-objects-and-login'
 $lock=[int](Scalar "DECLARE @r int;EXEC @r=sys.sp_getapplock @Resource='SCCRM_FanoutReceiverProvision',@LockMode='Exclusive',@LockOwner='Transaction',@LockTimeout=1000;SELECT @r")
 if($lock -lt 0){Refuse 'FANOUT_PROVISION_BUSY'}
 $objects=@(@('SCCRM_FanoutTarget','U'),@('SCCRM_FanoutMemberLink','U'),@('SCCRM_ReceiveMemberFromHq','P'))
 $present=0
 foreach($object in $objects){
  $id=Scalar 'SELECT OBJECT_ID(@name)' @{name='dbo.'+$object[0]}
  if($null -ne $id){
   if($null -eq (Scalar 'SELECT OBJECT_ID(@name,@kind)' @{name='dbo.'+$object[0];kind=$object[1]})){Refuse 'FANOUT_OWNED_OBJECT_TYPE_COLLISION'}
   $ownMarker=Scalar "SELECT CONVERT(nvarchar(36),value) FROM sys.extended_properties WHERE class=1 AND major_id=OBJECT_ID(@name) AND name='SCCRM_FanoutMarker'" @{name='dbo.'+$object[0]}
   if($ownMarker -cne $marker){Refuse 'FANOUT_UNOWNED_OBJECT_COLLISION'}
   $present++
  }
 }
 if($present -ne 0 -and $present -ne 3){Refuse 'FANOUT_PARTIAL_TARGET_REVIEW'}
 $loginExists=[int](Scalar 'SELECT COUNT(*) FROM sys.server_principals WHERE name=@login' @{login=$login})
 $userExists=[int](Scalar 'SELECT COUNT(*) FROM sys.database_principals WHERE name=@login' @{login=$login})
 if($present -eq 0 -and ($loginExists -gt 0 -or $userExists -gt 0)){Refuse 'FANOUT_UNOWNED_LOGIN_COLLISION'}
 if($present -eq 3){
  $old=Rows 'SELECT singleton,LOWER(CONVERT(varchar(36),marker)) marker,target_identity,database_name,machine_name,branch_code,worker_login,CASE WHEN worker_sid=SUSER_SID(@login) THEN 1 ELSE 0 END sid_matches,schema_version FROM dbo.SCCRM_FanoutTarget' @{login=$login}
  if($old.Count -ne 1 -or $old[0].singleton -ne 1 -or $old[0].marker -cne $marker -or
   $old[0].target_identity -cne $identity -or $old[0].database_name -cne $database -or
   $old[0].machine_name -cne $machine -or $old[0].branch_code -cne $branch -or
   $old[0].worker_login -cne $login -or $old[0].sid_matches -ne 1 -or
   $old[0].schema_version -ne 1 -or $loginExists -ne 1 -or $userExists -ne 1){Refuse 'FANOUT_EXISTING_TARGET_IDENTITY_CHANGED'}
 }
 if($present -eq 0){
  Run ("CREATE LOGIN ["+$login+"] WITH PASSWORD='"+$password+"',CHECK_POLICY=ON,CHECK_EXPIRATION=OFF,DEFAULT_DATABASE=["+$database+"]")
  Run ("CREATE USER ["+$login+"] FOR LOGIN ["+$login+"]")
  Run @'
CREATE TABLE dbo.SCCRM_FanoutTarget(
 singleton tinyint NOT NULL PRIMARY KEY CHECK(singleton=1),marker uniqueidentifier NOT NULL,
 target_identity varchar(160) NOT NULL UNIQUE,database_name nvarchar(128) NOT NULL,
 machine_name nvarchar(128) NOT NULL,branch_code varchar(3) NOT NULL,
 worker_login sysname NOT NULL,worker_sid varbinary(85) NOT NULL,schema_version int NOT NULL,
 created_at datetime NOT NULL
);
CREATE TABLE dbo.SCCRM_FanoutMemberLink(
 member_id uniqueidentifier NOT NULL PRIMARY KEY,hq_code varchar(20) NOT NULL UNIQUE,
 ada_code varchar(20) NOT NULL UNIQUE,target_identity varchar(160) NOT NULL,
 profile_name nvarchar(200) NOT NULL,profile_phone varchar(30) NOT NULL,
 profile_email nvarchar(100) NOT NULL,profile_hash varchar(64) NOT NULL,
 received_at datetime NOT NULL
);
'@
  Run 'INSERT dbo.SCCRM_FanoutTarget(singleton,marker,target_identity,database_name,machine_name,branch_code,worker_login,worker_sid,schema_version,created_at) VALUES(1,@marker,@identity,@database,@machine,@branch,@login,SUSER_SID(@login),1,GETUTCDATE())' @{marker=[guid]$marker;identity=$identity;database=$database;machine=$machine;branch=$branch;login=$login}
 }
 $procedure=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'Receiver.sql'))
 $copyGuard=''
 if($Mode -ceq 'Copy'){$copyGuard="IF (SELECT COUNT(*) FROM dbo.SCCRM_FanoutCopyMeta)<>1 OR NOT EXISTS(SELECT 1 FROM dbo.SCCRM_FanoutCopyMeta WHERE marker='fa35c153-6692-43b8-afd1-b102a119b002' AND scope='SCCRM-FANOUT-COPY-LAB-20261029' AND branch_code='$branch') BEGIN RAISERROR('FANOUT_COPY_MARKER_REFUSED',16,1);RETURN;END;"}
 $procedure=$procedure.Replace('__COPY_GUARD__',$copyGuard)
 $procedure=$procedure.Replace('__DATABASE__',$database.Replace("'","''")).Replace('__MACHINE__',$machine.Replace("'","''")).Replace('__TARGET_BRANCH__',$branch).Replace('__TARGET_IDENTITY__',$identity.Replace("'","''"))
 if($procedure -match '__[A-Z_]+__'){Refuse 'FANOUT_RECEIVER_TEMPLATE_INCOMPLETE'}
 if($present -eq 3){$procedure=$procedure.Replace('CREATE PROCEDURE','ALTER PROCEDURE')}
 Run $procedure
 if($present -eq 0){foreach($object in $objects){$kind=if($object[1] -ceq 'P'){'PROCEDURE'}else{'TABLE'};Run "EXEC sys.sp_addextendedproperty @name='SCCRM_FanoutMarker',@value=@marker,@level0type='SCHEMA',@level0name='dbo',@level1type=@kind,@level1name=@object" @{marker=$marker;kind=$kind;object=$object[0]}}}

 $quoted='['+$login+']'
 $stage='runtime-database-permissions'
 Run ("GRANT CONNECT TO "+$quoted+"; GRANT EXECUTE ON dbo.SCCRM_ReceiveMemberFromHq TO "+$quoted+"; GRANT VIEW DEFINITION ON dbo.SCCRM_FanoutTarget TO "+$quoted+"; DENY SELECT,INSERT,UPDATE,DELETE,ALTER ON dbo.TCNMCst TO "+$quoted+"; DENY SELECT,INSERT,UPDATE,DELETE,ALTER ON dbo.SCCRM_FanoutMemberLink TO "+$quoted+"; DENY SELECT,INSERT,UPDATE,DELETE,ALTER ON dbo.SCCRM_FanoutTarget TO "+$quoted+"; DENY ALTER ON dbo.SCCRM_ReceiveMemberFromHq TO "+$quoted+"; DENY ALTER ANY SCHEMA TO "+$quoted+"; DENY CREATE TABLE,CREATE PROCEDURE,CREATE FUNCTION,CREATE VIEW TO "+$quoted+";")
 # CopyLab intentionally omits the PIN column entirely. Do not create or copy
 # one merely to deny it. Live Ada retains the explicit column-level denial.
 if((Scalar "SELECT COUNT(*) FROM sys.columns WHERE object_id=OBJECT_ID('dbo.TCNMCst') AND name=('FTCst'+'Pin')") -gt 0){Run ("DENY SELECT ON dbo.TCNMCst(FTCstPin) TO "+$quoted)}
 foreach($role in @('sysadmin','securityadmin','serveradmin','setupadmin','processadmin','diskadmin','dbcreator','bulkadmin')){if((Scalar 'SELECT IS_SRVROLEMEMBER(@role,@login)' @{role=$role;login=$login}) -ne 0){Refuse 'FANOUT_WORKER_SERVER_RIGHTS_EXCESSIVE'}}
 if((Scalar "SELECT IS_ROLEMEMBER('db_owner',@login)" @{login=$login}) -ne 0 -or (Scalar "SELECT IS_ROLEMEMBER('db_datawriter',@login)" @{login=$login}) -ne 0){Refuse 'FANOUT_WORKER_DATABASE_RIGHTS_EXCESSIVE'}
 $permissionSql="SELECT COALESCE(HAS_PERMS_BY_NAME('dbo.TCNMCst','OBJECT','SELECT'),0) native_select,COALESCE(HAS_PERMS_BY_NAME('dbo.TCNMCst','OBJECT','INSERT'),0) native_insert,COALESCE(HAS_PERMS_BY_NAME('dbo.TCNMCst','OBJECT','UPDATE'),0) native_update,COALESCE(HAS_PERMS_BY_NAME('dbo.TCNMCst','OBJECT','DELETE'),0) native_delete,COALESCE(HAS_PERMS_BY_NAME('dbo.TCNMCst','OBJECT','ALTER'),0) native_alter,COALESCE(HAS_PERMS_BY_NAME('dbo.TCNMCst','OBJECT','SELECT','FTCstPin','COLUMN'),0) pin_select,COALESCE(HAS_PERMS_BY_NAME('dbo.SCCRM_FanoutMemberLink','OBJECT','UPDATE'),0) link_update,COALESCE(HAS_PERMS_BY_NAME('dbo.SCCRM_FanoutTarget','OBJECT','UPDATE'),0) target_update,COALESCE(HAS_PERMS_BY_NAME('dbo.SCCRM_ReceiveMemberFromHq','OBJECT','EXECUTE'),0) receiver_execute"
 $rights=Rows ("BEGIN TRY EXECUTE AS USER="+(Literal $login)+";"+$permissionSql+";REVERT;END TRY BEGIN CATCH REVERT;RAISERROR('FANOUT_RIGHTS_CHECK_FAILED',16,1);END CATCH;")
 if($rights.Count -ne 1){Refuse 'FANOUT_WORKER_RIGHTS_UNAVAILABLE'}
 foreach($property in $rights[0].PSObject.Properties){$expected=if($property.Name -ceq 'receiver_execute'){1}else{0};if($property.Value -ne $expected){Refuse 'FANOUT_WORKER_RIGHTS_EXCESSIVE'}}
 $transaction.Commit();$transaction.Dispose();$transaction=$null
 $stage='actual-runtime-login-verification'
 $nativeAfter=[int](Scalar 'SELECT COUNT(*) FROM dbo.TCNMCst')

 # Verify the resulting actual login. This query only inspects permissions.
 $workerBuilder=New-Object Data.SqlClient.SqlConnectionStringBuilder
 $workerBuilder['Data Source']=[string]$target.server;$workerBuilder['Initial Catalog']=$database
 $workerBuilder['User ID']=$login;$workerBuilder['Password']=$password
 $workerBuilder['Connect Timeout']=5;$workerBuilder['Application Name']='SCCRM-Fanout-Receiver-Permission-Check'
 $workerDb=New-Object Data.SqlClient.SqlConnection $workerBuilder.ConnectionString;$workerDb.Open();$workerBuilder['Password']=''
 $q=$workerDb.CreateCommand();$q.CommandTimeout=5;$q.CommandText="SELECT ORIGINAL_LOGIN() actor,IS_SRVROLEMEMBER('sysadmin') elevated,IS_MEMBER('db_owner') db_owner,IS_MEMBER('db_datawriter') db_writer;"+$permissionSql
 $reader=$q.ExecuteReader()
 try{
  if(!$reader.Read() -or $reader.GetString(0) -cne $login -or $reader.GetInt32(1) -ne 0 -or $reader.GetInt32(2) -ne 0 -or $reader.GetInt32(3) -ne 0){Refuse 'FANOUT_ACTUAL_LOGIN_RIGHTS_EXCESSIVE'}
  if(!$reader.NextResult() -or !$reader.Read()){Refuse 'FANOUT_ACTUAL_LOGIN_RIGHTS_UNAVAILABLE'}
  for($i=0;$i -lt $reader.FieldCount;$i++){$expected=if($reader.GetName($i) -ceq 'receiver_execute'){1}else{0};if([int]$reader.GetValue($i) -ne $expected){Refuse 'FANOUT_ACTUAL_LOGIN_RIGHTS_EXCESSIVE'}}
 }finally{$reader.Dispose();$q.Dispose()}
 [Console]::WriteLine(([ordered]@{ok=$true;mode=$Mode;marker=$marker;targetIdentity=$identity;branch=$branch;machine=$machine;database=$database;workerLogin=$login;receiver='dbo.SCCRM_ReceiveMemberFromHq';ownedObjects=@('SCCRM_FanoutTarget','SCCRM_FanoutMemberLink','SCCRM_ReceiveMemberFromHq');customerRowsWritten=0;customerCountBefore=$nativeBefore;customerCountAfter=$nativeAfter;pinRead=$false;runtimeRights=$rights[0]}|ConvertTo-Json -Depth 5 -Compress))
}catch{
 if($transaction){try{$transaction.Rollback()}catch{};try{$transaction.Dispose()}catch{};$transaction=$null}
 $provisionError=$_.Exception.GetBaseException();$code=if($provisionError.Message -cmatch '^[A-Z_]{6,100}$'){$provisionError.Message}else{'FANOUT_RECEIVER_PROVISION_FAILED'}
 [Console]::WriteLine(([ordered]@{ok=$false;mode=$Mode;stage=$stage;code=$code;type=$provisionError.GetType().Name;sqlNumber=if($provisionError -is [Data.SqlClient.SqlException]){$provisionError.Number}else{$null};detailsWithheld=$true;pinRead=$false}|ConvertTo-Json -Compress));exit 1
}finally{
 if($transaction){$transaction.Dispose()};if($workerDb){$workerDb.Dispose()};if($db){$db.Dispose()}
 if($builder){$builder['Password']=''};if($workerBuilder){$workerBuilder['Password']=''}
 $packet=$null;$password=$null;$raw=$null;$target=$null
}
