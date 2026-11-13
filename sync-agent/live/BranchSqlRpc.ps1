param([Parameter(Mandatory=$true)][ValidateSet('001','003','004','005')][string]$Branch)
$ErrorActionPreference='Stop';[Console]::InputEncoding=[Text.Encoding]::UTF8;[Console]::OutputEncoding=[Text.Encoding]::UTF8
. (Join-Path $PSScriptRoot 'BranchSecrets.ps1')
$db=$null;$target=$null;$builder=$null
try{
 $init=[Console]::ReadLine()|ConvertFrom-Json;if($init.action -cne 'init'){throw 'BRANCH_INIT_REQUIRED'}
 $sources=Read-HistorySources;$target=$sources[$Branch];foreach($b in @('001','003','004','005')){if($b -cne $Branch){$sources[$b].password=''}};$sources=$null
 $builder=New-Object Data.SqlClient.SqlConnectionStringBuilder;$builder['Data Source']=$target.server;$builder['Initial Catalog']='AdaAcc';$builder['User ID']=$target.user;$builder['Password']=$target.password;$builder['Connect Timeout']=3;$builder['Pooling']=$false;$builder['Application Name']='SCCRM-Branch-Inbound-ReadOnly'
 $db=New-Object Data.SqlClient.SqlConnection $builder.ConnectionString;$db.Open();$builder.Password='';$target.password=''
 function Query([string]$sql,[hashtable]$parameters=@{},[int]$limit=1000){
  # All SQL text comes from the fixed action cases below. Values are bound
  # parameters; permission introspection legitimately contains the word UPDATE.
  if($sql.TrimStart() -cnotmatch '^SELECT\b' -or $sql -match '(?i)\bINTO\b'){throw 'BRANCH_QUERY_REFUSED'}
  $q=$db.CreateCommand();$q.CommandText=$sql;$q.CommandTimeout=8;foreach($key in $parameters.Keys){$param=$q.Parameters.Add('@'+$key,[Data.SqlDbType]::VarChar,50);$param.Value=$parameters[$key]}
  $reader=$null;$rows=New-Object Collections.Generic.List[object]
  try{$reader=$q.ExecuteReader();while($reader.Read()){
   if($rows.Count -ge $limit){throw 'BRANCH_SOURCE_ROW_LIMIT'}
   $row=[ordered]@{};for($i=0;$i -lt $reader.FieldCount;$i++){
    $v=if($reader.IsDBNull($i)){$null}else{$reader.GetValue($i)}
    if($v -is [DateTime]){$v=$v.ToString('yyyy-MM-ddTHH:mm:ss.fff',[Globalization.CultureInfo]::InvariantCulture)}
    elseif($v -is [double] -or $v -is [single]){$v=$v.ToString('R',[Globalization.CultureInfo]::InvariantCulture)}
    elseif($v -is [long] -or $v -is [decimal]){$v=$v.ToString([Globalization.CultureInfo]::InvariantCulture)}
    $row[$reader.GetName($i)]=$v
   };$rows.Add([pscustomobject]$row)
  };return ,$rows.ToArray()}finally{if($reader){$reader.Dispose()};$q.Dispose()}
 }
 $identity=Query "SELECT CONVERT(varchar(128),SERVERPROPERTY('MachineName')) machine,DB_NAME() db,ORIGINAL_LOGIN() actor,IS_SRVROLEMEMBER('sysadmin') elevated,IS_MEMBER('db_owner') owner,IS_MEMBER('db_datawriter') writer,HAS_PERMS_BY_NAME('dbo.SCCRM_SalesExport_TPSTSalHD','OBJECT','SELECT') header_read,HAS_PERMS_BY_NAME('dbo.SCCRM_SalesExport_TPSTSalDT','OBJECT','SELECT') item_read,ISNULL(HAS_PERMS_BY_NAME('dbo.TCNMCst','OBJECT','SELECT'),0) customer_read,ISNULL(HAS_PERMS_BY_NAME('dbo.TPSTSalHD','OBJECT','UPDATE'),0) native_update" @{} 1
 $i=$identity[0];if($identity.Count -ne 1 -or $i.machine -cne $target.machine -or $i.db -cne 'AdaAcc' -or $i.actor -cne ('sccrm_sales_export_'+$Branch) -or $i.elevated -ne 0 -or $i.owner -ne 0 -or $i.writer -ne 0 -or $i.header_read -ne 1 -or $i.item_read -ne 1 -or $i.customer_read -ne 0 -or $i.native_update -ne 0){throw 'BRANCH_SOURCE_RIGHTS_REFUSED'}
 $q=$db.CreateCommand();$q.CommandText='SET LOCK_TIMEOUT 750;SET DEADLOCK_PRIORITY LOW;';$null=$q.ExecuteNonQuery();$q.Dispose()
 while($null -ne ($line=[Console]::ReadLine())){
  $req=$line|ConvertFrom-Json;if($req.action -ceq 'close'){break}
  try{
   switch -CaseSensitive($req.action){
    'historyWindow' {$rows=if($req.full -eq $true){Query "SELECT CONVERT(varchar(23),CONVERT(datetime,'20261108',112),126) [floor]"}else{Query "SELECT CONVERT(varchar(23),CONVERT(datetime,CONVERT(date,DATEADD(day,-2,GETDATE()))),126) [floor]"}}
    'recentReceipts' {
     if(([string]$req.floor) -cnotmatch '^\d{4}-\d{2}-\d{2}T00:00:00(\.000)?$' -or ([string]$req.afterDate) -cnotmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?$' -or ([string]$req.afterDoc).Length -gt 20){throw 'BRANCH_WINDOW_REFUSED'}
     $rows=Query "SELECT TOP(50) FTShdDocNo,FDShdDocDate FROM dbo.SCCRM_SalesExport_TPSTSalHD WHERE FTBchCode=@branch AND FTCstCode<>'' AND FTCstCode<>'0' AND FDShdDocDate>=CONVERT(datetime,@floor,126) AND(FDShdDocDate>CONVERT(datetime,@afterDate,126) OR(FDShdDocDate=CONVERT(datetime,@afterDate,126) AND FTShdDocNo>@doc)) AND DATEADD(second,90,CONVERT(datetime,CONVERT(char(10),FDShdDocDate,120)+' '+FTShdDocTime,120))<=GETDATE() ORDER BY FDShdDocDate,FTShdDocNo OPTION(MAXDOP 1,RECOMPILE)" @{branch=$Branch;floor=[string]$req.floor;afterDate=[string]$req.afterDate;doc=[string]$req.afterDoc} 50
    }
    'snapshot' {
     if($req.docs.Count -lt 1 -or $req.docs.Count -gt 50){throw 'BRANCH_DOCUMENT_SCOPE_REFUSED'}
     $params=@{branch=$Branch};$holders=@();for($n=0;$n -lt $req.docs.Count;$n++){if(([string]$req.docs[$n]) -cnotmatch '^[SR][0-9]{10}-[0-9]{7}$'){throw 'BRANCH_DOCUMENT_SCOPE_REFUSED'};$key='d'+$n;$params[$key]=[string]$req.docs[$n];$holders+='@'+$key}
     $where='FTBchCode=@branch AND FTShdDocNo IN('+($holders -join ',')+')'
     $headerSql='SELECT * FROM dbo.SCCRM_SalesExport_TPSTSalHD WHERE '+$where+" AND FTCstCode<>'' AND FTCstCode<>'0' ORDER BY FTShdDocNo OPTION(MAXDOP 1)"
     $lineSql='SELECT * FROM dbo.SCCRM_SalesExport_TPSTSalDT WHERE '+$where+' ORDER BY FTShdDocNo,FNSdtSeqNo OPTION(MAXDOP 1)'
     $first=@{headers=(Query $headerSql $params 50);lines=(Query $lineSql $params)}
     $second=@{headers=(Query $headerSql $params 50);lines=(Query $lineSql $params)}
     $rows=@{ok=$true;branch=$Branch;sourceId=('branch'+$Branch+'/AdaAcc');first=$first;second=$second;productionWrites=0;pinRead=$false}
    }
    'profiles' {
     if($req.codes.Count -lt 1 -or $req.codes.Count -gt 50){throw 'BRANCH_PROFILE_SCOPE_REFUSED'}
     $params=@{};$holders=@();for($n=0;$n -lt $req.codes.Count;$n++){if(([string]$req.codes[$n]) -cnotmatch ('^AR'+$Branch+'-[0-9]{6}$')){throw 'BRANCH_PROFILE_SCOPE_REFUSED'};$key='c'+$n;$params[$key]=[string]$req.codes[$n];$holders+='@'+$key}
     $rows=Query ('SELECT FTCstCode,FTCstName,FTCstTel,FTCstEmail,FTBchCode,FTCstStaActive FROM dbo.SCCRM_HistoryExport_LocalCustomers WHERE FTCstCode IN('+($holders -join ',')+') ORDER BY FTCstCode OPTION(MAXDOP 1)') $params 50
    }
    default{throw 'BRANCH_ACTION_REFUSED'}
   }
   [Console]::WriteLine((@{id=$req.id;ok=$true;rows=$rows}|ConvertTo-Json -Depth 10 -Compress))
  }catch{
   $e=$_.Exception.GetBaseException();$code=if($e.Message -cmatch '^BRANCH_[A-Z_]+$'){$e.Message}elseif($e -is [Data.SqlClient.SqlException]){'BRANCH_SQL_'+[Math]::Abs([long]$e.Number)}else{'BRANCH_SOURCE_READ_FAILED'}
   [Console]::WriteLine((@{id=$req.id;ok=$false;code=$code}|ConvertTo-Json -Compress))
   if($db.State -ne [Data.ConnectionState]::Open){break}
  }
 }
}catch{[Console]::WriteLine('{"ok":false,"code":"BRANCH_SOURCE_START_FAILED"}');exit 1}
finally{if($db){$db.Dispose()};if($builder){$builder.Password=''};if($target){$target.password=''}}
