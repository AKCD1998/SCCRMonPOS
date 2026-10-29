[CmdletBinding()]
param([ValidateSet('Copy','Live')][string]$Mode='Copy')
# Explicit operator repair, never installed/imported by the background worker.
# Only the two validity dates on a receiver-owned creation may be populated.
$ErrorActionPreference='Stop'
[Console]::InputEncoding=[Text.Encoding]::UTF8;[Console]::OutputEncoding=[Text.Encoding]::UTF8
$db=$null;$transaction=$null;$packet=$null;$builder=$null;$stage='packet'
$marker='86bfa892-2f57-4f60-a3f8-10b90ab5c7a9'
function Refuse([string]$code){throw $code}
function Cmd([string]$sql,[hashtable]$parameters=@{}){
 $q=$db.CreateCommand();$q.CommandTimeout=8;$q.CommandText=$sql;if($transaction){$q.Transaction=$transaction}
 foreach($key in $parameters.Keys){
  if($key -in @('code','hash','identity')){$parameter=$q.Parameters.Add('@'+$key,[Data.SqlDbType]::VarChar,160);$parameter.Value=$parameters[$key]}
  else{$null=$q.Parameters.AddWithValue('@'+$key,$parameters[$key])}
 };return $q
}
function Rows([string]$sql,[hashtable]$parameters=@{}){
 $q=Cmd $sql $parameters;$adapter=New-Object Data.SqlClient.SqlDataAdapter $q;$table=New-Object Data.DataTable
 try{$null=$adapter.Fill($table);return ,$table}finally{$adapter.Dispose();$q.Dispose()}
}
function Scalar([string]$sql,[hashtable]$parameters=@{}){$q=Cmd $sql $parameters;try{return $q.ExecuteScalar()}finally{$q.Dispose()}}
function Hash-Row($row,$columns){
 $memory=New-Object IO.MemoryStream;$writer=New-Object IO.BinaryWriter $memory,([Text.UTF8Encoding]::new($false,$true));$sha=[Security.Cryptography.SHA256]::Create()
 try{foreach($column in $columns){$writer.Write([string]$column);$value=$row[$column];$writer.Write([bool]($value -is [DBNull]));if($value -is [DBNull]){continue};$writer.Write($value.GetType().FullName)
  if($value -is [datetime]){$text=$value.ToString('o',[Globalization.CultureInfo]::InvariantCulture)}elseif($value -is [byte[]]){$text=[Convert]::ToBase64String($value)}elseif($value -is [double] -or $value -is [single]){$text=$value.ToString('R',[Globalization.CultureInfo]::InvariantCulture)}elseif($value -is [IFormattable]){$text=$value.ToString($null,[Globalization.CultureInfo]::InvariantCulture)}else{$text=[string]$value};$writer.Write($text)
 };$writer.Flush();return [BitConverter]::ToString($sha.ComputeHash($memory.ToArray()))}finally{$writer.Dispose();$memory.Dispose();$sha.Dispose()}
}
try{
 $raw=[Console]::In.ReadToEnd();if($raw.Length -gt 16384){Refuse 'VALIDITY_PACKET_TOO_LARGE'};$packet=$raw|ConvertFrom-Json;$raw=$null
 if($packet.scope -cne 'SCCRM-OWNED-VALIDITY-REPAIR-V1' -or $packet.marker -cne $marker -or $packet.policy -cne 'calendar-years-100'){Refuse 'VALIDITY_POLICY_APPROVAL_REQUIRED'}
 $target=$packet.target;$members=@($packet.members)
 if(!$target -or $members.Count -lt 1 -or $members.Count -gt 2 -or ([string]$target.identity) -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._:/@-]{1,159}$'){Refuse 'VALIDITY_SCOPE_REFUSED'}
 if($Mode -ceq 'Live'){
  if($target.branch -cne '005' -or $target.machine -cne 'POSSRV' -or $target.database -cne 'AdaAcc' -or $target.server -cne '100.106.107.80\SQLEXPRESS' -or $packet.pilotApproved -ne $true){Refuse 'VALIDITY_LIVE_PILOT_ONLY'}
 }elseif($target.branch -cne '005' -or $target.machine -cne 'SERVER' -or $target.database -cne 'SCCRM_FanoutCopy_20261029_005' -or $target.server -cne 'tcp:100.90.166.72,49800'){Refuse 'VALIDITY_COPY_ONLY'}
 $seen=@{}
 foreach($member in $members){
  $id=[string]$member.memberId;$code='SC-'+$id.Replace('-','').Substring(0,[Math]::Min(16,$id.Replace('-','').Length)).ToUpperInvariant()
  if($id -cnotmatch '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' -or $member.adaCode -cne $code -or ([string]$member.profileHash) -cnotmatch '^[a-f0-9]{64}$' -or $seen.ContainsKey($id)){Refuse 'VALIDITY_MEMBER_IDENTITY_REFUSED'};$seen[$id]=$true
 }
 if(!$packet.admin.user -or !$packet.admin.password){Refuse 'VALIDITY_OPERATOR_IDENTITY_REQUIRED'}
 $builder=New-Object Data.SqlClient.SqlConnectionStringBuilder;$builder['Data Source']=[string]$target.server;$builder['Initial Catalog']=[string]$target.database;$builder['User ID']=[string]$packet.admin.user;$builder['Password']=[string]$packet.admin.password;$builder['Connect Timeout']=5;$builder['Application Name']='SCCRM-Explicit-Owned-Validity-Repair';$builder['Pooling']=$false
 $db=New-Object Data.SqlClient.SqlConnection $builder.ConnectionString;$db.Open();$builder['Password']='';$stage='identity'
 $identity=Rows "SET LOCK_TIMEOUT 1000;SET DEADLOCK_PRIORITY LOW;SELECT CONVERT(nvarchar(128),SERVERPROPERTY('MachineName')) machine,DB_NAME() db"
 if($identity.Rows.Count -ne 1 -or $identity.Rows[0].machine -cne $target.machine -or $identity.Rows[0].db -cne $target.database){Refuse 'VALIDITY_DATABASE_IDENTITY_REFUSED'}
 if($Mode -ceq 'Copy'){
  if((Scalar "SELECT COUNT(*) FROM dbo.SCCRM_FanoutCopyMeta WHERE marker='fa35c153-6692-43b8-afd1-b102a119b002' AND scope='SCCRM-FANOUT-COPY-LAB-20261029' AND branch_code='005'") -ne 1){Refuse 'VALIDITY_COPY_MARKER_REQUIRED'}
  $q=Cmd "EXECUTE AS USER='SCCRM_FanoutCopyExecutor' WITH NO REVERT";try{$null=$q.ExecuteNonQuery()}finally{$q.Dispose()}
  if((Scalar "SELECT IS_SRVROLEMEMBER('sysadmin')") -ne 0 -or (Scalar "SELECT HAS_DBACCESS('AdaAcc')") -ne 0){Refuse 'VALIDITY_COPY_NOT_ISOLATED'}
 }
 foreach($object in @('SCCRM_FanoutTarget','SCCRM_FanoutMemberLink')){if((Scalar "SELECT CONVERT(nvarchar(36),value) FROM sys.extended_properties WHERE class=1 AND major_id=OBJECT_ID(@object) AND name='SCCRM_FanoutMarker'" @{object='dbo.'+$object}) -cne $marker){Refuse 'VALIDITY_OWNERSHIP_MARKER_REQUIRED'}}
 if((Scalar 'SELECT COUNT(*) FROM dbo.SCCRM_FanoutTarget WHERE singleton=1 AND target_identity=@identity AND database_name=@database AND machine_name=@machine AND branch_code=@branch' @{identity=[string]$target.identity;database=[string]$target.database;machine=[string]$target.machine;branch=[string]$target.branch}) -ne 1){Refuse 'VALIDITY_TARGET_BINDING_REFUSED'}
 if((Scalar "SELECT COUNT(*) FROM sys.triggers WHERE parent_id=OBJECT_ID('dbo.TCNMCst') AND is_disabled=0") -ne 0){Refuse 'VALIDITY_NATIVE_TRIGGER_REVIEW_REQUIRED'}
 $columnRows=Rows "SELECT name FROM sys.columns WHERE object_id=OBJECT_ID('dbo.TCNMCst') AND name NOT LIKE '%pin%' AND name NOT LIKE '%password%' AND name NOT LIKE '%secret%' AND name NOT LIKE '%token%' AND name NOT IN('FDCstCrdIssue','FDCstCrdExpire') ORDER BY column_id"
 $columns=@($columnRows.Rows|ForEach-Object{[string]$_.name});if($columns.Count -ne 99 -or @($columns|Where-Object{$_ -cnotmatch '^[A-Za-z_][A-Za-z0-9_]*$'}).Count){Refuse 'VALIDITY_NONDATE_SCHEMA_REFUSED'}
 $projection=(@($columns|ForEach-Object{'['+$_+']'}) -join ',')
 $transaction=$db.BeginTransaction();$stage='owned-member-guards'
 if((Scalar "DECLARE @r int;EXEC @r=sys.sp_getapplock @Resource='SCCRM_FanoutMemberCreate',@LockMode='Exclusive',@LockOwner='Transaction',@LockTimeout=1000;SELECT @r") -lt 0){Refuse 'VALIDITY_TARGET_BUSY'}
 $results=@()
 foreach($member in $members){
  $p=@{id=[guid]$member.memberId;code=[string]$member.adaCode;hash=[string]$member.profileHash;identity=[string]$target.identity}
  $guard=Rows @'
SELECT c.FDCstCrdIssue,c.FDCstCrdExpire,
 CONVERT(datetime,CONVERT(varchar(8),c.FDDateIns,112),112) expected_issue,
 DATEADD(year,100,CONVERT(datetime,CONVERT(varchar(8),c.FDDateIns,112),112)) expected_expiry
FROM dbo.SCCRM_FanoutMemberLink l WITH(UPDLOCK,HOLDLOCK)
JOIN dbo.TCNMCst c WITH(UPDLOCK,HOLDLOCK) ON c.FTCstCode=l.ada_code
WHERE l.member_id=@id AND l.hq_code=@code AND l.ada_code=@code
 AND CONVERT(varbinary(max),l.target_identity)=CONVERT(varbinary(max),@identity)
 AND CONVERT(varbinary(max),l.profile_hash)=CONVERT(varbinary(max),@hash)
 AND CONVERT(varbinary(max),CONVERT(nvarchar(200),c.FTCstName))=CONVERT(varbinary(max),l.profile_name)
 AND CONVERT(varbinary(max),ISNULL(c.FTCstTel,''))=CONVERT(varbinary(max),l.profile_phone)
 AND CONVERT(varbinary(max),CONVERT(nvarchar(100),ISNULL(c.FTCstEmail,'')))=CONVERT(varbinary(max),l.profile_email)
 AND c.FTWhoIns='SCCRM_FANOUT_CREATE' AND c.FTBchCode='000' AND c.FTCstStaActive='1'
 AND c.FDDateIns IS NOT NULL AND c.FDDateIns<=GETDATE()
'@ $p
  if($guard.Rows.Count -ne 1){Refuse 'VALIDITY_OWNED_PROFILE_CHANGED_REVIEW'};$row=$guard.Rows[0]
  $before=Rows ('SELECT '+$projection+' FROM dbo.TCNMCst WHERE FTCstCode=@code') @{code=[string]$member.adaCode};$beforeHash=Hash-Row $before.Rows[0] $columns
  if($row.FDCstCrdIssue -is [DBNull] -and $row.FDCstCrdExpire -is [DBNull]){
   $q=Cmd 'UPDATE dbo.TCNMCst SET FDCstCrdIssue=CONVERT(datetime,CONVERT(varchar(8),FDDateIns,112),112),FDCstCrdExpire=DATEADD(year,100,CONVERT(datetime,CONVERT(varchar(8),FDDateIns,112),112)) WHERE FTCstCode=@code AND FDCstCrdIssue IS NULL AND FDCstCrdExpire IS NULL' @{code=[string]$member.adaCode}
   try{if($q.ExecuteNonQuery() -ne 1){Refuse 'VALIDITY_GUARDED_WRITE_REFUSED'}}finally{$q.Dispose()};$outcome='populated-owned-dates'
  }elseif($row.FDCstCrdIssue -eq $row.expected_issue -and $row.FDCstCrdExpire -eq $row.expected_expiry){$outcome='already-valid'}
  else{Refuse 'VALIDITY_EXISTING_DATES_REVIEW'}
  $after=Rows ('SELECT '+$projection+' FROM dbo.TCNMCst WHERE FTCstCode=@code') @{code=[string]$member.adaCode}
  if((Hash-Row $after.Rows[0] $columns) -cne $beforeHash){Refuse 'VALIDITY_NONDATE_DATA_CHANGED'}
  if((Scalar "SELECT COUNT(*) FROM dbo.TCNMCst WHERE FTCstCode=@code AND FDCstCrdIssue=CONVERT(datetime,CONVERT(varchar(8),FDDateIns,112),112) AND FDCstCrdExpire=DATEADD(year,100,FDCstCrdIssue) AND ISNULL(FTCstStaActive,'')<>'2' AND ISNULL(FDCstCrdExpire,'19000101')>=CONVERT(datetime,CONVERT(varchar(8),GETDATE(),112),112)" @{code=[string]$member.adaCode}) -ne 1){Refuse 'VALIDITY_LOOKUP_STILL_EXCLUDED'}
  $results+=@{adaCode=[string]$member.adaCode;outcome=$outcome;issue=$row.expected_issue.ToString('yyyy-MM-dd');expiry=$row.expected_expiry.ToString('yyyy-MM-dd');otherColumnsPreserved=99;lookupEligible=$true}
 }
 $transaction.Commit();$transaction=$null
 [ordered]@{ok=$true;scope='SCCRM-OWNED-VALIDITY-REPAIR-V1';mode=$Mode;branch='005';policy='calendar-years-100';members=$results;productionRowsChanged=$(if($Mode -ceq 'Live'){@($results|Where-Object outcome -eq 'populated-owned-dates').Count}else{0});pinRead=$false;oldCustomerUpdates=0}|ConvertTo-Json -Compress -Depth 5
}catch{
 if($transaction){try{$transaction.Rollback()}catch{}};$base=$_.Exception.GetBaseException();$code=if($base.Message -cmatch '^[A-Z][A-Z0-9_]{5,90}$'){$base.Message}else{'VALIDITY_OPERATION_REFUSED'}
 [ordered]@{ok=$false;scope='SCCRM-OWNED-VALIDITY-REPAIR-V1';stage=$stage;code=$code;mode=$Mode;pinRead=$false}|ConvertTo-Json -Compress;exit 1
}finally{if($transaction){$transaction.Dispose()};if($db){$db.Dispose()};if($builder){$builder['Password']=''};if($packet){$packet.admin.password=$null};$packet=$null}
