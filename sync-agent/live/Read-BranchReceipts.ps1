param()
# Operator-only bounded native archive reads. No credentials or raw data logs.
$ErrorActionPreference='Stop';[Console]::InputEncoding=[Text.Encoding]::UTF8;[Console]::OutputEncoding=[Text.Encoding]::UTF8
$p=$null;$db=$null;$builder=$null
try {
 $p=[Console]::In.ReadToEnd()|ConvertFrom-Json;$branch=[string]$p.branch;$a=$p.admin
 $targets=@{'001'=@('100.81.137.41\SQLEXPRESS','SC_001');'003'=@('100.77.101.94\SQLEXPRESS','POSSRV');'004'=@('100.113.59.42\SQLEXPRESS','SERVER004');'005'=@('100.106.107.80\SQLEXPRESS','POSSRV')}
 if($p.scope -cne 'SCCRM-READ-BRANCH-RECEIPTS-V1' -or !$targets.ContainsKey($branch) -or $p.documents.Count -lt 1 -or $p.documents.Count -gt 50){throw 'BRANCH_RECEIPTS_SCOPE_REFUSED'}
 $target=$targets[$branch]
 if($a.branch -cne $branch -or $a.database -cne 'AdaAcc' -or $a.server -cne $target[0] -or $a.machine -ine $target[1] -or !$a.provenance.effectiveConfigRead -or !$a.provenance.readonlySqlIdentityVerified -or $a.provenance.remoteFilesWritten -ne 0){throw 'BRANCH_RECEIPTS_SOURCE_REFUSED'}
 foreach($d in $p.documents){if($d.doc -cnotmatch '^[SR][0-9]{10}-[0-9]{7}$' -or $d.table -cnotin @('TPSTSalHD','TSHD001','TSHD002')){throw 'BRANCH_RECEIPTS_DOCUMENT_REFUSED'}}
 $builder=New-Object Data.SqlClient.SqlConnectionStringBuilder;$builder['Data Source']=$a.server;$builder['Initial Catalog']='AdaAcc';$builder['User ID']=$a.user;$builder['Password']=$a.password;$builder['Connect Timeout']=5;$builder['Pooling']=$false;$builder['Application Name']='SCCRM-Branch-Archive-SELECT-ONLY'
 $db=New-Object Data.SqlClient.SqlConnection $builder.ConnectionString;$db.Open();$builder.Password='';$a.password=''
 function Query([string]$sql,[hashtable]$parameters=@{},[int]$limit=5000){
  if($sql.TrimStart() -cnotmatch '^SELECT\b' -or $sql -match '(?i)\b(INSERT|UPDATE|DELETE|MERGE|ALTER|CREATE|DROP|TRUNCATE|INTO|EXEC)\b'){throw 'BRANCH_RECEIPTS_NON_SELECT_REFUSED'}
  $q=$db.CreateCommand();$q.CommandText=$sql;$q.CommandTimeout=8;foreach($key in $parameters.Keys){$param=$q.Parameters.Add('@'+$key,[Data.SqlDbType]::VarChar,20);$param.Value=$parameters[$key]}
  $reader=$null;$rows=New-Object Collections.Generic.List[object]
  try{$reader=$q.ExecuteReader();while($reader.Read()){
   if($rows.Count -ge $limit){throw 'BRANCH_RECEIPTS_ROW_LIMIT'}
   $row=[ordered]@{};for($i=0;$i -lt $reader.FieldCount;$i++){
    $v=if($reader.IsDBNull($i)){$null}else{$reader.GetValue($i)}
    if($v -is [DateTime]){$v=$v.ToString('yyyy-MM-ddTHH:mm:ss.fff',[Globalization.CultureInfo]::InvariantCulture)}
    elseif($v -is [double] -or $v -is [single]){$v=$v.ToString('R',[Globalization.CultureInfo]::InvariantCulture)}
    elseif($v -is [decimal] -or $v -is [long]){$v=$v.ToString([Globalization.CultureInfo]::InvariantCulture)}
    $row[$reader.GetName($i)]=$v
   };$rows.Add([pscustomobject]$row)
  };return ,$rows.ToArray()}finally{if($reader){$reader.Dispose()};$q.Dispose()}
 }
 $q=$db.CreateCommand();$q.CommandText='SET LOCK_TIMEOUT 750;SET DEADLOCK_PRIORITY LOW;';$null=$q.ExecuteNonQuery();$q.Dispose()
 $identity=Query "SELECT CONVERT(varchar(128),SERVERPROPERTY('MachineName')) machine,DB_NAME() db" @{} 1
 if($identity.Count -ne 1 -or $identity[0].machine -ine $target[1] -or $identity[0].db -cne 'AdaAcc'){throw 'BRANCH_RECEIPTS_IDENTITY_REFUSED'}
 $columnCache=@{}
 function Columns([string]$table){
  if(!$columnCache.ContainsKey($table)){
   $columns=Query 'SELECT name FROM sys.columns WHERE object_id=OBJECT_ID(@table) ORDER BY column_id' @{table=('dbo.'+$table)} 500
   $names=@();foreach($column in $columns){if($column.name -cnotmatch '^[A-Za-z0-9_]+$'){throw 'BRANCH_RECEIPTS_COLUMN_REFUSED'};if($column.name -notmatch '(?i)pin|password|secret|token'){$names+='['+$column.name+']'}}
   if(!$names.Count){throw 'BRANCH_RECEIPTS_COLUMNS_REQUIRED'};$columnCache[$table]=$names -join ','
  };return $columnCache[$table]
 }
 function Snapshot {
  $headers=New-Object Collections.Generic.List[object];$lines=New-Object Collections.Generic.List[object]
  foreach($group in @($p.documents|Group-Object table)){
   $table=[string]$group.Name;$detail=if($table -ceq 'TPSTSalHD'){'TPSTSalDT'}else{$table.Replace('TSHD','TSDT')}
   $params=@{branch=$branch};$holders=@();$n=0;foreach($document in $group.Group){$key='d'+$n++;$params[$key]=[string]$document.doc;$holders+='@'+$key}
   $where='FTBchCode=@branch AND FTShdDocNo IN('+($holders -join ',')+')'
   $hs=Query ('SELECT '+(Columns $table)+' FROM dbo.['+$table+"] WHERE "+$where+" AND FTShdStaPaid='3' AND FTShdStaDoc='1' AND FTShdDocType IN('1','9') AND FTCstCode<>'' AND FTCstCode<>'0' ORDER BY FTShdDocNo OPTION(MAXDOP 1)") $params 50
   foreach($row in $hs){$headers.Add($row)}
   $ls=Query ('SELECT '+(Columns $detail)+' FROM dbo.['+$detail+'] WHERE '+$where+' ORDER BY FTShdDocNo,FNSdtSeqNo OPTION(MAXDOP 1)') $params
   foreach($row in $ls){if(@($hs|Where-Object {$_.FTShdDocNo -ceq $row.FTShdDocNo}).Count -eq 1){$lines.Add($row)}}
  }
  return @{headers=$headers.ToArray();lines=$lines.ToArray()}
 }
 $first=Snapshot;$second=Snapshot
 @{ok=$true;branch=$branch;sourceId=('branch'+$branch+'/AdaAcc');first=$first;second=$second;productionWrites=0;pinRead=$false}|ConvertTo-Json -Depth 8 -Compress
}catch{$e=$_.Exception.GetBaseException();@{ok=$false;code=$(if($e.Message -cmatch '^BRANCH_RECEIPTS_[A-Z_]+$'){$e.Message}else{'BRANCH_RECEIPTS_READ_FAILED'});detailsWithheld=$true}|ConvertTo-Json -Compress;exit 1}
finally{if($db){$db.Dispose()};if($builder){$builder.Password=''};if($p){$p.admin.password=''}}
