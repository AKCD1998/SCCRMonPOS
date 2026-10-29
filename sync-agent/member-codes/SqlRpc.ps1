param()
$ErrorActionPreference='Stop'
[Console]::InputEncoding=[Text.Encoding]::UTF8;[Console]::OutputEncoding=[Text.Encoding]::UTF8
$db=$null;$builder=$null;$init=$null;$connection=$null
function Safe-Code($record){$base=$record.Exception.GetBaseException();if($base -is [Data.SqlClient.SqlException]){if($base.Number -in @(1205,1222)){return 'TARGET_BUSY'};if($base.Number -eq -2){return 'SQL_TIMEOUT'};if($base.Number -in @(-1,2,20,53,64,233,10053,10054,10060,11001)){return 'TARGET_OFFLINE'}};if($base.Message -cmatch '\b([A-Z][A-Z0-9_]{5,79})\b'){return $Matches[1]};return 'CODE_OPERATION_REVIEW'}
function Query([string]$sql,[hashtable]$parameters=@{}){
 $q=$db.CreateCommand();$q.CommandTimeout=5;$q.CommandText=$sql
 try{foreach($key in $parameters.Keys){$value=$parameters[$key];if($null -eq $value){$value=[DBNull]::Value}
  if($key -in @('assignmentId','memberId')){$p=$q.Parameters.Add('@'+$key,[Data.SqlDbType]::UniqueIdentifier)}
  elseif($key -in @('assignedAt','afterAt')){$p=$q.Parameters.Add('@'+$key,[Data.SqlDbType]::DateTime)}
  elseif($key -in @('name','email')){$p=$q.Parameters.Add('@'+$key,[Data.SqlDbType]::NVarChar,200)}
  else{$p=$q.Parameters.Add('@'+$key,[Data.SqlDbType]::VarChar,512)};$p.Value=$value
 };$reader=$q.ExecuteReader();$rows=New-Object Collections.Generic.List[object]
  try{do{while($reader.Read()){$row=[ordered]@{};for($i=0;$i -lt $reader.FieldCount;$i++){$v=if($reader.IsDBNull($i)){$null}else{$reader.GetValue($i)};if($v -is [datetime]){$v=$v.ToString('yyyy-MM-ddTHH:mm:ss.fff',[Globalization.CultureInfo]::InvariantCulture)+'Z'}elseif($v -is [guid]){$v=$v.ToString().ToLowerInvariant()};$row[$reader.GetName($i)]=$v};$rows.Add([pscustomobject]$row)}}while($reader.NextResult())}finally{$reader.Dispose()};return ,$rows.ToArray()
 }finally{$q.Dispose()}
}
function Check-Profile($profile){if(!$profile -or ([string]$profile.name).Length -lt 1 -or ([string]$profile.name).Length -gt 200 -or ([string]$profile.phone) -cnotmatch '^0[0-9]{9}$' -or ([string]$profile.email).Length -gt 100){throw 'CODE_PROFILE_REFUSED'}}
try{
 $init=[Console]::ReadLine()|ConvertFrom-Json
 if($init.action -cne 'init' -or $init.scope -cne 'SCCRM-HQ-MEMBER-CODES-V1' -or $init.mode -cnotin @('copy','live') -or $init.role -cnotin @('source','authority','receiver','creator')){throw 'CODE_RPC_INIT_REFUSED'}
 $mode=[string]$init.mode;$role=[string]$init.role;$connection=$init.connection
 if($mode -ceq 'live'){
  if($connection.database -cne 'AdaAcc' -or $role -ceq 'creator'){throw 'CODE_LIVE_SCOPE_REFUSED'}
 }elseif($connection.database -cnotmatch '^SCCRM_FanoutCopy_20261029_(000|001|003|004|005)$' -or $connection.machine -cne 'SERVER'){throw 'CODE_COPY_SCOPE_REFUSED'}
 $suffix=if($mode -ceq 'copy'){'_copy_[a-f0-9]{8,16}'}else{''}
 $pattern=switch($role){'source'{'^sccrm_member_codes_source'+$suffix+'$'};'authority'{'^sccrm_member_code_authority_00[01345]'+$suffix+'$'};'receiver'{'^sccrm_member_fanout_00[1345]'+$suffix+'$'};'creator'{'^sccrm_member_codes_creator'+$suffix+'$'}}
 if(([string]$connection.user) -cnotmatch $pattern -or !$connection.hqIdentity -or ([string]$connection.hqIdentity).Length -gt 160 -or !$connection.targetIdentity -or ([string]$connection.targetIdentity).Length -gt 160){throw 'CODE_RPC_ROLE_REFUSED'}
 $builder=New-Object Data.SqlClient.SqlConnectionStringBuilder;$builder['Data Source']=$connection.server;$builder['Initial Catalog']=$connection.database;$builder['User ID']=$connection.user;$builder['Password']=$connection.password;$builder['Connect Timeout']=4;$builder['Application Name']='SCCRM-MemberCodes-'+$role;$builder['Pooling']=$false
 $db=New-Object Data.SqlClient.SqlConnection $builder.ConnectionString;$db.Open();$builder['Password']='';$connection.password=$null;$init=$null
 $identity=Query "SET LOCK_TIMEOUT 1000;SET DEADLOCK_PRIORITY LOW;SELECT CONVERT(nvarchar(128),SERVERPROPERTY('MachineName')) machine,DB_NAME() database_name,ORIGINAL_LOGIN() actor,IS_SRVROLEMEMBER('sysadmin') elevated"
 if($identity.Count -ne 1 -or $identity[0].machine -cne $connection.machine -or $identity[0].database_name -cne $connection.database -or $identity[0].actor -cne $connection.user -or $identity[0].elevated -ne 0){throw 'CODE_RPC_IDENTITY_REFUSED'}
 $scope=Query "SELECT LOWER(CONVERT(varchar(36),marker)) marker,scope,hq_identity,target_identity,database_name,machine_name,branch_code,role FROM dbo.SCCRM_MemberCodeScope"
 $expectedScopeRole=if($role -in @('source','creator') -or $connection.branchCode -ceq '000'){'hq'}else{'branch'}
 if($scope.Count -ne 1 -or $scope[0].marker -cne '64fa3170-80ae-45ee-b9f3-7478b2a46e34' -or $scope[0].scope -cne 'SCCRM-HQ-MEMBER-CODES-V1' -or $scope[0].hq_identity -cne $connection.hqIdentity -or $scope[0].target_identity -cne $connection.targetIdentity -or $scope[0].database_name -cne $connection.database -or $scope[0].machine_name -cne $connection.machine -or $scope[0].branch_code -cne $connection.branchCode -or $scope[0].role -cne $expectedScopeRole){throw 'CODE_RPC_SCOPE_MARKER_REFUSED'}
 [Console]::WriteLine((@{id=0;ok=$true;rows=$identity}|ConvertTo-Json -Compress -Depth 4))
 while($null -ne ($line=[Console]::ReadLine())){
  $request=$line|ConvertFrom-Json;if($request.action -ceq 'close'){break}
  try{
   if($role -ceq 'source' -and $request.action -ceq 'assignments'){
    $afterAt=[DBNull]::Value;$afterId=''
    if($request.afterAt){$afterAt=[datetime]::Parse([string]$request.afterAt,[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::RoundtripKind);$afterId=[string]$request.afterAssignmentId;if($afterId -cnotmatch '^[a-f0-9-]{36}$'){throw 'CODE_CURSOR_REFUSED'}}
    $rows=Query "SELECT TOP(100) LOWER(CONVERT(varchar(36),assignment_id)) assignment_id,LOWER(CONVERT(varchar(36),member_id)) member_id,ada_code,previous_code,assignment_kind,hq_identity,profile_name,profile_phone,profile_email,CONVERT(varchar(23),assigned_at,126)+'Z' assigned_at FROM dbo.SCCRM_MemberCodeAssignments WHERE @afterAt IS NULL OR assigned_at>@afterAt OR(assigned_at=@afterAt AND LOWER(CONVERT(varchar(36),assignment_id)) COLLATE Latin1_General_BIN2>@afterId) ORDER BY assigned_at,LOWER(CONVERT(varchar(36),assignment_id)) COLLATE Latin1_General_BIN2" @{afterAt=$afterAt;afterId=$afterId}
   }elseif($role -ceq 'source' -and $request.action -ceq 'snapshot'){
    if([string]$request.assignmentId -cnotmatch '^[a-f0-9-]{36}$'){throw 'CODE_ASSIGNMENT_ID_REFUSED'}
    $rows=Query 'EXEC dbo.SCCRM_GetAssignedCustomerSnapshot @AssignmentId=@assignmentId' @{assignmentId=[guid]$request.assignmentId}
   }elseif($role -ceq 'authority' -and $request.action -ceq 'approve' -and $connection.branchCode -cne '000'){
    $a=$request.assignment;Check-Profile $request.profile
    if([string]$a.assignmentId -cnotmatch '^[a-f0-9-]{36}$' -or [string]$a.memberId -cnotmatch '^[a-f0-9-]{36}$' -or [string]$a.adaCode -cnotmatch '^AR000-[0-9]{6}$' -or [string]$a.profileHash -cnotmatch '^[a-f0-9]{64}$' -or [string]$request.assignmentHash -cnotmatch '^[a-f0-9]{64}$' -or $a.hqIdentity -cne $connection.hqIdentity -or $a.kind -cnotin @('hq_create','approved_existing')){throw 'CODE_APPROVAL_PACKET_REFUSED'}
    $previous=if($request.previousNativeCode){[string]$request.previousNativeCode}else{$null};if($previous -and $previous -cnotmatch '^SC-[A-F0-9]{16}$'){throw 'CODE_PREVIOUS_CODE_REFUSED'}
    $rows=Query 'EXEC dbo.SCCRM_ApproveMemberCodeAssignment @AssignmentId=@assignmentId,@MemberId=@memberId,@HqCode=@code,@PreviousCode=@previous,@Kind=@kind,@Name=@name,@Phone=@phone,@Email=@email,@ProfileHash=@hash,@AssignmentHash=@assignmentHash,@HqIdentity=@hq,@TargetIdentity=@target,@AssignedAt=@assignedAt' @{assignmentId=[guid]$a.assignmentId;memberId=[guid]$a.memberId;code=[string]$a.adaCode;previous=$previous;kind=[string]$a.kind;name=[string]$request.profile.name;phone=[string]$request.profile.phone;email=[string]$request.profile.email;hash=[string]$a.profileHash;assignmentHash=[string]$request.assignmentHash;hq=[string]$a.hqIdentity;target=[string]$connection.targetIdentity;assignedAt=[datetime]::Parse([string]$a.assignedAt,[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::RoundtripKind)}
   }elseif($role -ceq 'receiver' -and $request.action -ceq 'receive'){
    Check-Profile $request.profile
    if([string]$request.assignmentId -cnotmatch '^[a-f0-9-]{36}$' -or [string]$request.memberId -cnotmatch '^[a-f0-9-]{36}$' -or [string]$request.code -cnotmatch '^AR000-[0-9]{6}$' -or [string]$request.profileHash -cnotmatch '^[a-f0-9]{64}$'){throw 'CODE_RECEIVE_PACKET_REFUSED'}
    $rows=Query 'EXEC dbo.SCCRM_ReceiveAssignedMember @AssignmentId=@assignmentId,@MemberId=@memberId,@HqCode=@code,@Name=@name,@Phone=@phone,@Email=@email,@ProfileHash=@hash,@TargetIdentity=@target' @{assignmentId=[guid]$request.assignmentId;memberId=[guid]$request.memberId;code=[string]$request.code;name=[string]$request.profile.name;phone=[string]$request.profile.phone;email=[string]$request.profile.email;hash=[string]$request.profileHash;target=[string]$connection.targetIdentity}
   }elseif($role -ceq 'authority' -and $connection.branchCode -ceq '000' -and $request.action -ceq 'migrate'){
    Check-Profile $request.profile
    if([string]$request.memberId -cnotmatch '^[a-f0-9-]{36}$' -or [string]$request.previousCode -cnotmatch '^SC-[A-F0-9]{16}$'){throw 'CODE_MIGRATION_PACKET_REFUSED'}
    $rows=Query 'EXEC dbo.SCCRM_MigrateOwnedMemberCode @MemberId=@memberId,@PreviousCode=@previous,@ExpectedName=@name,@ExpectedPhone=@phone,@ExpectedEmail=@email' @{memberId=[guid]$request.memberId;previous=[string]$request.previousCode;name=[string]$request.profile.name;phone=[string]$request.profile.phone;email=[string]$request.profile.email}
   }elseif($mode -ceq 'copy' -and $role -ceq 'creator' -and $request.action -ceq 'create'){
    Check-Profile $request.profile;if([string]$request.memberId -cnotmatch '^[a-f0-9-]{36}$'){throw 'CODE_CREATE_COPY_ID_REFUSED'}
    $rows=Query 'EXEC dbo.SCCRM_CreateMemberFromSccrmV2 @MemberId=@memberId,@Name=@name,@Phone=@phone,@Email=@email' @{memberId=[guid]$request.memberId;name=[string]$request.profile.name;phone=[string]$request.profile.phone;email=[string]$request.profile.email}
   }else{throw 'CODE_RPC_ACTION_REFUSED'}
   [Console]::WriteLine((@{id=$request.id;ok=$true;rows=$rows}|ConvertTo-Json -Compress -Depth 8))
  }catch{[Console]::WriteLine((@{id=$request.id;ok=$false;code=(Safe-Code $_)}|ConvertTo-Json -Compress))}
 }
}catch{[Console]::WriteLine((@{id=0;ok=$false;code=(Safe-Code $_)}|ConvertTo-Json -Compress));exit 1}
finally{if($db){$db.Dispose()};if($builder){$builder['Password']=''};if($connection){$connection.password=$null};$request=$null;$line=$null}
