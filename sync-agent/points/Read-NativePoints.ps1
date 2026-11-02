param([ValidateSet('Live','Copy')][string]$Mode='Copy')
# Static SELECT-only source export. Credentials arrive on stdin, never arguments.
$ErrorActionPreference='Stop'
[Console]::InputEncoding=[Text.Encoding]::UTF8
[Console]::OutputEncoding=[Text.Encoding]::UTF8
$db=$null;$b=$null;$p=$null;$stage='packet'
$Scope='SCCRM-ADA-POINTS-EXPORT-20261102'
function Read-Rows([string]$Sql){
 $q=$db.CreateCommand();$q.CommandTimeout=8;$q.CommandText=$Sql
 $r=$null;$rows=New-Object Collections.Generic.List[object]
 try{
  $r=$q.ExecuteReader()
  while($r.Read()){
   $row=[ordered]@{}
   for($i=0;$i -lt $r.FieldCount;$i++){
    $v=if($r.IsDBNull($i)){$null}else{$r.GetValue($i)}
    if($v -is [datetime]){$v=$v.ToString('yyyy-MM-ddTHH:mm:ss.fff',[Globalization.CultureInfo]::InvariantCulture)}
    elseif($v -is [long] -or $v -is [decimal]){$v=$v.ToString([Globalization.CultureInfo]::InvariantCulture)}
    elseif($v -is [double] -or $v -is [single]){$v=$v.ToString('R',[Globalization.CultureInfo]::InvariantCulture)}
    elseif($v -is [guid]){$v=$v.ToString().ToLowerInvariant()}
    $row[$r.GetName($i)]=$v
   }
   $rows.Add([pscustomobject]$row)
  }
  return ,$rows.ToArray()
 }finally{if($r){$r.Dispose()};$q.Dispose()}
}
function Sha256([string]$Value){
 $h=[Security.Cryptography.SHA256]::Create()
 try{return ([BitConverter]::ToString($h.ComputeHash([Text.Encoding]::UTF8.GetBytes($Value)))).Replace('-','').ToLowerInvariant()}finally{$h.Dispose()}
}
function Snapshot-Hash([object[]]$Customers,[object[]]$Points,[object[]]$Balances,[object]$Owned){return Sha256 (([ordered]@{customers=$Customers;points=$Points;balances=$Balances;ownedCompensation=$Owned})|ConvertTo-Json -Depth 8 -Compress)}
function Read-Owned {
 $objects=Read-Rows "SELECT OBJECT_ID('dbo.SCCRM_PointSyncMeta','U') meta_id,OBJECT_ID('dbo.SCCRM_PointSyncReceipts','U') receipts_id"
 if($objects.Count -ne 1){throw 'POINT_EXPORT_OWNED_OBJECTS_REFUSED'}
 if($null -eq $objects[0].meta_id -and $null -eq $objects[0].receipts_id){return [pscustomobject][ordered]@{present=$false;meta=@();receipts=@()}}
 if($null -eq $objects[0].meta_id -or $null -eq $objects[0].receipts_id){throw 'POINT_EXPORT_OWNED_PARTIAL_SCHEMA'}
 $meta=Read-Rows "SELECT singleton,marker,target_identity,branch_code FROM dbo.SCCRM_PointSyncMeta ORDER BY singleton OPTION(MAXDOP 1)"
 if($meta.Count -ne 1 -or $meta[0].singleton -ne 1 -or $meta[0].marker -cne '238ecf14-fda8-46a8-bc34-d663659b2202' -or $meta[0].target_identity -cne $databaseIdentity -or $meta[0].branch_code -cne $branch){throw 'POINT_EXPORT_OWNED_IDENTITY_REFUSED'}
 $receipts=Read-Rows "SELECT TOP(100001) operation_id,ada_code,branch_code,ref_doc,revision,generation,expected_intrinsic,previous_balance,target_balance,delta_points,created_at FROM dbo.SCCRM_PointSyncReceipts ORDER BY operation_id OPTION(MAXDOP 1)"
 if($receipts.Count -gt 100000){throw 'POINT_EXPORT_OWNED_SCOPE_LIMIT'}
 return [pscustomobject][ordered]@{present=$true;meta=$meta;receipts=$receipts}
}
try{
 $started=[datetime]::UtcNow.ToString('o')
 $p=[Console]::In.ReadToEnd()|ConvertFrom-Json
 if($p.scope -cne $Scope -or [string]$p.branch -cnotmatch '^(000|001|003|004|005)$'){throw 'POINT_EXPORT_SCOPE_REFUSED'}
 $machines=@{'000'='SERVER';'001'='SC_001';'003'='POSSRV';'004'='SERVER004';'005'='POSSRV'}
 $ips=@{'000'='100.90.166.72';'001'='100.81.137.41';'003'='100.77.101.94';'004'='100.113.59.42';'005'='100.106.107.80'}
 $database='AdaAcc';$branch=[string]$p.branch;$machine=$machines[$branch];$sourceIp=$ips[$branch]
 $pointCopy=$false
 if($Mode -ceq 'Copy'){
  if($p.copyKind -ceq 'PointCopy' -and $p.database -ceq ('SCCRM_PointCopy_20261102_'+$branch)){
   $database=[string]$p.database;$machine='SERVER';$sourceIp=$ips['000'];$pointCopy=$true
  }elseif($branch -ceq '000' -and $p.database -ceq 'SCCRM_UiSandbox_20261024_142127'){$database='SCCRM_UiSandbox_20261024_142127'}
  else{throw 'POINT_EXPORT_COPY_DATABASE_REFUSED'}
 }elseif($p.database -cne 'AdaAcc'){throw 'POINT_EXPORT_DATABASE_REFUSED'}
 if($p.machine -cne $machine -or $p.sourceHost -cne $sourceIp -or $p.effectiveConfigRead -ne $true){throw 'POINT_EXPORT_CONFIG_PROVENANCE_REFUSED'}
 $server=[string]$p.server
 if($server -cnotmatch ('^(tcp:)?'+[regex]::Escape($sourceIp)+'(,\d{1,5}|\\SQLEXPRESS)?$')){throw 'POINT_EXPORT_SERVER_REFUSED'}
 if(!$p.admin.user -or !$p.admin.password){throw 'POINT_EXPORT_CREDENTIAL_REQUIRED'}
 $stage='connect'
 $b=New-Object Data.SqlClient.SqlConnectionStringBuilder
 $b['Data Source']=$server;$b['Initial Catalog']=$database;$b['User ID']=$p.admin.user;$b['Password']=$p.admin.password
 $b['Connect Timeout']=8;$b['Pooling']=$false;$b['Application Name']='SCCRM-AdaPoints-SELECT-ONLY'
 $db=New-Object Data.SqlClient.SqlConnection $b.ConnectionString
 $db.Open();$b['Password']='';$p.admin.password=''
 $stage='identity'
 $identity=Read-Rows "SET LOCK_TIMEOUT 1000;SET DEADLOCK_PRIORITY LOW;SET TRANSACTION ISOLATION LEVEL READ COMMITTED;SELECT CONVERT(varchar(128),SERVERPROPERTY('MachineName')) machine,DB_NAME() db"
 if($identity.Count -ne 1 -or $identity[0].machine -cne $machine -or $identity[0].db -cne $database){throw 'POINT_EXPORT_IDENTITY_REFUSED'}
 $databaseIdentity=if($pointCopy){'copy'+$branch+'/'+$machine+'/'+$database}else{$branch+'/'+$machine+'/'+$database}
 if($Mode -ceq 'Copy'){
  if($pointCopy){$guard=Read-Rows "SELECT CONVERT(nvarchar(36),value) marker FROM sys.extended_properties WHERE class=0 AND name='SCCRM_PointCopyMarker'";$expectedMarker='238ecf14-fda8-46a8-bc34-d663659b2202'}
  else{$guard=Read-Rows "SELECT CONVERT(nvarchar(36),value) marker FROM sys.extended_properties WHERE class=0 AND name='SCCRM_SandboxMarker'";$expectedMarker='6d42574b-3e90-4d92-aa5d-4c4920a08cbe'}
  if($guard.Count -ne 1 -or $guard[0].marker -cne $expectedMarker){throw 'POINT_EXPORT_COPY_MARKER_REFUSED'}
 }
 $stage='schema'
 $columns=Read-Rows "SELECT OBJECT_NAME(c.object_id) object_name,c.name,TYPE_NAME(c.system_type_id) data_type,c.max_length,c.precision,c.scale FROM sys.columns c WHERE c.object_id IN(OBJECT_ID('dbo.TCNTCstPoint'),OBJECT_ID('dbo.VCN_TCNMPdtCstPointAmt')) OR(c.object_id=OBJECT_ID('dbo.TCNMCst') AND c.name IN('FTCstCode','FCCstRetPoint','FCCstRetAmt','FCCstWhsPoint','FCCstDailyPoint','FTBchCode','FDCstLastPoint','FDDateUpd','FTTimeUpd')) ORDER BY object_name,c.name"
 $pk=Read-Rows "SELECT c.name,k.key_ordinal FROM sys.indexes i JOIN sys.index_columns k ON k.object_id=i.object_id AND k.index_id=i.index_id JOIN sys.columns c ON c.object_id=k.object_id AND c.column_id=k.column_id WHERE i.object_id=OBJECT_ID('dbo.TCNTCstPoint') AND i.is_primary_key=1 ORDER BY k.key_ordinal"
 $views=Read-Rows "SELECT m.definition FROM sys.sql_modules m WHERE m.object_id=OBJECT_ID('dbo.VCN_TCNMPdtCstPointAmt')"
 if($views.Count -ne 1 -or !$views[0].definition){throw 'POINT_EXPORT_VIEW_REQUIRED'}
 $definition=[string]$views[0].definition
 $viewHash=Sha256 (($definition -replace '\s+',' ').Trim().ToLowerInvariant())
 if($viewHash -cne 'e6e48b1f9c1a69a3bdf53098530c2dbaffb7e2a9b3f7ee0440c78202cf3a7fa4'){throw 'POINT_EXPORT_NATIVE_VIEW_CHANGED'}
 $pointNames=@('FTBchCode','FTCstCode','FTPntRefDoc','FTSplCode','FDPntDate','FCPntPointbyOne','FCPntAmtRcv','FNPntPoint','FNPntPointOld','FTPntExpired','FTPntStaPrcDoc','FTPntCardType','FTCptJDate','FTCptTime','FDPntSplStart','FDPntSplExpired','FTPntStaExpired','FDDateUpd','FTTimeUpd','FTWhoUpd','FDDateIns','FTTimeIns','FTWhoIns')
 $actualNames=@($columns|Where-Object{$_.object_name -ceq 'TCNTCstPoint'}|ForEach-Object{$_.name})
 if($actualNames.Count -ne $pointNames.Count -or @($actualNames|Where-Object{$_ -cnotin $pointNames}).Count -ne 0){throw 'POINT_EXPORT_POINT_SCHEMA_CHANGED'}
 if((@($pk|ForEach-Object{$_.name}) -join ',') -cne 'FTBchCode,FTCstCode,FTPntRefDoc,FTSplCode'){throw 'POINT_EXPORT_POINT_KEY_CHANGED'}
 $stage='customers'
 $customers=Read-Rows "SELECT TOP(20001) FTCstCode,FCCstRetPoint,FCCstRetAmt,FCCstWhsPoint,FCCstDailyPoint,FTBchCode,FDCstLastPoint,FDDateUpd,FTTimeUpd FROM dbo.TCNMCst ORDER BY FTCstCode OPTION(MAXDOP 1)"
 if($customers.Count -gt 20000){throw 'POINT_EXPORT_CUSTOMER_SCOPE_LIMIT'}
 $stage='points'
 $points=Read-Rows "SELECT TOP(100001) FTBchCode,FTCstCode,FTPntRefDoc,FTSplCode,FDPntDate,FCPntPointbyOne,FCPntAmtRcv,FNPntPoint,FNPntPointOld,FTPntExpired,FTPntStaPrcDoc,FTPntCardType,FTCptJDate,FTCptTime,FDPntSplStart,FDPntSplExpired,FTPntStaExpired,FDDateUpd,FTTimeUpd,FTWhoUpd,FDDateIns,FTTimeIns,FTWhoIns FROM dbo.TCNTCstPoint ORDER BY FTBchCode,FTCstCode,FTPntRefDoc,FTSplCode OPTION(MAXDOP 1)"
 if($points.Count -gt 100000){throw 'POINT_EXPORT_POINT_SCOPE_LIMIT'}
 $stage='view'
 $balances=Read-Rows "SELECT TOP(20001) FTCstCode,FNPntPoint,FCPntAmtRcv FROM dbo.VCN_TCNMPdtCstPointAmt ORDER BY FTCstCode OPTION(MAXDOP 1)"
 if($balances.Count -gt 20000){throw 'POINT_EXPORT_VIEW_SCOPE_LIMIT'}
 $stage='owned-proof';$owned=Read-Owned
 $firstHash=Snapshot-Hash $customers $points $balances $owned
 # No long transaction or source setting changes: repeat the same projections
 # and preserve a stability proof. A changed capture is held by the model.
 $stage='stability'
 $againCustomers=Read-Rows "SELECT TOP(20001) FTCstCode,FCCstRetPoint,FCCstRetAmt,FCCstWhsPoint,FCCstDailyPoint,FTBchCode,FDCstLastPoint,FDDateUpd,FTTimeUpd FROM dbo.TCNMCst ORDER BY FTCstCode OPTION(MAXDOP 1)"
 $againPoints=Read-Rows "SELECT TOP(100001) FTBchCode,FTCstCode,FTPntRefDoc,FTSplCode,FDPntDate,FCPntPointbyOne,FCPntAmtRcv,FNPntPoint,FNPntPointOld,FTPntExpired,FTPntStaPrcDoc,FTPntCardType,FTCptJDate,FTCptTime,FDPntSplStart,FDPntSplExpired,FTPntStaExpired,FDDateUpd,FTTimeUpd,FTWhoUpd,FDDateIns,FTTimeIns,FTWhoIns FROM dbo.TCNTCstPoint ORDER BY FTBchCode,FTCstCode,FTPntRefDoc,FTSplCode OPTION(MAXDOP 1)"
 $againBalances=Read-Rows "SELECT TOP(20001) FTCstCode,FNPntPoint,FCPntAmtRcv FROM dbo.VCN_TCNMPdtCstPointAmt ORDER BY FTCstCode OPTION(MAXDOP 1)"
 if($againCustomers.Count -gt 20000 -or $againPoints.Count -gt 100000 -or $againBalances.Count -gt 20000){throw 'POINT_EXPORT_STABILITY_SCOPE_LIMIT'}
 $againOwned=Read-Owned
 $secondHash=Snapshot-Hash $againCustomers $againPoints $againBalances $againOwned
 $againCustomers=$null;$againPoints=$null;$againBalances=$null
 $db.Dispose();$db=$null
 [ordered]@{ok=$true;scope=$Scope;mode=$Mode;branch=$branch;captureStartedAt=$started;captureCompletedAt=[datetime]::UtcNow.ToString('o');identity=$identity[0];databaseIdentity=$databaseIdentity;schema=[ordered]@{columns=$columns;pointPrimaryKey=$pk;viewDefinition=$definition;viewHash=$viewHash};customers=$customers;points=$points;balances=$balances;ownedCompensation=$owned;sourceConsistency=[ordered]@{stable=($firstHash -ceq $secondHash);firstHash=$firstHash;secondHash=$secondHash;method='two-complete-read-committed-passes'};productionWrites=0;pinRead=$false}|ConvertTo-Json -Depth 12 -Compress
}catch{
 $e=$_.Exception.GetBaseException()
 [ordered]@{ok=$false;scope=$Scope;branch=if($p){$p.branch}else{$null};code=if($e.Message -cmatch '^[A-Z_]{5,100}$'){$e.Message}else{'POINT_EXPORT_READ_FAILED'};stage=$stage;sqlNumber=if($e -is [Data.SqlClient.SqlException]){$e.Number}else{$null};productionWrites=0;pinRead=$false}|ConvertTo-Json -Compress
 exit 1
}finally{if($db){$db.Dispose()};if($b){$b['Password']=''};if($p -and $p.admin){$p.admin.password=''}}
