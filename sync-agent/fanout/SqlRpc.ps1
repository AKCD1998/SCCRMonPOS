param()
$ErrorActionPreference='Stop'
[Console]::InputEncoding=[Text.Encoding]::UTF8;[Console]::OutputEncoding=[Text.Encoding]::UTF8
$db=$null;$settings=$null;$builder=$null
function Safe-Code($errorRecord){
 $e=$errorRecord.Exception.GetBaseException()
 if($e -is [Data.SqlClient.SqlException]){
  if($e.Number -eq -2){return 'SQL_TIMEOUT'}
  if($e.Number -in @(1222,1205)){return 'TARGET_BUSY'}
  if($e.Number -in @(-1,2,20,53,64,233,10053,10054,10060,11001)){return 'TARGET_OFFLINE'}
  if($e.Number -in @(18456,18452)){return 'TARGET_AUTHENTICATION_REVIEW'}
 }
 if($e.Message -cmatch '\b([A-Z][A-Z0-9_]{5,79})\b'){if($Matches[1] -ceq 'FANOUT_RECEIVER_BUSY'){return 'TARGET_BUSY'};return $Matches[1]}
 return 'TARGET_OPERATION_REVIEW'
}
function Query([string]$text,[hashtable]$parameters=@{}){
 $cmd=$db.CreateCommand();$cmd.CommandTimeout=5;$cmd.CommandText=$text
 try{
  foreach($key in $parameters.Keys){$value=$parameters[$key];if($null -eq $value){$value=[DBNull]::Value}
   if($key -in @('id')){$p=$cmd.Parameters.Add('@'+$key,[Data.SqlDbType]::UniqueIdentifier)}
   elseif($key -eq 'afterUtc'){$p=$cmd.Parameters.Add('@'+$key,[Data.SqlDbType]::DateTime)}
   elseif($key -in @('name','email')){$p=$cmd.Parameters.Add('@'+$key,[Data.SqlDbType]::NVarChar,200)}
   else{$p=$cmd.Parameters.Add('@'+$key,[Data.SqlDbType]::VarChar,512)}
   $p.Value=$value
  }
  $reader=$cmd.ExecuteReader();$rows=New-Object Collections.Generic.List[object]
  try{do{while($reader.Read()){$row=[ordered]@{};for($i=0;$i -lt $reader.FieldCount;$i++){
   $v=if($reader.IsDBNull($i)){$null}else{$reader.GetValue($i)}
   if($v -is [datetime]){$v=$v.ToString('yyyy-MM-ddTHH:mm:ss.fff',[Globalization.CultureInfo]::InvariantCulture)+'Z'}
   elseif($v -is [guid]){$v=$v.ToString().ToLowerInvariant()}
   $row[$reader.GetName($i)]=$v
  };$rows.Add([pscustomobject]$row)}}while($reader.NextResult())}finally{$reader.Dispose()}
  return ,$rows.ToArray()
 }finally{$cmd.Dispose()}
}
try{
 $init=[Console]::ReadLine()|ConvertFrom-Json
 if($init.action -cne 'init' -or $init.scope -cne 'SCCRM-HQ-BRANCH-FANOUT-V1'){throw 'RPC_INIT_REFUSED'}
 $settings=$init.connection;$role=[string]$init.role;$mode=[string]$init.mode
 if($role -notin @('source','receiver') -or $mode -notin @('copy','live')){throw 'RPC_SCOPE_REFUSED'}
 if($mode -ceq 'live'){
  if($settings.database -cne 'AdaAcc' -or $settings.user -cnotmatch '^sccrm_member_fanout_(source|001|003|004|005)$'){throw 'LIVE_RPC_IDENTITY_REFUSED'}
 }elseif($settings.database -cnotmatch '^SCCRM_FanoutCopy_20261029_(000|001|003|004|005)$' -or $settings.user -cnotmatch '^sccrm_member_fanout_(source|001|003|004|005)_copy[a-zA-Z0-9_]*$'){throw 'COPY_RPC_IDENTITY_REFUSED'}
 if($role -ceq 'source' -and ($settings.machine -cne 'SERVER' -or $settings.user -cnotmatch '^sccrm_member_fanout_source')){throw 'SOURCE_IDENTITY_REFUSED'}
 $builder=New-Object Data.SqlClient.SqlConnectionStringBuilder
 $builder['Data Source']=$settings.server;$builder['Initial Catalog']=$settings.database;$builder['User ID']=$settings.user;$builder['Password']=$settings.password
 $builder['Connect Timeout']=4;$builder['Application Name']='SCCRM-HQ-MemberFanout-'+$role;$builder['Pooling']=$false
 $db=New-Object Data.SqlClient.SqlConnection $builder.ConnectionString;$db.Open();$builder['Password']='';$settings.password=$null;$init=$null
 $identity=Query "SELECT CONVERT(nvarchar(128),SERVERPROPERTY('MachineName')) machine,DB_NAME() database_name,ORIGINAL_LOGIN() actor,IS_SRVROLEMEMBER('sysadmin') elevated,GETUTCDATE() server_utc"
 if($identity.Count -ne 1 -or $identity[0].machine -cne $settings.machine -or $identity[0].database_name -cne $settings.database -or $identity[0].actor -cne $settings.user -or $identity[0].elevated -ne 0){throw 'SQL_IDENTITY_REFUSED'}
 $session=$db.CreateCommand();$session.CommandText='SET LOCK_TIMEOUT 1000;SET DEADLOCK_PRIORITY LOW';[void]$session.ExecuteNonQuery();$session.Dispose()
 if($role -ceq 'source'){
  $owner=Query 'SELECT marker FROM dbo.SCCRM_FanoutSource'
  if($owner.Count -ne 1 -or $owner[0].marker -cne '86bfa892-2f57-4f60-a3f8-10b90ab5c7a9'){throw 'SOURCE_MARKER_REFUSED'}
 }
 [Console]::WriteLine((@{id=0;ok=$true;rows=$identity}|ConvertTo-Json -Compress -Depth 5))
 while($null -ne ($line=[Console]::ReadLine())){
  $req=$line|ConvertFrom-Json;if($req.action -ceq 'close'){break}
  try{
   if($req.action -ceq 'identity'){$rows=$identity}
   elseif($role -ceq 'source' -and $req.action -ceq 'confirmed'){
    $afterUtc=[DBNull]::Value;$afterId=''
    if($req.afterCreatedAt){$afterUtc=[datetime]::Parse([string]$req.afterCreatedAt,[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::RoundtripKind);$afterId=[string]$req.afterMemberId;if($afterId -cnotmatch '^[a-f0-9-]{36}$'){throw 'SOURCE_CURSOR_REFUSED'}}
    $rows=Query "SELECT TOP(100) LOWER(CONVERT(varchar(36),member_id)) member_id,ada_code,profile_name,profile_phone,ISNULL(profile_email,'') profile_email,DATEADD(minute,DATEDIFF(minute,GETDATE(),GETUTCDATE()),created_at) hq_confirmed_at FROM dbo.SCCRM_LiveMemberLink WHERE ada_code LIKE 'SC-%' AND(@afterUtc IS NULL OR created_at>DATEADD(minute,DATEDIFF(minute,GETUTCDATE(),GETDATE()),@afterUtc) OR(created_at=DATEADD(minute,DATEDIFF(minute,GETUTCDATE(),GETDATE()),@afterUtc) AND LOWER(CONVERT(varchar(36),member_id)) COLLATE Latin1_General_BIN2>@afterId)) ORDER BY created_at,LOWER(CONVERT(varchar(36),member_id)) COLLATE Latin1_General_BIN2" @{afterUtc=$afterUtc;afterId=$afterId}
   }elseif($role -ceq 'receiver' -and $req.action -ceq 'receive'){
    if([string]$req.memberId -cnotmatch '^[a-f0-9-]{36}$' -or [string]$req.profileHash -cnotmatch '^[a-f0-9]{64}$' -or ([string]$req.profile.name).Length -lt 1 -or ([string]$req.profile.name).Length -gt 200 -or ([string]$req.profile.email).Length -gt 100 -or ([string]$req.profile.phone) -cnotmatch '^0[0-9]{9}$' -or ([string]$req.hqCode) -cnotmatch '^SC-[A-F0-9]{16}$' -or ([string]$settings.targetIdentity).Length -gt 160){throw 'RECEIVE_PACKET_REFUSED'}
    $rows=Query 'EXEC dbo.SCCRM_ReceiveMemberFromHq @MemberId=@id,@HqCode=@code,@Name=@name,@Phone=@phone,@Email=@email,@ProfileHash=@hash,@TargetIdentity=@target' @{id=[guid]$req.memberId;code=[string]$req.hqCode;name=[string]$req.profile.name;phone=[string]$req.profile.phone;email=[string]$req.profile.email;hash=[string]$req.profileHash;target=[string]$settings.targetIdentity}
   }else{throw 'RPC_ACTION_REFUSED'}
   [Console]::WriteLine((@{id=$req.id;ok=$true;rows=$rows}|ConvertTo-Json -Compress -Depth 8))
  }catch{[Console]::WriteLine((@{id=$req.id;ok=$false;code=(Safe-Code $_)}|ConvertTo-Json -Compress))}
 }
}catch{[Console]::WriteLine((@{id=0;ok=$false;code=(Safe-Code $_)}|ConvertTo-Json -Compress));exit 1}
finally{if($db){$db.Dispose()};if($builder){$builder['Password']=''};if($settings){$settings.password=$null};$init=$null;$line=$null;$req=$null}
