[CmdletBinding()]
param([ValidateSet('Copy','Live')][string]$Mode='Copy',[ValidateSet('Source','Receiver')][string]$Kind,
 [ValidateSet('Apply','Rollback')][string]$Action='Apply',[string]$ApprovedTargetsFile)
# INTERNAL OPERATOR PIPE ONLY. Success includes the exact previous SQL module
# definition for a private rollback file. Capture stdout; never echo the whole
# packet/result in a console. This script never reads customer/PIN values.
$ErrorActionPreference='Stop'
[Console]::InputEncoding=[Text.Encoding]::UTF8;[Console]::OutputEncoding=[Text.Encoding]::UTF8
$marker='64fa3170-80ae-45ee-b9f3-7478b2a46e34';$scope='SCCRM-HQ-MEMBER-CODES-V1'
$db=$null;$tx=$null;$builder=$null;$packet=$null;$stage='packet'
function Refuse([string]$Code){throw $Code}
function Q([string]$Sql,[hashtable]$Parameters=@{}){$q=$db.CreateCommand();$q.CommandText=$Sql;$q.CommandTimeout=8;if($tx){$q.Transaction=$tx};foreach($k in $Parameters.Keys){$v=$Parameters[$k];if($null -eq $v){$v=[DBNull]::Value};$null=$q.Parameters.AddWithValue('@'+$k,$v)};return $q}
function Run([string]$Sql,[hashtable]$Parameters=@{}){$q=Q $Sql $Parameters;try{$null=$q.ExecuteNonQuery()}finally{$q.Dispose()}}
function Scalar([string]$Sql,[hashtable]$Parameters=@{}){$q=Q $Sql $Parameters;try{$v=$q.ExecuteScalar();if($v -is [DBNull]){return $null};return $v}finally{$q.Dispose()}}
function Rows([string]$Sql,[hashtable]$Parameters=@{}){$q=Q $Sql $Parameters;$r=$null;$rows=@();try{$r=$q.ExecuteReader();while($r.Read()){$row=[ordered]@{};for($i=0;$i -lt $r.FieldCount;$i++){$row[$r.GetName($i)]=if($r.IsDBNull($i)){$null}else{$r.GetValue($i)}};$rows+=,[pscustomobject]$row};return ,$rows}finally{if($r){$r.Dispose()};$q.Dispose()}}
function Hash([string]$Text){$sha=[Security.Cryptography.SHA256]::Create();try{return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text)))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}}
function As-Alter([string]$Definition){
 if(!$Definition -or $Definition.Length -gt 65536 -or $Definition -match '(?im)^\s*GO\s*$'){Refuse 'CODE_COMPAT_DEFINITION_REFUSED'}
 $regex=[regex]::new('(?im)^\s*(CREATE|ALTER)\s+PROCEDURE\s+(?:\[dbo\]|dbo)\.(?:\['+[regex]::Escape($procedure)+'\]|'+[regex]::Escape($procedure)+')(?=\s|\()')
 $matches=$regex.Matches($Definition);if($matches.Count -ne 1){Refuse 'CODE_COMPAT_PROCEDURE_NAME_REFUSED'}
 $match=$matches[0];$first=$match.Groups[1];return $Definition.Substring(0,$first.Index)+'ALTER'+$Definition.Substring($first.Index+$first.Length)
}
try{
 $raw=[Console]::In.ReadToEnd();if($raw.Length -gt 131072){Refuse 'CODE_COMPAT_PACKET_TOO_LARGE'};$packet=$raw|ConvertFrom-Json;$raw=$null
 if($packet.scope -cne $scope -or $packet.marker -cne $marker -or !$Kind){Refuse 'CODE_COMPAT_PACKET_REFUSED'}
 $target=$packet.target;$branch=[string]$target.branch;$database=[string]$target.database;$machine=[string]$target.machine;$identity=[string]$target.identity;$hq=[string]$packet.hqIdentity
 $role=if($Kind -ceq 'Source'){'hq'}else{'branch'};$procedure=if($Kind -ceq 'Source'){'SCCRM_CreateMemberFromSccrm'}else{'SCCRM_ReceiveMemberFromHq'}
 $oldProperty=if($Kind -ceq 'Source'){'SCCRM_LiveSyncMarker'}else{'SCCRM_FanoutMarker'};$oldMarker=if($Kind -ceq 'Source'){'ef76cc14-1b6b-49c9-8da7-1bfaea3dd92b'}else{'86bfa892-2f57-4f60-a3f8-10b90ab5c7a9'}
 if($branch -cnotmatch '^(000|001|003|004|005)$' -or ($Kind -ceq 'Source') -ne ($branch -ceq '000') -or
  $target.role -cne $role -or $database -cnotmatch '^[A-Za-z0-9_]{1,128}$' -or $machine -cnotmatch '^[A-Za-z0-9_-]{1,128}$' -or
  $identity -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._:/@-]{1,159}$' -or $hq -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._:/@-]{1,159}$' -or
  ([string]$target.server) -cnotmatch '^(tcp:)?100\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}(,[0-9]{1,5}|\\[A-Za-z0-9_]{1,64})$'){Refuse 'CODE_COMPAT_TARGET_REFUSED'}
 if($Mode -ceq 'Copy'){
  if($database -cne ('SCCRM_FanoutCopy_20261029_'+$branch) -or $machine -cne 'SERVER' -or $target.server -cne 'tcp:100.90.166.72,49800' -or $hq -cne ('copy000/SERVER.SQLEXPRESS/SCCRM_FanoutCopy_20261029_000/'+$marker)){Refuse 'CODE_COMPAT_COPY_SCOPE_REFUSED'}
 }else{
  if($database -cne 'AdaAcc' -or $hq -cne ('hq000/SERVER.SQLEXPRESS/AdaAcc/'+$marker) -or !$ApprovedTargetsFile){Refuse 'CODE_COMPAT_LIVE_APPROVAL_REQUIRED'}
  $approved=Get-Content -LiteralPath $ApprovedTargetsFile -Raw|ConvertFrom-Json
  if($approved.scope -cne $scope -or $approved.marker -cne $marker){Refuse 'CODE_COMPAT_ALLOWLIST_REFUSED'}
  $matches=@($approved.targets|Where-Object{$_.branch -ceq $branch -and $_.role -ceq $role -and $_.database -ceq $database -and $_.machine -ceq $machine -and $_.server -ceq $target.server -and $_.identity -ceq $identity -and $_.allowProvision -eq $true})
  if($matches.Count -ne 1){Refuse 'CODE_COMPAT_TARGET_NOT_APPROVED'}
 }
 if(!$packet.admin.user -or !$packet.admin.password){Refuse 'CODE_COMPAT_ADMIN_REQUIRED'}
 $builder=New-Object Data.SqlClient.SqlConnectionStringBuilder;$builder['Data Source']=[string]$target.server;$builder['Initial Catalog']=$database;$builder['User ID']=[string]$packet.admin.user;$builder['Password']=[string]$packet.admin.password;$builder['Connect Timeout']=5;$builder['Application Name']='SCCRM-MemberCodes-Explicit-Compatibility';$builder['Pooling']=$false
 $db=New-Object Data.SqlClient.SqlConnection $builder.ConnectionString;$db.Open();$builder['Password']='';$stage='identity'
 $actual=Rows "SET LOCK_TIMEOUT 1000;SET DEADLOCK_PRIORITY LOW;SELECT CONVERT(nvarchar(128),SERVERPROPERTY('MachineName')) machine,DB_NAME() db"
 if($actual.Count -ne 1 -or $actual[0].machine -cne $machine -or $actual[0].db -cne $database){Refuse 'CODE_COMPAT_SQL_IDENTITY_REFUSED'}
 if($Mode -ceq 'Copy' -and (Scalar "SELECT COUNT(*) FROM dbo.SCCRM_FanoutCopyMeta WHERE marker='fa35c153-6692-43b8-afd1-b102a119b002' AND scope='SCCRM-FANOUT-COPY-LAB-20261029' AND branch_code=@branch" @{branch=$branch}) -ne 1){Refuse 'CODE_COMPAT_COPY_MARKER_REQUIRED'}
 if((Scalar "SELECT CONVERT(nvarchar(36),value) FROM sys.extended_properties WHERE class=1 AND major_id=OBJECT_ID('dbo.SCCRM_MemberCodeScope') AND name='SCCRM_MemberCodesMarker'") -cne $marker){Refuse 'CODE_COMPAT_SCOPE_OWNERSHIP_REFUSED'}
 if((Scalar 'SELECT COUNT(*) FROM dbo.SCCRM_MemberCodeScope WHERE singleton=1 AND marker=@marker AND scope=@scope AND role=@role AND database_name=@database AND machine_name=@machine AND branch_code=@branch AND hq_identity=@hq AND target_identity=@identity' @{marker=[guid]$marker;scope=$scope;role=$role;database=$database;machine=$machine;branch=$branch;hq=$hq;identity=$identity}) -ne 1){Refuse 'CODE_COMPAT_SCOPE_BINDING_REFUSED'}
 if((Scalar "SELECT CONVERT(nvarchar(36),value) FROM sys.extended_properties WHERE class=1 AND major_id=OBJECT_ID(@object,'P') AND name=@property" @{object='dbo.'+$procedure;property=$oldProperty}) -cne $oldMarker){Refuse 'CODE_COMPAT_ORIGINAL_OWNERSHIP_REFUSED'}
 $stage='transaction';$tx=$db.BeginTransaction()
 if((Scalar "DECLARE @r int;EXEC @r=sys.sp_getapplock @Resource='SCCRM_MemberCodesCompatibility',@LockMode='Exclusive',@LockOwner='Transaction',@LockTimeout=1000;SELECT @r") -lt 0){Refuse 'CODE_COMPAT_BUSY'}
 if($null -eq (Scalar "SELECT OBJECT_ID('dbo.SCCRM_MemberCodeCompatibilityAudit')")){
  Run 'CREATE TABLE dbo.SCCRM_MemberCodeCompatibilityAudit(backup_id uniqueidentifier NOT NULL PRIMARY KEY,kind varchar(12) NOT NULL,procedure_name sysname NOT NULL,previous_definition nvarchar(max) NOT NULL,previous_sha256 varchar(64) NOT NULL,applied_sha256 varchar(64) NOT NULL,applied_at datetime NOT NULL,rolled_back_at datetime NULL)'
  Run "EXEC sys.sp_addextendedproperty @name='SCCRM_MemberCodesMarker',@value=@marker,@level0type='SCHEMA',@level0name='dbo',@level1type='TABLE',@level1name='SCCRM_MemberCodeCompatibilityAudit'" @{marker=$marker}
 }elseif((Scalar "SELECT CONVERT(nvarchar(36),value) FROM sys.extended_properties WHERE class=1 AND major_id=OBJECT_ID('dbo.SCCRM_MemberCodeCompatibilityAudit','U') AND name='SCCRM_MemberCodesMarker'") -cne $marker){Refuse 'CODE_COMPAT_UNOWNED_BACKUP_COLLISION'}
 $before=[string](Scalar 'SELECT OBJECT_DEFINITION(OBJECT_ID(@object))' @{object='dbo.'+$procedure});$beforeHash=Hash $before;$null=As-Alter $before
 if($packet.expectedCurrentHash -and $packet.expectedCurrentHash -cne $beforeHash){Refuse 'CODE_COMPAT_CURRENT_DEFINITION_CHANGED'}
 if($Action -ceq 'Apply'){
  $file=if($Kind -ceq 'Source'){'SourceCompatibility.sql'}else{'LegacyReceiverAlias.sql'};$candidate=[IO.File]::ReadAllText((Join-Path $PSScriptRoot $file))
  $copyGuard=if($Mode -ceq 'Copy'){"IF (SELECT COUNT(*) FROM dbo.SCCRM_FanoutCopyMeta)<>1 OR NOT EXISTS(SELECT 1 FROM dbo.SCCRM_FanoutCopyMeta WHERE marker='fa35c153-6692-43b8-afd1-b102a119b002' AND scope='SCCRM-FANOUT-COPY-LAB-20261029' AND branch_code='$branch') BEGIN RAISERROR('FANOUT_COPY_MARKER_REFUSED',16,1);RETURN;END;"}else{''}
  foreach($replacement in @(@('__DATABASE__',$database),@('__MACHINE__',$machine),@('__TARGET_BRANCH__',$branch),@('__TARGET_IDENTITY__',$identity),@('__COPY_GUARD__',$copyGuard))){$candidate=$candidate.Replace($replacement[0],$replacement[1])}
  if($candidate -match '__[A-Z_]+__'){Refuse 'CODE_COMPAT_TEMPLATE_INCOMPLETE'};$candidate=As-Alter $candidate;$backupId=[guid]::NewGuid()
 }else{
  if(([string]$packet.backupId) -cnotmatch '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' -or !$packet.expectedCurrentHash){Refuse 'CODE_COMPAT_ROLLBACK_PACKET_REFUSED'}
  $backupId=[guid]$packet.backupId;$saved=Rows 'SELECT kind,procedure_name,previous_definition,previous_sha256,applied_sha256,rolled_back_at FROM dbo.SCCRM_MemberCodeCompatibilityAudit WITH(UPDLOCK,HOLDLOCK) WHERE backup_id=@id' @{id=$backupId}
  if($saved.Count -ne 1 -or $saved[0].kind -cne $Kind -or $saved[0].procedure_name -cne $procedure -or $saved[0].applied_sha256 -cne $beforeHash -or $null -ne $saved[0].rolled_back_at -or (Hash ([string]$saved[0].previous_definition)) -cne $saved[0].previous_sha256){Refuse 'CODE_COMPAT_BACKUP_BINDING_REFUSED'}
  $candidate=As-Alter ([string]$saved[0].previous_definition)
 }
 Run $candidate
 $after=[string](Scalar 'SELECT OBJECT_DEFINITION(OBJECT_ID(@object))' @{object='dbo.'+$procedure});$afterHash=Hash $after
 if((Hash (As-Alter $after)) -cne (Hash $candidate)){Refuse 'CODE_COMPAT_APPLIED_DEFINITION_MISMATCH'}
 if($Action -ceq 'Apply'){Run 'INSERT dbo.SCCRM_MemberCodeCompatibilityAudit(backup_id,kind,procedure_name,previous_definition,previous_sha256,applied_sha256,applied_at) VALUES(@id,@kind,@procedure,@definition,@previous,@applied,GETUTCDATE())' @{id=$backupId;kind=$Kind;procedure=$procedure;definition=$before;previous=$beforeHash;applied=$afterHash}}
 else{Run 'UPDATE dbo.SCCRM_MemberCodeCompatibilityAudit SET rolled_back_at=GETUTCDATE() WHERE backup_id=@id AND rolled_back_at IS NULL' @{id=$backupId}}
 $tx.Commit();$tx.Dispose();$tx=$null
 [ordered]@{ok=$true;scope=$scope;mode=$Mode;kind=$Kind;action=$Action;branch=$branch;procedure='dbo.'+$procedure;backupId=$backupId.ToString();previousDefinition=$before;previousSha256=$beforeHash;appliedSha256=$afterHash;bodyVerified=$true;customerRowsWritten=0;pinRead=$false}|ConvertTo-Json -Depth 4 -Compress
}catch{
 if($tx){try{$tx.Rollback()}catch{}};$base=$_.Exception.GetBaseException();$code=if($base.Message -cmatch '^[A-Z][A-Z0-9_]{5,100}$'){$base.Message}else{'CODE_COMPAT_OPERATION_FAILED'}
 [ordered]@{ok=$false;scope=$scope;mode=$Mode;kind=$Kind;action=$Action;stage=$stage;code=$code;sqlNumber=if($base -is [Data.SqlClient.SqlException]){$base.Number}else{$null};detailsWithheld=$true;customerRowsWritten=0;pinRead=$false}|ConvertTo-Json -Compress;exit 1
}finally{if($tx){$tx.Dispose()};if($db){$db.Dispose()};if($builder){$builder['Password']=''};if($packet -and $packet.admin){$packet.admin.password=$null};$packet=$null}
