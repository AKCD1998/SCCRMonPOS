param()
# Bootstrap/operator read only. Credentials arrive through stdin and never leave
# this process. The output is a private customer packet for the parent importer.
$ErrorActionPreference='Stop'
[Console]::InputEncoding=[Text.Encoding]::UTF8;[Console]::OutputEncoding=[Text.Encoding]::UTF8
$p=$null;$db=$null;$builder=$null
try {
 $p=[Console]::In.ReadToEnd()|ConvertFrom-Json;$a=$p.admin;$r=$p.receipt;$branch=[string]$p.branch
 $targets=@{'001'=@('100.81.137.41\SQLEXPRESS','SC_001');'003'=@('100.77.101.94\SQLEXPRESS','POSSRV');'004'=@('100.113.59.42\SQLEXPRESS','SERVER004');'005'=@('100.106.107.80\SQLEXPRESS','POSSRV')}
 if($p.scope -cne 'SCCRM-READ-BRANCH-HISTORY-PROFILE-V1' -or !$targets.ContainsKey($branch)) {throw 'BRANCH_PROFILE_SCOPE_REFUSED'}
 $target=$targets[$branch]
 if($a.branch -cne $branch -or $a.database -cne 'AdaAcc' -or $a.server -cne $target[0] -or $a.machine -ine $target[1] -or !$a.provenance.effectiveConfigRead -or !$a.provenance.readonlySqlIdentityVerified -or $a.provenance.remoteFilesWritten -ne 0) {throw 'BRANCH_PROFILE_SOURCE_REFUSED'}
 if($r.branchCode -cne $branch -or $r.adaCode -cnotmatch ('^AR'+$branch+'-[0-9]{6}$') -or $r.posCode -cnotmatch '^[A-Za-z0-9]{1,10}$' -or $r.receiptNo -cnotmatch '^[A-Z0-9-]{1,20}$') {throw 'BRANCH_PROFILE_RECEIPT_REFUSED'}
 $builder=New-Object Data.SqlClient.SqlConnectionStringBuilder
 $builder['Data Source']=$a.server;$builder['Initial Catalog']='AdaAcc';$builder['User ID']=$a.user;$builder['Password']=$a.password;$builder['Connect Timeout']=5;$builder['Pooling']=$false;$builder['Application Name']='SCCRM-Branch-History-Profile-SELECT-ONLY'
 $db=New-Object Data.SqlClient.SqlConnection $builder.ConnectionString;$db.Open();$builder.Password='';$a.password=''
 $session=$db.CreateCommand();$session.CommandText='SET LOCK_TIMEOUT 750;SET DEADLOCK_PRIORITY LOW;';$null=$session.ExecuteNonQuery();$session.Dispose()
 function Read-Profile([string]$sql) {
  if($sql.TrimStart() -cnotmatch '^SELECT\b' -or $sql -match '(?i)\b(INSERT|UPDATE|DELETE|MERGE|ALTER|CREATE|DROP|TRUNCATE|INTO|EXEC)\b') {throw 'BRANCH_PROFILE_NON_SELECT_REFUSED'}
  $q=$db.CreateCommand();$q.CommandText=$sql;$q.CommandTimeout=5
  foreach($entry in @(@('branch',$branch),@('code',[string]$r.adaCode),@('doc',[string]$r.receiptNo),@('pos',[string]$r.posCode))) {$param=$q.Parameters.Add('@'+$entry[0],[Data.SqlDbType]::VarChar,20);$param.Value=$entry[1]}
  $reader=$null;$rows=New-Object Collections.Generic.List[object]
  try {$reader=$q.ExecuteReader();while($reader.Read()) {
   if($rows.Count -ge 1) {throw 'BRANCH_PROFILE_AMBIGUOUS'}
   $row=[ordered]@{};for($i=0;$i -lt $reader.FieldCount;$i++) {
    $v=if($reader.IsDBNull($i)){$null}else{$reader.GetValue($i)}
    if($v -is [DateTime]) {$v=$v.ToString('yyyy-MM-ddTHH:mm:ss.fff',[Globalization.CultureInfo]::InvariantCulture)}
    elseif($v -is [decimal]) {$v=$v.ToString([Globalization.CultureInfo]::InvariantCulture)}
    $row[$reader.GetName($i)]=$v
   };$rows.Add([pscustomobject]$row)
  };return ,$rows.ToArray()} finally {if($reader){$reader.Dispose()};$q.Dispose()}
 }
 $identity=Read-Profile "SELECT CONVERT(varchar(128),SERVERPROPERTY('MachineName')) machine,DB_NAME() db"
 if($identity.Count -ne 1 -or $identity[0].machine -ine $target[1] -or $identity[0].db -cne 'AdaAcc') {throw 'BRANCH_PROFILE_IDENTITY_REFUSED'}
 $headers=Read-Profile "SELECT FTBchCode,FTPosCode,FTShdDocNo,FTShdDocType,FTCstCode,FTShdStaPaid,FDShdDocDate,FTShdDocTime,FCShdGrand FROM dbo.TPSTSalHD WHERE FTBchCode=@branch AND FTPosCode=@pos AND FTShdDocNo=@doc AND FTCstCode=@code AND FTShdStaPaid='3' AND FTShdDocType IN('1','9') OPTION(MAXDOP 1)"
 if($headers.Count -ne 1) {throw 'BRANCH_PROFILE_RECEIPT_NOT_FOUND'}
 $customers=Read-Profile "SELECT FTCstCode,FTCstName,FTCstTel,FTCstEmail,FTBchCode,FTCstStaActive FROM dbo.TCNMCst WHERE FTCstCode=@code AND FTBchCode=@branch OPTION(MAXDOP 1)"
 if($customers.Count -ne 1) {throw 'BRANCH_PROFILE_NOT_FOUND'}
 @{ok=$true;branch=$branch;nativeSourceId=('branch'+$branch+'/AdaAcc');customer=$customers[0];header=$headers[0];productionWrites=0;pinRead=$false}|ConvertTo-Json -Depth 6 -Compress
} catch {$e=$_.Exception.GetBaseException();@{ok=$false;code=$(if($e.Message -cmatch '^BRANCH_PROFILE_[A-Z_]+$'){$e.Message}else{'BRANCH_PROFILE_READ_FAILED'});detailsWithheld=$true}|ConvertTo-Json -Compress;exit 1}
finally {if($db){$db.Dispose()};if($builder){$builder.Password=''};if($p){$p.admin.password=''}}
