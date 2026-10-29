param([ValidateSet('Live','Copy')][string]$Mode='Copy')
# Fixed read-only operator probes. No arbitrary SQL and no PIN projection.
$ErrorActionPreference='Stop'
[Console]::InputEncoding=[Text.Encoding]::UTF8;[Console]::OutputEncoding=[Text.Encoding]::UTF8
$db=$null;$b=$null;$p=$null
function Read-Rows([string]$Sql,[hashtable]$Parameters=@{}){
 $q=$db.CreateCommand();$q.CommandTimeout=5;$q.CommandText=$Sql
 foreach($key in $Parameters.Keys){$parameter=$q.Parameters.Add('@'+$key,[Data.SqlDbType]::VarChar,160);$parameter.Value=$Parameters[$key]}
 $r=$null;$rows=New-Object Collections.Generic.List[object]
 try{$r=$q.ExecuteReader();while($r.Read()){$row=[ordered]@{};for($i=0;$i -lt $r.FieldCount;$i++){$v=if($r.IsDBNull($i)){$null}else{$r.GetValue($i)};if($v -is [datetime]){$v=$v.ToString('yyyy-MM-ddTHH:mm:ss.fff',[Globalization.CultureInfo]::InvariantCulture)+'Z'}elseif($v -is [guid]){$v=$v.ToString().ToLowerInvariant()};$row[$r.GetName($i)]=$v};$rows.Add([pscustomobject]$row)};return ,$rows.ToArray()}finally{if($r){$r.Dispose()};$q.Dispose()}
}
try{
 $p=[Console]::In.ReadToEnd()|ConvertFrom-Json
 if($p.scope -cne 'SCCRM-HQ-MEMBER-CODES-V1' -or $p.branch -cnotmatch '^(000|001|003|004|005)$'){throw 'CODE_READ_SCOPE_REFUSED'}
 $peers=@{'000'=@{server='tcp:100.90.166.72,49800';machine='SERVER'};'001'=@{server='tcp:100.81.137.41,49754';machine='SC_001'};'003'=@{server='tcp:100.77.101.94,49703';machine='POSSRV'};'004'=@{server='tcp:100.113.59.42,49976';machine='SERVER004'};'005'=@{server='tcp:100.106.107.80,49711';machine='POSSRV'}}
 $peer=$peers[[string]$p.branch];$database='AdaAcc';if($Mode -ceq 'Copy'){$peer=$peers['000'];$database='SCCRM_FanoutCopy_20261029_'+$p.branch}
 $b=New-Object Data.SqlClient.SqlConnectionStringBuilder;$b['Data Source']=$peer.server;$b['Initial Catalog']=$database;$b['User ID']=$p.admin.user;$b['Password']=$p.admin.password;$b['Connect Timeout']=5;$b['Application Name']='SCCRM-MemberCodes-Operator-ReadOnly';$b['Pooling']=$false
 $db=New-Object Data.SqlClient.SqlConnection $b.ConnectionString;$db.Open();$b['Password']='';$p.admin.password=''
 $id=Read-Rows "SET LOCK_TIMEOUT 1000;SET DEADLOCK_PRIORITY LOW;SELECT CONVERT(varchar(128),SERVERPROPERTY('MachineName')) machine,DB_NAME() db"
 if($id.Count -ne 1 -or $id[0].machine -cne $peer.machine -or $id[0].db -cne $database){throw 'CODE_READ_IDENTITY_REFUSED'}
 if($Mode -ceq 'Copy'){$guard=Read-Rows "SELECT branch_code FROM dbo.SCCRM_FanoutCopyMeta WHERE marker='fa35c153-6692-43b8-afd1-b102a119b002' AND scope='SCCRM-FANOUT-COPY-LAB-20261029'";if($guard.Count -ne 1 -or $guard[0].branch_code -cne $p.branch){throw 'CODE_READ_COPY_MARKER_REFUSED'}}
 if($p.action -ceq 'cohort' -and $p.branch -ceq '000'){
  $rows=Read-Rows "SELECT LOWER(CONVERT(varchar(36),l.member_id)) memberId,l.ada_code previousCode,l.profile_name name,l.profile_phone phone,ISNULL(l.profile_email,N'') email FROM dbo.SCCRM_LiveMemberLink l JOIN dbo.TCNMCst c ON c.FTCstCode=l.ada_code WHERE l.member_id IN('30b4d6d8-f29b-443e-be66-46d9c2248853','dd313ef6-b74c-4548-960a-f42582239289') AND c.FTCstName=l.profile_name AND c.FTCstTel=l.profile_phone AND ISNULL(c.FTCstEmail,N'')=ISNULL(l.profile_email,N'') ORDER BY l.member_id OPTION(MAXDOP 1)"
 }elseif($p.action -ceq 'customer'){
  if([string]$p.code -cnotmatch '^(AR(000|001|003|004|005)-[0-9]{6}|SC-[A-F0-9]{16})$'){throw 'CODE_READ_CUSTOMER_CODE_REFUSED'}
  $columns=Read-Rows "SELECT name FROM sys.columns WHERE object_id=OBJECT_ID('dbo.TCNMCst') AND name NOT LIKE '%pin%' AND name NOT LIKE '%password%' AND name NOT LIKE '%secret%' AND name NOT LIKE '%token%' ORDER BY column_id"
  if($columns.Count -ne 101 -or @($columns|Where-Object{$_.name -cnotmatch '^[A-Za-z_][A-Za-z0-9_]*$'}).Count){throw 'CODE_READ_SCHEMA_REFUSED'}
  $projection=(@($columns|ForEach-Object{'['+$_.name+']'}) -join ',')
  $rows=Read-Rows ('SELECT '+$projection+' FROM dbo.TCNMCst WITH(INDEX(PK_TCNMCst)) WHERE FTCstCode=@code OPTION(MAXDOP 1)') @{code=[string]$p.code}
 }else{throw 'CODE_READ_ACTION_REFUSED'}
 [ordered]@{ok=$true;branch=$p.branch;database=$database;rows=$rows;productionWrites=0;pinRead=$false}|ConvertTo-Json -Depth 8 -Compress
}catch{$base=$_.Exception.GetBaseException();[ordered]@{ok=$false;code=if($base.Message -cmatch '^[A-Z_]{5,100}$'){$base.Message}else{'CODE_READ_FAILED'};sqlNumber=if($base -is [Data.SqlClient.SqlException]){$base.Number}else{$null}}|ConvertTo-Json -Compress;exit 1}
finally{if($db){$db.Dispose()};if($b){$b['Password']=''};if($p -and $p.admin){$p.admin.password=''}}
