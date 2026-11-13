param([Parameter(Mandatory=$true)][string]$ConfigFile)
$ErrorActionPreference='Stop';[Console]::InputEncoding=[Text.Encoding]::UTF8;[Console]::OutputEncoding=[Text.Encoding]::UTF8;$db=$null;$password=$null
try{
 $c=Get-Content -LiteralPath $ConfigFile -Raw|ConvertFrom-Json
 if($c.scope -cne 'SCCRM-HQ-LIVE-MEMBERS' -or $c.sql.database -cne 'AdaAcc' -or $c.sql.user -cne 'sccrm_hq_member_sync' -or $c.sql.server -notin @('tcp:127.0.0.1,49800','tcp:100.90.166.72,49800')){throw 'LIVE_SQL_CONFIG_REFUSED'}
 $init=[Console]::ReadLine()|ConvertFrom-Json;if($init.action -cne 'init'){throw 'INIT_REQUIRED'};$password=$init.sqlPassword;$init=$null
 $b=New-Object Data.SqlClient.SqlConnectionStringBuilder;$b['Data Source']=$c.sql.server;$b['Initial Catalog']='AdaAcc';$b['User ID']='sccrm_hq_member_sync';$b['Password']=$password;$b['Connect Timeout']=5;$b['Application Name']='SCCRM-HQ-LiveSync';$db=New-Object Data.SqlClient.SqlConnection $b.ConnectionString;$db.Open();$b.Password='';$password=$null
 function Query([string]$sql,[hashtable]$parameters=@{}){$q=$db.CreateCommand();$q.CommandTimeout=10;$q.CommandText=$sql;foreach($k in $parameters.Keys){$v=$parameters[$k];if($null -eq $v){$v=[DBNull]::Value};if($v -is [guid]){$param=$q.Parameters.Add('@'+$k,[Data.SqlDbType]::UniqueIdentifier)}elseif($k -in @('name','email')){$param=$q.Parameters.Add('@'+$k,[Data.SqlDbType]::NVarChar,200)}else{$param=$q.Parameters.Add('@'+$k,[Data.SqlDbType]::VarChar,50)};$param.Value=$v};$r=$q.ExecuteReader();$rows=New-Object Collections.Generic.List[object];try{do{while($r.Read()){$row=[ordered]@{};for($i=0;$i -lt $r.FieldCount;$i++){$v=if($r.IsDBNull($i)){$null}else{$r.GetValue($i)};if($v -is [datetime]){$v=$v.ToString('yyyy-MM-ddTHH:mm:ss.fff',[Globalization.CultureInfo]::InvariantCulture)}elseif($v -is [double] -or $v -is [single]){$v=$v.ToString('R',[Globalization.CultureInfo]::InvariantCulture)}elseif($v -is [long] -or $v -is [decimal]){$v=$v.ToString([Globalization.CultureInfo]::InvariantCulture)}elseif($v -is [guid]){$v=$v.ToString()};$row[$r.GetName($i)]=$v};$rows.Add([pscustomobject]$row)}}while($r.NextResult())}finally{$r.Dispose();$q.Dispose()};return ,$rows.ToArray()}
 $identity=Query "SELECT CAST(SERVERPROPERTY('MachineName') AS nvarchar(128)) machine,DB_NAME() db,ORIGINAL_LOGIN() actor,IS_SRVROLEMEMBER('sysadmin') elevated"
 if($identity[0].machine -cne 'SERVER' -or $identity[0].db -cne 'AdaAcc' -or $identity[0].actor -cne 'sccrm_hq_member_sync' -or $identity[0].elevated -ne 0){throw 'LIVE_SQL_IDENTITY_REFUSED'}
 $session=$db.CreateCommand();$session.CommandText='SET LOCK_TIMEOUT 1000; SET DEADLOCK_PRIORITY LOW;';$null=$session.ExecuteNonQuery();$session.Dispose()
 $columns=Query "SELECT name FROM sys.columns WHERE object_id=OBJECT_ID('dbo.TCNMCst') AND name<>('FTCst'+'Pin') ORDER BY column_id";$select=(@($columns|ForEach-Object{if($_.name -notmatch '^[A-Za-z0-9_]+$'){throw 'UNSAFE_COLUMN'};'['+$_.name+']'}) -join ',')
 $filter="FTShdDocType IN('1','9') AND FTShdStaPaid='3' AND NULLIF(LTRIM(RTRIM(FTCstCode)),'') IS NOT NULL AND FTCstCode<>'0'"
 while($null -ne ($line=[Console]::ReadLine())){$req=$line|ConvertFrom-Json;if($req.action -ceq 'close'){break};try{
  switch -CaseSensitive($req.action){
   'customers' {$rows=Query ("SELECT TOP(100) "+$select+" FROM dbo.TCNMCst WHERE @after IS NULL OR FTCstCode>@after ORDER BY FTCstCode OPTION(MAXDOP 1)") @{after=$req.after}}
   'customer' {if(([string]$req.code).Length -gt 20){throw 'CODE_REFUSED'};$rows=Query ('SELECT '+$select+' FROM dbo.TCNMCst WHERE FTCstCode=@code') @{code=$req.code}}
   'customersForCodes' {if($req.codes.Count -lt 1 -or $req.codes.Count -gt 100){throw 'CUSTOMER_SCOPE_REFUSED'};$params=@{};$holders=@(for($j=0;$j -lt $req.codes.Count;$j++){if(([string]$req.codes[$j]).Length -gt 20){throw 'CUSTOMER_SCOPE_REFUSED'};$params['c'+$j]=[string]$req.codes[$j];'@c'+$j});$rows=Query ('SELECT '+$select+' FROM dbo.TCNMCst WHERE FTCstCode IN('+($holders -join ',')+') OPTION(MAXDOP 1)') $params}
   'historyWindow' {$rows=Query "SELECT CONVERT(varchar(23),CONVERT(datetime,CONVERT(date,DATEADD(day,-2,GETDATE()))),126) [floor]"}
   'recentReceipts' {
    if(([string]$req.floor) -notmatch '^\d{4}-\d{2}-\d{2}T00:00:00(\.000)?$' -or ([string]$req.afterDate) -notmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?$' -or ([string]$req.afterDoc).Length -gt 20){throw 'RECENT_WINDOW_REFUSED'}
    $rows=Query ("SELECT TOP(100) * FROM dbo.TPSTSalHD WITH(INDEX(IND_TPSTSalHD_FDShdDocDate)) WHERE "+$filter+" AND FDShdDocDate>=CONVERT(datetime,@floor,126) AND (FDShdDocDate>CONVERT(datetime,@afterDate,126) OR(FDShdDocDate=CONVERT(datetime,@afterDate,126) AND FTShdDocNo>@doc)) ORDER BY FDShdDocDate,FTShdDocNo OPTION(MAXDOP 1,RECOMPILE)") @{floor=[string]$req.floor;afterDate=[string]$req.afterDate;doc=[string]$req.afterDoc}
   }
   'receipts' {$rows=Query ("SELECT TOP(100) * FROM dbo.TPSTSalHD WITH(INDEX(IND_TPSTSalHD_FTCstCode)) WHERE "+$filter+" AND (@customer IS NULL OR FTCstCode>@customer OR(FTCstCode=@customer AND FTShdDocNo>@doc)) ORDER BY FTCstCode,FTShdDocNo OPTION(MAXDOP 1)") @{customer=$req.afterCustomer;doc=[string]$req.afterDoc}}
   'lines' {if($req.docs.Count -lt 1 -or $req.docs.Count -gt 100){throw 'DOCUMENT_SCOPE_REFUSED'};$params=@{};$holders=@(for($j=0;$j -lt $req.docs.Count;$j++){if(([string]$req.docs[$j]).Length -gt 20){throw 'DOCUMENT_SCOPE_REFUSED'};$params['d'+$j]=[string]$req.docs[$j];'@d'+$j});$rows=Query ('SELECT * FROM dbo.TPSTSalDT WHERE FTShdDocNo IN('+($holders -join ',')+') ORDER BY FTShdDocNo,FNSdtSeqNo OPTION(MAXDOP 1)') $params}
   'createMember' {
    if(([string]$req.memberId) -notmatch '^[a-fA-F0-9-]{36}$' -or ([string]$req.name).Length -gt 200 -or ([string]$req.phone).Length -gt 30 -or ([string]$req.email).Length -gt 100){throw 'PROFILE_NOT_REPRESENTABLE'}
    $parameters=@{id=[guid]$req.memberId;name=[string]$req.name;phone=[string]$req.phone;email=[string]$req.email}
    $statement='EXEC dbo.SCCRM_CreateMemberFromSccrm @MemberId=@id,@Name=@name,@Phone=@phone,@Email=@email'
    if($req.distinctRequest){
     if($c.registrationConfirmationEnabled -ne $true -or ([string]$req.distinctRequest) -cnotmatch '^[a-f0-9-]{36}$'){throw 'REGISTRATION_CONFIRMATION_REFUSED'}
     $parameters.distinctRequest=[guid]$req.distinctRequest
     $statement+=',@DistinctRequest=@distinctRequest'
    }
    $rows=Query $statement $parameters
   }
   default {throw 'ACTION_REFUSED'}
  }
  [Console]::WriteLine(([ordered]@{id=$req.id;ok=$true;rows=$rows}|ConvertTo-Json -Depth 7 -Compress))
 }catch{$base=$_.Exception.GetBaseException();$code='SOURCE_OPERATION_FAILED';$connectionLost=$false
  if($base -is [Data.SqlClient.SqlException] -and $base.Number -in @(-1,2,20,53,64,233,10053,10054,10060,11001)){$code='SOURCE_PROCESS_ENDED';$connectionLost=$true}
  elseif($base -is [Data.SqlClient.SqlException] -and $base.Number -in @(1205,1222)){$code='MEMBER_CREATE_BUSY'}
  elseif($base -is [Data.SqlClient.SqlException] -and $base.Number -eq -2){$code='SOURCE_TIMEOUT';$connectionLost=$true}
  elseif($base.Message -match '([A-Z][A-Z_]{6,})'){$code=$Matches[1]}
  [Console]::WriteLine(([ordered]@{id=$req.id;ok=$false;code=$code}|ConvertTo-Json -Compress));if($connectionLost){break}
 }}
}catch{[Console]::WriteLine(([ordered]@{ok=$false;code='LIVE_SOURCE_START_FAILED';type=$_.Exception.GetBaseException().GetType().Name}|ConvertTo-Json -Compress));exit 1}
finally{if($db){$db.Dispose()};if($b){$b.Password=''};$password=$null}
