[CmdletBinding()]
param([ValidateSet('Copy','Live')][string]$Mode='Copy')
$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.Encoding]::UTF8;[Console]::InputEncoding=[Text.Encoding]::UTF8
$db=$null;$workerDb=$null;$transaction=$null;$packet=$null;$builder=$null;$workerBuilder=$null
$marker='86bfa892-2f57-4f60-a3f8-10b90ab5c7a9'
function Scalar([string]$text){$q=$db.CreateCommand();$q.CommandTimeout=8;$q.CommandText=$text;if($transaction){$q.Transaction=$transaction};try{$v=$q.ExecuteScalar();if($v -is [DBNull]){return $null};return $v}finally{$q.Dispose()}}
function Run([string]$text){$q=$db.CreateCommand();$q.CommandTimeout=8;$q.CommandText=$text;if($transaction){$q.Transaction=$transaction};try{[void]$q.ExecuteNonQuery()}finally{$q.Dispose()}}
try{
 $packet=[Console]::In.ReadToEnd()|ConvertFrom-Json
 if($packet.scope -cne 'SCCRM-HQ-MEMBER-FANOUT-PROVISION' -or $packet.marker -cne $marker){throw 'SOURCE_PROVISION_PACKET_REFUSED'}
 $target=$packet.target;$login=[string]$packet.worker.login;$password=[string]$packet.worker.password
 if($target.machine -cne 'SERVER' -or $target.branch -cne '000' -or $target.server -notin @('tcp:100.90.166.72,49800','tcp:127.0.0.1,49800')){throw 'SOURCE_PROVISION_IDENTITY_REFUSED'}
 if($password -cnotmatch '^Sc![a-f0-9]{48,96}9A$'){throw 'SOURCE_CREDENTIAL_FORMAT_REFUSED'}
 if($Mode -ceq 'Live'){if($target.database -cne 'AdaAcc' -or $login -cne 'sccrm_member_fanout_source'){throw 'SOURCE_LIVE_SCOPE_REFUSED'}}
 else{if($target.database -cne 'SCCRM_FanoutCopy_20261029_000' -or $login -cnotmatch '^sccrm_member_fanout_source_copy_[a-f0-9]{8,16}$'){throw 'SOURCE_COPY_SCOPE_REFUSED'}}
 $builder=New-Object Data.SqlClient.SqlConnectionStringBuilder
 $builder['Data Source']=$target.server;$builder['Initial Catalog']=$target.database;$builder['User ID']=$packet.admin.user;$builder['Password']=$packet.admin.password;$builder['Connect Timeout']=5;$builder['Application Name']='SCCRM-Fanout-Source-Provision'
 $db=New-Object Data.SqlClient.SqlConnection $builder.ConnectionString;$db.Open();$builder['Password']='';$packet.admin.password=$null
 if((Scalar 'SELECT DB_NAME()') -cne $target.database -or (Scalar "SELECT CONVERT(nvarchar(128),SERVERPROPERTY('MachineName'))") -cne 'SERVER'){throw 'SOURCE_DATABASE_IDENTITY_REFUSED'}
 if($Mode -ceq 'Copy' -and (Scalar "SELECT LOWER(CONVERT(varchar(36),marker)) FROM dbo.SCCRM_FanoutCopyMeta WHERE branch_code='000' AND scope='SCCRM-FANOUT-COPY-LAB-20261029'") -cne 'fa35c153-6692-43b8-afd1-b102a119b002'){throw 'SOURCE_COPY_MARKER_REFUSED'}
 if(!(Scalar "SELECT OBJECT_ID('dbo.SCCRM_LiveMemberLink')")){throw 'SOURCE_CREATION_LOG_REQUIRED'}
 if($Mode -ceq 'Live' -and (Scalar "SELECT CONVERT(nvarchar(36),value) FROM sys.extended_properties WHERE class=1 AND major_id=OBJECT_ID('dbo.SCCRM_LiveMemberLink') AND name='SCCRM_LiveSyncMarker'") -cne 'ef76cc14-1b6b-49c9-8da7-1bfaea3dd92b'){throw 'SOURCE_CREATION_LOG_NOT_OWNED'}
 $exists=Scalar "SELECT OBJECT_ID('dbo.SCCRM_FanoutSource')"
 if($exists -and (Scalar 'SELECT marker FROM dbo.SCCRM_FanoutSource WHERE singleton=1') -cne $marker){throw 'SOURCE_OWNED_TABLE_COLLISION'}
 if($exists -and !(Scalar "SELECT COL_LENGTH('dbo.SCCRM_FanoutSource','worker_sid')")){throw 'SOURCE_BINDING_SCHEMA_REFUSED'}
 if(!$exists -and (Scalar "SELECT count(*) FROM sys.server_principals WHERE name='$login'") -ne 0){throw 'SOURCE_LOGIN_COLLISION'}
 $transaction=$db.BeginTransaction()
 Run "SET LOCK_TIMEOUT 1000;IF NOT EXISTS(SELECT 1 FROM sys.server_principals WHERE name='$login') CREATE LOGIN [$login] WITH PASSWORD='$password',CHECK_POLICY=ON,DEFAULT_DATABASE=[$($target.database)];IF OBJECT_ID('dbo.SCCRM_FanoutSource') IS NULL CREATE TABLE dbo.SCCRM_FanoutSource(singleton int NOT NULL PRIMARY KEY CHECK(singleton=1),marker varchar(36) NOT NULL,worker_login sysname NOT NULL,worker_sid varbinary(85) NOT NULL,database_name sysname NOT NULL,created_at datetime NOT NULL DEFAULT GETUTCDATE());IF NOT EXISTS(SELECT 1 FROM dbo.SCCRM_FanoutSource) INSERT dbo.SCCRM_FanoutSource(singleton,marker,worker_login,worker_sid,database_name) VALUES(1,'$marker','$login',SUSER_SID('$login'),'$($target.database)');"
 if((Scalar 'SELECT worker_login FROM dbo.SCCRM_FanoutSource WHERE singleton=1') -cne $login){throw 'SOURCE_LOGIN_BINDING_REFUSED'}
 if((Scalar "SELECT CASE WHEN worker_sid=SUSER_SID(worker_login) AND database_name=DB_NAME() THEN 1 ELSE 0 END FROM dbo.SCCRM_FanoutSource WHERE singleton=1") -ne 1){throw 'SOURCE_LOGIN_SID_REFUSED'}
 if((Scalar "SELECT count(*) FROM sys.database_principals WHERE name='$login' AND sid<>SUSER_SID('$login')") -ne 0){throw 'SOURCE_USER_SID_REFUSED'}
 Run "IF NOT EXISTS(SELECT 1 FROM sys.database_principals WHERE name='$login') CREATE USER [$login] FOR LOGIN [$login];GRANT CONNECT TO [$login];GRANT SELECT ON dbo.SCCRM_FanoutSource TO [$login];GRANT SELECT(member_id,ada_code,created_at,profile_name,profile_phone,profile_email) ON dbo.SCCRM_LiveMemberLink TO [$login];DENY INSERT,UPDATE,DELETE,ALTER ON dbo.SCCRM_LiveMemberLink TO [$login];DENY SELECT,INSERT,UPDATE,DELETE,ALTER ON dbo.TCNMCst TO [$login];"
 $transaction.Commit();$transaction.Dispose();$transaction=$null
 $workerBuilder=New-Object Data.SqlClient.SqlConnectionStringBuilder
 $workerBuilder['Data Source']=$target.server;$workerBuilder['Initial Catalog']=$target.database;$workerBuilder['User ID']=$login;$workerBuilder['Password']=$password;$workerBuilder['Connect Timeout']=5
 $workerDb=New-Object Data.SqlClient.SqlConnection $workerBuilder.ConnectionString;$workerDb.Open();$workerBuilder['Password']=''
 $q=$workerDb.CreateCommand();$q.CommandTimeout=5;$q.CommandText="SELECT IS_SRVROLEMEMBER('sysadmin'),IS_MEMBER('db_owner'),HAS_PERMS_BY_NAME('dbo.TCNMCst','OBJECT','SELECT'),HAS_PERMS_BY_NAME('dbo.TCNMCst','OBJECT','INSERT'),HAS_PERMS_BY_NAME('dbo.TCNMCst','OBJECT','UPDATE'),HAS_PERMS_BY_NAME('dbo.TCNMCst','OBJECT','DELETE'),HAS_PERMS_BY_NAME('dbo.SCCRM_LiveMemberLink','OBJECT','INSERT'),HAS_PERMS_BY_NAME('dbo.SCCRM_LiveMemberLink','OBJECT','UPDATE'),HAS_PERMS_BY_NAME('dbo.SCCRM_LiveMemberLink','OBJECT','DELETE')"
 $r=$q.ExecuteReader();try{if(!$r.Read()){throw 'SOURCE_RIGHTS_REFUSED'};for($i=0;$i -lt $r.FieldCount;$i++){if(!$r.IsDBNull($i) -and [int]$r.GetValue($i) -ne 0){throw 'SOURCE_RIGHTS_EXCESSIVE'}}}finally{$r.Dispose();$q.Dispose()}
 [ordered]@{ok=$true;mode=$Mode;database=$target.database;worker=$login;directCustomerAccess=$false;sourceCreates=$false;pinRead=$false}|ConvertTo-Json -Compress
}catch{if($transaction){try{$transaction.Rollback()}catch{}};$e=$_.Exception.GetBaseException();$code=if($e.Message -cmatch '^[A-Z][A-Z0-9_]{5,79}$'){$e.Message}else{'FANOUT_SOURCE_PROVISION_FAILED'};[ordered]@{ok=$false;code=$code;sqlNumber=$e.Number;detailsWithheld=$true}|ConvertTo-Json -Compress;exit 1}
finally{if($transaction){$transaction.Dispose()};if($db){$db.Dispose()};if($workerDb){$workerDb.Dispose()};if($builder){$builder['Password']=''};if($workerBuilder){$workerBuilder['Password']=''};$password=$null;$packet=$null}
