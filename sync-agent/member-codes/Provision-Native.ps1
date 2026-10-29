[CmdletBinding()]
param([ValidateSet('Copy','Live')][string]$Mode='Copy',[string]$ApprovedTargetsFile,[switch]$PlanOnly)
# Explicit operator entry point. Runtime services never import this script.
# All credentials/private cohort profiles enter via stdin, never command args.
$ErrorActionPreference='Stop'
[Console]::InputEncoding=[Text.Encoding]::UTF8;[Console]::OutputEncoding=[Text.Encoding]::UTF8
$marker='64fa3170-80ae-45ee-b9f3-7478b2a46e34';$scope='SCCRM-HQ-MEMBER-CODES-V1'
$db=$null;$transaction=$null;$packet=$null;$builder=$null;$stage='packet'
function Refuse([string]$Code){throw $Code}
function Q([string]$Sql,[hashtable]$Parameters=@{}){
 $q=$db.CreateCommand();$q.CommandTimeout=8;$q.CommandText=$Sql;if($transaction){$q.Transaction=$transaction}
 foreach($key in $Parameters.Keys){$value=$Parameters[$key];if($null -eq $value){$value=[DBNull]::Value};if($key -in @('phone','code','identity','hq','hash')){$p=$q.Parameters.Add('@'+$key,[Data.SqlDbType]::VarChar,160);$p.Value=$value}else{$null=$q.Parameters.AddWithValue('@'+$key,$value)}};return $q
}
function Run([string]$Sql,[hashtable]$Parameters=@{}){$q=Q $Sql $Parameters;try{$null=$q.ExecuteNonQuery()}finally{$q.Dispose()}}
function Scalar([string]$Sql,[hashtable]$Parameters=@{}){$q=Q $Sql $Parameters;try{$v=$q.ExecuteScalar();if($v -is [DBNull]){return $null};return $v}finally{$q.Dispose()}}
function Rows([string]$Sql,[hashtable]$Parameters=@{}){
 $q=Q $Sql $Parameters;$r=$null;$rows=@();try{$r=$q.ExecuteReader();while($r.Read()){$row=[ordered]@{};for($i=0;$i -lt $r.FieldCount;$i++){$row[$r.GetName($i)]=if($r.IsDBNull($i)){$null}else{$r.GetValue($i)}};$rows+=,[pscustomobject]$row};return ,$rows}finally{if($r){$r.Dispose()};$q.Dispose()}
}
function Ident([string]$Value){if($Value -cnotmatch '^[A-Za-z_][A-Za-z0-9_]{0,127}$'){Refuse 'MEMBER_CODES_SQL_IDENTIFIER_REFUSED'};return '['+$Value+']'}
function Lit([string]$Value){return "N'"+$Value.Replace("'","''")+"'"}
function Hash([string]$Value){$sha=[Security.Cryptography.SHA256]::Create();try{return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Value)))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}}
function Ensure-Login($Credential,[bool]$ExistingOnly){
 $login=[string]$Credential.login;$found=[int](Scalar 'SELECT COUNT(*) FROM sys.server_principals WHERE name=@login' @{login=$login})
 $user=[int](Scalar 'SELECT COUNT(*) FROM sys.database_principals WHERE name=@login' @{login=$login})
 if($ExistingOnly){if($found -ne 1 -or $user -ne 1){Refuse 'MEMBER_CODES_EXISTING_ACTOR_REQUIRED'}}
 elseif($found -eq 0 -and $user -eq 0){
  Run ('CREATE LOGIN '+(Ident $login)+" WITH PASSWORD='"+[string]$Credential.password+"',CHECK_POLICY=ON,CHECK_EXPIRATION=OFF,DEFAULT_DATABASE="+(Ident $database))
  Run ('CREATE USER '+(Ident $login)+' FOR LOGIN '+(Ident $login))
 }elseif($found -ne 1 -or $user -ne 1 -or !$existingScope){Refuse 'MEMBER_CODES_UNOWNED_ACTOR_COLLISION'}
 if((Scalar 'SELECT CASE WHEN sid=SUSER_SID(@login) THEN 1 ELSE 0 END FROM sys.database_principals WHERE name=@login' @{login=$login}) -ne 1){Refuse 'MEMBER_CODES_ACTOR_SID_CHANGED'}
 foreach($serverRole in @('sysadmin','securityadmin','serveradmin','setupadmin','processadmin','diskadmin','dbcreator','bulkadmin')){if((Scalar 'SELECT IS_SRVROLEMEMBER(@role,@login)' @{role=$serverRole;login=$login}) -ne 0){Refuse 'MEMBER_CODES_ACTOR_EXCESSIVE_RIGHTS'}}
 foreach($databaseRole in @('db_owner','db_datawriter','db_datareader')){if((Scalar 'SELECT IS_ROLEMEMBER(@role,@login)' @{role=$databaseRole;login=$login}) -ne 0){Refuse 'MEMBER_CODES_ACTOR_EXCESSIVE_RIGHTS'}}
 Run ('GRANT CONNECT TO '+(Ident $login))
}
try{
 $raw=[Console]::In.ReadToEnd();if($raw.Length -gt 65536){Refuse 'MEMBER_CODES_PACKET_TOO_LARGE'};$packet=$raw|ConvertFrom-Json;$raw=$null
 if($packet.scope -cne $scope -or $packet.marker -cne $marker){Refuse 'MEMBER_CODES_PROVISION_PACKET_REFUSED'}
 $target=$packet.target;$branch=[string]$target.branch;$role=[string]$target.role;$database=[string]$target.database;$machine=[string]$target.machine;$identity=[string]$target.identity;$hqIdentity=[string]$packet.hqIdentity
 if($branch -cnotmatch '^(000|001|003|004|005)$' -or $role -cnotmatch '^(hq|branch)$' -or (($role -ceq 'hq') -ne ($branch -ceq '000')) -or
  $database -cnotmatch '^[A-Za-z0-9_]{1,128}$' -or $machine -cnotmatch '^[A-Za-z0-9_-]{1,128}$' -or
  $identity -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._:/@-]{1,159}$' -or $hqIdentity -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._:/@-]{1,159}$' -or
  ([string]$target.server) -cnotmatch '^(tcp:)?100\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}(,[0-9]{1,5}|\\[A-Za-z0-9_]{1,64})$'){Refuse 'MEMBER_CODES_TARGET_PACKET_REFUSED'}
 $runtime=$packet.runtime;$authority=$packet.authority;$creator=$packet.creator
 if($Mode -ceq 'Copy'){
  if($database -cne ('SCCRM_FanoutCopy_20261029_'+$branch) -or $machine -cne 'SERVER' -or $target.server -cne 'tcp:100.90.166.72,49800' -or
   $hqIdentity -cne ('copy000/SERVER.SQLEXPRESS/SCCRM_FanoutCopy_20261029_000/'+$marker)){Refuse 'MEMBER_CODES_COPY_SCOPE_REFUSED'}
  $runtimePattern=if($role -ceq 'hq'){'^sccrm_member_codes_source_copy_[a-f0-9]{8,16}$'}else{'^sccrm_member_fanout_'+$branch+'_copy_[a-f0-9]{8,16}$'}
  $authorityPattern='^sccrm_member_code_authority_'+$branch+'_copy_[a-f0-9]{8,16}$'
  if($role -ceq 'hq' -and ([string]$creator.login) -cnotmatch '^sccrm_member_codes_creator_copy_[a-f0-9]{8,16}$'){Refuse 'MEMBER_CODES_COPY_CREATOR_REFUSED'}
 }else{
  $expectedHq='hq000/SERVER.SQLEXPRESS/AdaAcc/'+$marker
  if($database -cne 'AdaAcc' -or $hqIdentity -cne $expectedHq -or !$ApprovedTargetsFile){Refuse 'MEMBER_CODES_LIVE_ALLOWLIST_REQUIRED'}
  $approved=Get-Content -LiteralPath $ApprovedTargetsFile -Raw|ConvertFrom-Json
  if($approved.scope -cne $scope -or $approved.marker -cne $marker){Refuse 'MEMBER_CODES_LIVE_ALLOWLIST_REFUSED'}
  $selected=@($approved.targets|Where-Object{$_.branch -ceq $branch -and $_.role -ceq $role -and $_.identity -ceq $identity -and $_.server -ceq $target.server -and $_.machine -ceq $machine -and $_.database -ceq $database -and $_.allowProvision -eq $true})
  if($selected.Count -ne 1){Refuse 'MEMBER_CODES_TARGET_NOT_APPROVED'}
  $runtimePattern=if($role -ceq 'hq'){'^sccrm_member_codes_source$'}else{'^sccrm_member_fanout_'+$branch+'$'}
  $authorityPattern='^sccrm_member_code_authority_'+$branch+'$'
  if($role -ceq 'hq' -and ([string]$creator.login) -cne 'sccrm_hq_member_sync'){Refuse 'MEMBER_CODES_LIVE_CREATOR_REFUSED'}
 }
 if(($role -ceq 'hq' -and $identity -cne $hqIdentity) -or ([string]$runtime.login) -cnotmatch $runtimePattern -or ([string]$authority.login) -cnotmatch $authorityPattern){Refuse 'MEMBER_CODES_ROLE_SCOPE_REFUSED'}
 $newCredentials=@($authority);if($role -ceq 'hq'){$newCredentials+=@($runtime);if($Mode -ceq 'Copy'){$newCredentials+=@($creator)}}
 foreach($credential in $newCredentials){
  if(([string]$credential.password) -cnotmatch '^Sc![a-f0-9]{48,96}9A$'){Refuse 'MEMBER_CODES_CREDENTIAL_FORMAT_REFUSED'}
 }
 $cohort=@($packet.cohort);if(!$packet.cohort){$cohort=@()};$maxCohort=if($Mode -ceq 'Copy'){20}else{2}
 if($cohort.Count -gt $maxCohort){Refuse 'MEMBER_CODES_COHORT_LIMIT_REFUSED'};$seen=@{}
 foreach($member in $cohort){
  $id=[string]$member.memberId
  if($id -cnotmatch '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' -or $seen.ContainsKey($id) -or
   $member.previousCode -cne ('SC-'+$id.Replace('-','').Substring(0,16).ToUpperInvariant()) -or
   !([string]$member.name).Trim() -or ([string]$member.name).Length -gt 200 -or ([string]$member.phone) -cnotmatch '^0[0-9]{9}$' -or ([string]$member.email).Length -gt 100){Refuse 'MEMBER_CODES_COHORT_IDENTITY_REFUSED'};$seen[$id]=$true
 }
 if(!$packet.admin.user -or !$packet.admin.password){Refuse 'MEMBER_CODES_ADMIN_REQUIRED'}
 $builder=New-Object Data.SqlClient.SqlConnectionStringBuilder;$builder['Data Source']=[string]$target.server;$builder['Initial Catalog']=$database;$builder['User ID']=[string]$packet.admin.user;$builder['Password']=[string]$packet.admin.password;$builder['Connect Timeout']=5;$builder['Application Name']='SCCRM-MemberCodes-Owned-Provision';$builder['Pooling']=$false
 $db=New-Object Data.SqlClient.SqlConnection $builder.ConnectionString;$db.Open();$builder['Password']='';$stage='native-preflight'
 $actual=Rows "SET LOCK_TIMEOUT 1000;SET DEADLOCK_PRIORITY LOW;SELECT CONVERT(nvarchar(128),SERVERPROPERTY('MachineName')) machine,DB_NAME() db"
 if($actual.Count -ne 1 -or $actual[0].machine -cne $machine -or $actual[0].db -cne $database){Refuse 'MEMBER_CODES_SQL_IDENTITY_REFUSED'}
 if($Mode -ceq 'Copy' -and (Scalar "SELECT COUNT(*) FROM dbo.SCCRM_FanoutCopyMeta WHERE marker='fa35c153-6692-43b8-afd1-b102a119b002' AND scope='SCCRM-FANOUT-COPY-LAB-20261029' AND branch_code=@branch" @{branch=$branch}) -ne 1){Refuse 'MEMBER_CODES_COPY_MARKER_REQUIRED'}
 if((Scalar "SELECT COUNT(*) FROM sys.triggers WHERE parent_id=OBJECT_ID('dbo.TCNMCst') AND is_disabled=0") -ne 0){Refuse 'MEMBER_CODES_NATIVE_TRIGGER_REVIEW'}
 if((Scalar "SELECT COUNT(*) FROM sys.indexes WHERE object_id=OBJECT_ID('dbo.TCNMCst') AND name='PK_TCNMCst' AND is_unique=1 AND is_disabled=0") -ne 1){Refuse 'MEMBER_CODES_NATIVE_PRIMARY_KEY_REQUIRED'}
 $columns=Rows "SELECT name,TYPE_NAME(user_type_id) type_name,max_length FROM sys.columns WHERE object_id=OBJECT_ID('dbo.TCNMCst') AND name NOT LIKE '%pin%' AND name NOT LIKE '%password%' AND name NOT LIKE '%secret%' AND name NOT LIKE '%token%' ORDER BY column_id"
 if($columns.Count -ne 101 -or @($columns|Where-Object{$_.name -cnotmatch '^[A-Za-z_][A-Za-z0-9_]*$'}).Count){Refuse 'MEMBER_CODES_SNAPSHOT_SCHEMA_UNSUPPORTED'}
 foreach($dateName in @('FDCstCrdIssue','FDCstCrdExpire')){if(@($columns|Where-Object{$_.name -ceq $dateName -and $_.type_name -ceq 'datetime' -and $_.max_length -eq 8}).Count -ne 1){Refuse 'MEMBER_CODES_CARD_SCHEMA_UNSUPPORTED'}}
 if($role -ceq 'hq'){
  if((Scalar "SELECT CONVERT(nvarchar(36),value) FROM sys.extended_properties WHERE class=1 AND major_id=OBJECT_ID('dbo.SCCRM_LiveMemberLink') AND name='SCCRM_LiveSyncMarker'") -cne 'ef76cc14-1b6b-49c9-8da7-1bfaea3dd92b'){Refuse 'MEMBER_CODES_SOURCE_OWNERSHIP_REFUSED'}
 }else{
  foreach($v1 in @('SCCRM_FanoutTarget','SCCRM_FanoutMemberLink')){if((Scalar "SELECT CONVERT(nvarchar(36),value) FROM sys.extended_properties WHERE class=1 AND major_id=OBJECT_ID(@object) AND name='SCCRM_FanoutMarker'" @{object='dbo.'+$v1}) -cne '86bfa892-2f57-4f60-a3f8-10b90ab5c7a9'){Refuse 'MEMBER_CODES_V1_OWNERSHIP_REFUSED'}}
  if((Scalar 'SELECT COUNT(*) FROM dbo.SCCRM_FanoutTarget WHERE singleton=1 AND target_identity=@identity AND database_name=@database AND machine_name=@machine AND branch_code=@branch AND worker_login=@login AND worker_sid=SUSER_SID(@login)' @{identity=$identity;database=$database;machine=$machine;branch=$branch;login=[string]$runtime.login}) -ne 1){Refuse 'MEMBER_CODES_V1_ACTOR_BINDING_REFUSED'}
 }
 $nativeGuard="IF NOT EXISTS(SELECT 1 FROM dbo.SCCRM_MemberCodeScope WHERE singleton=1 AND native_format='AR000-######') BEGIN RAISERROR('MEMBER_CODES_NATIVE_FORMAT_CHANGED_REVIEW',16,1);RETURN;END;"
 if($Mode -ceq 'Live' -and $role -ceq 'hq'){
  $nativeGuard="IF (SELECT COUNT(*) FROM dbo.TSysAuto WHERE FTSatTblName='TCNMCst' AND FTSatFedCode='FTCstCode')<>1 OR NOT EXISTS(SELECT 1 FROM dbo.TSysAuto WHERE FTSatTblName='TCNMCst' AND FTSatFedCode='FTCstCode' AND FTSatStaDocType='0' AND FTSatStaDefUsage='1' AND FTSatDefChar='AR' AND FTSatDefNum='000001' AND FTSatDefFmtAll='ARBCH-######' AND FTSatLastRun='1' AND FTSatDefYear='0' AND FTSatDefMonth='0' AND FTSatDefDay='0') OR NOT EXISTS(SELECT 1 FROM dbo.TCNMComp WHERE FTBchCode='000') BEGIN RAISERROR('MEMBER_CODES_NATIVE_FORMAT_CHANGED_REVIEW',16,1);RETURN;END;"
 }
 $references=Rows "SELECT t.name table_name,c.name column_name,(SELECT SUM(p.rows) FROM sys.partitions p WHERE p.object_id=t.object_id AND p.index_id IN(0,1)) approximate_rows,(SELECT TOP 1 i.name FROM sys.index_columns ic JOIN sys.indexes i ON i.object_id=ic.object_id AND i.index_id=ic.index_id WHERE ic.object_id=t.object_id AND ic.column_id=c.column_id AND ic.key_ordinal=1 AND i.is_disabled=0 ORDER BY i.index_id) leading_index FROM sys.tables t JOIN sys.columns c ON c.object_id=t.object_id WHERE SCHEMA_NAME(t.schema_id)='dbo' AND c.name LIKE '%CstCode%' AND t.name<>'TCNMCst' AND t.name NOT LIKE 'SCCRM%' ORDER BY t.name,c.name"
 if($Mode -ceq 'Copy' -and @($references|Where-Object{$_.table_name -ceq 'TCNTSccrmCodeRefFixture'}).Count -eq 0){$references+=@([pscustomobject]@{table_name='TCNTSccrmCodeRefFixture';column_name='FTCstCode';approximate_rows=0;leading_index='IND_TCNTSccrmCodeRefFixture_FTCstCode'})}
 $references=@($references|Sort-Object table_name,column_name)
 $checks=@();$manifest=@()
 foreach($reference in $references){
  $table=Ident ([string]$reference.table_name);$column=Ident ([string]$reference.column_name)
  if([long]$reference.approximate_rows -gt 100000 -and !$reference.leading_index){Refuse 'MEMBER_CODES_LARGE_UNINDEXED_REFERENCE_REVIEW'}
  $hint=if($reference.leading_index){',INDEX('+(Ident ([string]$reference.leading_index))+')'}else{''}
  $checks+=('SET @Found=0; SELECT TOP(1) @Found=1 FROM dbo.'+$table+' WITH(UPDLOCK,HOLDLOCK'+$hint+') WHERE '+$column+'=@Code OPTION(MAXDOP 1); IF @Found=1 BEGIN RAISERROR(''MEMBER_CODES_NATIVE_REFERENCES_REVIEW'',16,1);RETURN;END;')
  $manifest+=([string]$reference.table_name+'.'+[string]$reference.column_name+':'+[string]$reference.leading_index)
 }
 $referenceHash=Hash ($manifest -join "`n");$nativeBefore=[long](Scalar 'SELECT COUNT_BIG(*) FROM dbo.TCNMCst')
 $tableNames=@('SCCRM_MemberCodeScope','SCCRM_MemberCodeAssignments','SCCRM_MemberCodeMigrationCohort','SCCRM_MemberCodeApprovals','SCCRM_MemberCodeReceipts','SCCRM_MemberCodeAliases')
 if($Mode -ceq 'Copy'){$tableNames+=@('TCNTSccrmCodeRefFixture')}
 $procedureNames=@('SCCRM_AssertMemberCodeScope','SCCRM_AssertMemberCodeProfile','SCCRM_AssertNoCustomerCodeReferences','SCCRM_AllocateHqMemberCode')+$(if($role -ceq 'hq'){@('SCCRM_CreateMemberFromSccrmV2','SCCRM_MigrateOwnedMemberCode','SCCRM_GetAssignedCustomerSnapshot')}else{@('SCCRM_ApproveMemberCodeAssignment','SCCRM_ReceiveAssignedMember')})
 $existingScope=$null -ne (Scalar "SELECT OBJECT_ID('dbo.SCCRM_MemberCodeScope','U')")
 $existingTables=0
 foreach($name in $tableNames+$procedureNames){if($null -ne (Scalar 'SELECT OBJECT_ID(@name)' @{name='dbo.'+$name})){
  $type=if($name -in $tableNames){'U'}else{'P'}
  if($null -eq (Scalar 'SELECT OBJECT_ID(@name,@type)' @{name='dbo.'+$name;type=$type}) -or (Scalar "SELECT CONVERT(nvarchar(36),value) FROM sys.extended_properties WHERE class=1 AND major_id=OBJECT_ID(@name) AND name='SCCRM_MemberCodesMarker'" @{name='dbo.'+$name}) -cne $marker){Refuse 'MEMBER_CODES_UNOWNED_OBJECT_COLLISION'}
  if($name -in $tableNames){$existingTables++}
 }}
 if($existingTables -ne 0 -and $existingTables -ne $tableNames.Count){Refuse 'MEMBER_CODES_PARTIAL_SCHEMA_REFUSED'}
 if($existingScope){
  $old=Rows 'SELECT scope,LOWER(CONVERT(varchar(36),marker)) marker,hq_identity,target_identity,database_name,machine_name,branch_code,role,reference_count,reference_schema_hash FROM dbo.SCCRM_MemberCodeScope'
  if($old.Count -ne 1 -or $old[0].scope -cne $scope -or $old[0].marker -cne $marker -or $old[0].hq_identity -cne $hqIdentity -or $old[0].target_identity -cne $identity -or $old[0].database_name -cne $database -or $old[0].machine_name -cne $machine -or $old[0].branch_code -cne $branch -or $old[0].role -cne $role -or $old[0].reference_count -ne $references.Count -or $old[0].reference_schema_hash -cne $referenceHash){Refuse 'MEMBER_CODES_EXISTING_SCOPE_CHANGED'}
  if((Scalar 'SELECT COUNT(*) FROM dbo.SCCRM_MemberCodeScope WHERE runtime_login=@runtime AND runtime_sid=SUSER_SID(@runtime) AND authority_login=@authority AND authority_sid=SUSER_SID(@authority)' @{runtime=[string]$runtime.login;authority=[string]$authority.login}) -ne 1){Refuse 'MEMBER_CODES_EXISTING_ACTOR_SID_CHANGED'}
  if($role -ceq 'hq' -and (Scalar 'SELECT COUNT(*) FROM dbo.SCCRM_MemberCodeScope WHERE creator_login=@creator AND creator_sid=SUSER_SID(@creator)' @{creator=[string]$creator.login}) -ne 1){Refuse 'MEMBER_CODES_EXISTING_CREATOR_SID_CHANGED'}
 }
 if($PlanOnly){[ordered]@{ok=$true;planOnly=$true;mode=$Mode;branch=$branch;role=$role;database=$database;referenceCount=$references.Count;referenceSchemaHash=$referenceHash;snapshotColumns=101;ownedObjects=$tableNames+$procedureNames;customerRowsWritten=0;pinRead=$false}|ConvertTo-Json -Depth 5 -Compress;return}
 $stage='owned-schema';$transaction=$db.BeginTransaction()
 if((Scalar "DECLARE @r int;EXEC @r=sys.sp_getapplock @Resource='SCCRM_MemberCodesProvision',@LockMode='Exclusive',@LockOwner='Transaction',@LockTimeout=1000;SELECT @r") -lt 0){Refuse 'MEMBER_CODES_PROVISION_BUSY'}
 if(!$existingScope){
  Run ([IO.File]::ReadAllText((Join-Path $PSScriptRoot 'NativeSchema.sql')))
  if($Mode -ceq 'Copy'){Run 'CREATE TABLE dbo.TCNTSccrmCodeRefFixture(fixture_id int NOT NULL CONSTRAINT PK_TCNTSccrmCodeRefFixture PRIMARY KEY,FTCstCode varchar(20) NOT NULL);CREATE INDEX IND_TCNTSccrmCodeRefFixture_FTCstCode ON dbo.TCNTSccrmCodeRefFixture(FTCstCode)'}
  Run 'INSERT dbo.SCCRM_MemberCodeScope(singleton,marker,scope,hq_identity,target_identity,database_name,machine_name,branch_code,role,native_format,reference_count,reference_schema_hash,created_at) VALUES(1,@marker,@scope,@hq,@identity,@database,@machine,@branch,@role,''AR000-######'',@references,@hash,GETUTCDATE())' @{marker=[guid]$marker;scope=$scope;hq=$hqIdentity;identity=$identity;database=$database;machine=$machine;branch=$branch;role=$role;references=$references.Count;hash=$referenceHash}
 }
 $copyGuard=if($Mode -ceq 'Copy'){"IF (SELECT COUNT(*) FROM dbo.SCCRM_FanoutCopyMeta)<>1 OR NOT EXISTS(SELECT 1 FROM dbo.SCCRM_FanoutCopyMeta WHERE marker='fa35c153-6692-43b8-afd1-b102a119b002' AND scope='SCCRM-FANOUT-COPY-LAB-20261029' AND branch_code='$branch') BEGIN RAISERROR('MEMBER_CODES_COPY_MARKER_REQUIRED',16,1);RETURN;END;"}else{''}
 $projection=(@($columns|ForEach-Object{'c.'+(Ident ([string]$_.name))}) -join ',')
 $sql=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'Common.sql'))+"`nGO`n"+[IO.File]::ReadAllText((Join-Path $PSScriptRoot $(if($role -ceq 'hq'){'Hq.sql'}else{'Target.sql'})))
 $tokens=@{'__DATABASE__'=$database;'__MACHINE__'=$machine;'__BRANCH__'=$branch;'__ROLE__'=$role;'__HQ_IDENTITY__'=$hqIdentity;'__TARGET_IDENTITY__'=$identity;'__COPY_GUARD__'=$copyGuard;'__REFERENCE_CHECKS__'=($checks -join "`n");'__NATIVE_FORMAT_GUARD__'=$nativeGuard;'__SNAPSHOT_COLUMNS__'=$projection}
 foreach($key in $tokens.Keys){$sql=$sql.Replace($key,[string]$tokens[$key])}
 # Native SQL Server-generated index identifiers legitimately contain double
 # underscores (for example PK__TTmpCstP__...). Test the exact template tokens,
 # not a case-insensitive catch-all which mistakes such identifiers for tokens.
 foreach($key in $tokens.Keys){if($sql.Contains([string]$key)){Refuse 'MEMBER_CODES_TEMPLATE_INCOMPLETE'}}
 foreach($batch in [regex]::Split($sql,'(?im)^\s*GO\s*$')){
  if(!$batch.Trim()){continue};if($batch -notmatch '(?i)CREATE\s+PROCEDURE\s+dbo\.([A-Za-z0-9_]+)'){Refuse 'MEMBER_CODES_SQL_BATCH_REFUSED'};$procedureName=$matches[1]
  if($null -ne (Scalar 'SELECT OBJECT_ID(@name)' @{name='dbo.'+$procedureName})){$batch=$batch.Replace('CREATE PROCEDURE','ALTER PROCEDURE')};Run $batch
 }
 foreach($name in $tableNames+$procedureNames){if($null -eq (Scalar "SELECT value FROM sys.extended_properties WHERE class=1 AND major_id=OBJECT_ID(@name) AND name='SCCRM_MemberCodesMarker'" @{name='dbo.'+$name})){
  $type=if($name -in $tableNames){'TABLE'}else{'PROCEDURE'};Run "EXEC sys.sp_addextendedproperty @name='SCCRM_MemberCodesMarker',@value=@marker,@level0type='SCHEMA',@level0name='dbo',@level1type=@type,@level1name=@name" @{marker=$marker;type=$type;name=$name}
 }}
 $stage='immutable-cohort'
 foreach($member in $cohort){
  $p=@{id=[guid]$member.memberId;code=[string]$member.previousCode;name=[string]$member.name;phone=[string]$member.phone;email=[string]$member.email}
  if((Scalar 'SELECT COUNT(*) FROM dbo.SCCRM_MemberCodeMigrationCohort WHERE member_id=@id OR previous_code=@code' $p) -eq 0){Run 'INSERT dbo.SCCRM_MemberCodeMigrationCohort(member_id,previous_code,profile_name,profile_phone,profile_email,approved_at) VALUES(@id,@code,@name,@phone,@email,GETUTCDATE())' $p}
  elseif((Scalar 'SELECT COUNT(*) FROM dbo.SCCRM_MemberCodeMigrationCohort WHERE member_id=@id AND previous_code=@code AND CONVERT(varbinary(max),profile_name)=CONVERT(varbinary(max),@name) AND CONVERT(varbinary(max),profile_phone)=CONVERT(varbinary(max),@phone) AND CONVERT(varbinary(max),profile_email)=CONVERT(varbinary(max),@email)' $p) -ne 1){
   $cohortMismatch=Rows 'SELECT CASE WHEN previous_code=@code THEN 1 ELSE 0 END code_matches,CASE WHEN CONVERT(varbinary(max),profile_name)=CONVERT(varbinary(max),@name) THEN 1 ELSE 0 END name_matches,CASE WHEN CONVERT(varbinary(max),profile_phone)=CONVERT(varbinary(max),@phone) THEN 1 ELSE 0 END phone_matches,CASE WHEN CONVERT(varbinary(max),profile_email)=CONVERT(varbinary(max),@email) THEN 1 ELSE 0 END email_matches FROM dbo.SCCRM_MemberCodeMigrationCohort WHERE member_id=@id' $p
   Refuse 'MEMBER_CODES_COHORT_IMMUTABLE_REFUSED'
  }
 }
 $stage='separate-runtime-authority'
 Ensure-Login $runtime ($role -ceq 'branch');Ensure-Login $authority $false
 if($role -ceq 'hq'){Ensure-Login $creator ($Mode -ceq 'Live')}
 if(!$existingScope){Run 'UPDATE dbo.SCCRM_MemberCodeScope SET runtime_login=@runtime,runtime_sid=SUSER_SID(@runtime),authority_login=@authority,authority_sid=SUSER_SID(@authority),creator_login=@creator,creator_sid=SUSER_SID(@creator) WHERE singleton=1' @{runtime=[string]$runtime.login;authority=[string]$authority.login;creator=$(if($role -ceq 'hq'){[string]$creator.login}else{$null})}}
 foreach($credential in @($runtime,$authority)){
  $actor=Ident ([string]$credential.login)
  foreach($tableName in $tableNames){Run ('DENY INSERT,UPDATE,DELETE,ALTER ON dbo.'+(Ident $tableName)+' TO '+$actor)}
  Run ('DENY SELECT,INSERT,UPDATE,DELETE,ALTER ON dbo.TCNMCst TO '+$actor+'; GRANT SELECT,VIEW DEFINITION ON dbo.SCCRM_MemberCodeScope TO '+$actor+'; DENY ALTER ANY SCHEMA TO '+$actor+'; DENY CREATE TABLE,CREATE PROCEDURE,CREATE FUNCTION,CREATE VIEW TO '+$actor)
  if((Scalar "SELECT COUNT(*) FROM sys.columns WHERE object_id=OBJECT_ID('dbo.TCNMCst') AND name=('FTCst'+'Pin')") -gt 0){Run ('DENY SELECT ON dbo.TCNMCst(FTCstPin) TO '+$actor)}
 }
 if($role -ceq 'hq'){
  Run ('GRANT SELECT ON dbo.SCCRM_MemberCodeScope TO '+(Ident ([string]$runtime.login))+'; GRANT SELECT ON dbo.SCCRM_MemberCodeAssignments TO '+(Ident ([string]$runtime.login))+'; GRANT EXECUTE ON dbo.SCCRM_GetAssignedCustomerSnapshot TO '+(Ident ([string]$runtime.login))+'; DENY EXECUTE ON dbo.SCCRM_CreateMemberFromSccrmV2 TO '+(Ident ([string]$runtime.login))+'; DENY EXECUTE ON dbo.SCCRM_MigrateOwnedMemberCode TO '+(Ident ([string]$runtime.login)))
  Run ('GRANT EXECUTE ON dbo.SCCRM_CreateMemberFromSccrmV2 TO '+(Ident ([string]$creator.login))+'; GRANT SELECT,VIEW DEFINITION ON dbo.SCCRM_MemberCodeScope TO '+(Ident ([string]$creator.login))+'; GRANT EXECUTE ON dbo.SCCRM_MigrateOwnedMemberCode TO '+(Ident ([string]$authority.login))+'; GRANT VIEW DEFINITION ON dbo.SCCRM_LiveMemberLink TO '+(Ident ([string]$authority.login)))
 }else{
  Run ('GRANT EXECUTE ON dbo.SCCRM_ApproveMemberCodeAssignment TO '+(Ident ([string]$authority.login))+'; DENY EXECUTE ON dbo.SCCRM_ReceiveAssignedMember TO '+(Ident ([string]$authority.login))+'; GRANT EXECUTE ON dbo.SCCRM_ReceiveAssignedMember TO '+(Ident ([string]$runtime.login))+'; DENY EXECUTE ON dbo.SCCRM_ApproveMemberCodeAssignment TO '+(Ident ([string]$runtime.login))+'; GRANT VIEW DEFINITION ON dbo.SCCRM_MemberCodeAliases TO '+(Ident ([string]$runtime.login)))
 }
 $transaction.Commit();$transaction.Dispose();$transaction=$null
 $nativeAfter=[long](Scalar 'SELECT COUNT_BIG(*) FROM dbo.TCNMCst')
 [ordered]@{ok=$true;scope=$scope;mode=$Mode;branch=$branch;role=$role;database=$database;targetIdentity=$identity;hqIdentity=$hqIdentity;sourceLogin=$(if($role -ceq 'hq'){$runtime.login}else{$null});deliveryLogin=$(if($role -ceq 'branch'){$runtime.login}else{$null});authorityLogin=$authority.login;referenceCount=$references.Count;referenceSchemaHash=$referenceHash;snapshotColumns=101;cohortCount=$cohort.Count;customerCountBefore=$nativeBefore;customerCountAfter=$nativeAfter;customerRowsWritten=0;originalCreateProcedureAltered=$false;pinRead=$false}|ConvertTo-Json -Depth 5 -Compress
}catch{
 if($transaction){try{$transaction.Rollback()}catch{}};$base=$_.Exception.GetBaseException();$code=if($base.Message -cmatch '^[A-Z][A-Z0-9_]{5,100}$'){$base.Message}else{'MEMBER_CODES_PROVISION_FAILED'}
 [ordered]@{ok=$false;scope=$scope;mode=$Mode;stage=$stage;code=$code;sqlNumber=if($base -is [Data.SqlClient.SqlException]){$base.Number}else{$null};errorType=$base.GetType().Name;cohortMismatch=$cohortMismatch;detailsWithheld=$true;pinRead=$false}|ConvertTo-Json -Depth 5 -Compress;exit 1
}finally{
 if($transaction){$transaction.Dispose()};if($db){$db.Dispose()};if($builder){$builder['Password']=''}
 if($packet){if($packet.admin){$packet.admin.password=$null};foreach($credential in @($packet.runtime,$packet.authority,$packet.creator)){if($credential -and @($credential.PSObject.Properties|Where-Object{$_.Name -ceq 'password'}).Count -eq 1){$credential.password=$null}}};$packet=$null;$raw=$null
}
