param([ValidateSet('Copy','Live')][string]$Mode='Copy',[switch]$RollbackCopy)
$ErrorActionPreference='Stop';[Console]::InputEncoding=[Text.Encoding]::UTF8;[Console]::OutputEncoding=[Text.Encoding]::UTF8
$p=$null;$db=$null;$builder=$null;$q=$null;$r=$null;$copyTx=$null;$stage='packet'
try{
 $p=[Console]::In.ReadToEnd()|ConvertFrom-Json
 if($RollbackCopy -and $Mode -cne 'Copy'){throw 'RECEIPT_COPY_ONLY'}
 $t=$p.target;$branch=[string]$t.branch;$j=$p.job;$body=$j.payload
 if($p.scope -cne 'SCCRM-NATIVE-RECEIPT-V1' -or $branch -cnotmatch '^(000|001|003|004|005)$'){throw 'RECEIPT_SCOPE_REFUSED'}
 $peers=@{'000'=@('100.90.166.72','SERVER');'001'=@('100.81.137.41','SC_001');'003'=@('100.77.101.94','POSSRV');'004'=@('100.113.59.42','SERVER004');'005'=@('100.106.107.80','POSSRV')}
 if($Mode -ceq 'Copy'){
  if($t.server -cne 'tcp:100.90.166.72,49800' -or $t.machine -cne 'SERVER' -or $t.database -cne ('SCCRM_FanoutCopy_20261029_'+$branch)){throw 'RECEIPT_COPY_TARGET_REFUSED'}
 }else{
  $servers=if($branch -ceq '000'){@('tcp:127.0.0.1,49800','tcp:100.90.166.72,49800')}else{@($peers[$branch][0]+'\SQLEXPRESS')}
  if($t.server -cnotin $servers -or $t.machine -cne $peers[$branch][1] -or $t.database -cne 'AdaAcc' -or $p.credentials.user -cne ('sccrm_receipt_sync_'+$branch)){throw 'RECEIPT_LIVE_TARGET_REFUSED'}
 }
 if($j.targetBranch -cne $branch -or $body.operationId -cne $j.id -or $j.payloadHash -cnotmatch '^[a-f0-9]{64}$' -or
  $body.version -ne 1 -or $body.adaCode -cnotmatch '^[A-Z0-9-]{1,20}$' -or $body.receiptNo -cnotmatch '^[A-Z0-9-]{1,20}$' -or
  $body.branchCode -cnotmatch '^(001|003|004|005)$' -or $body.posCode -cnotmatch '^00[12]$' -or
  ($branch -cne '000' -and $body.branchCode -cne $branch) -or !$body.expectedName){throw 'RECEIPT_JOB_REFUSED'}
 $null=[guid]::Parse($j.id);$null=[guid]::Parse($body.memberId)
 if($body.lineAdjustments){if($body.lineAdjustments.policy -cne 'ada-exact-item-void-pairs'){throw 'RECEIPT_VOID_POLICY_REFUSED'};$lines=@($body.lineAdjustments.sourceItems)}else{$lines=@($body.items)}
 if($lines.Count -lt 1 -or $lines.Count -gt 1000){throw 'RECEIPT_ITEMS_REFUSED'}
 $xml=New-Object Xml.XmlDocument;$root=$xml.CreateElement('items');$null=$xml.AppendChild($root)
 foreach($line in $lines){
  $item=$xml.CreateElement('i');$values=@{seq=$line.seq;sku=$line.productCode;barcode=$line.barcode;unit=$line.unitCode;unitName=$line.unitName;qty=$line.qty;price=$line.unitPrice;net=$line.lineTotal;discount=$(if($null -eq $line.lineDiscount){0}else{$line.lineDiscount})}
  foreach($k in $values.Keys){$v=$values[$k];if($v -is [IFormattable]){$s=$v.ToString($null,[Globalization.CultureInfo]::InvariantCulture)}else{$s=[string]$v};$item.SetAttribute($k,$s)}
  $null=$root.AppendChild($item)
 }
 $builder=New-Object Data.SqlClient.SqlConnectionStringBuilder;$builder['Data Source']=$t.server;$builder['Initial Catalog']=$t.database
 $builder['User ID']=$p.credentials.user;$builder['Password']=$p.credentials.password;$builder['Connect Timeout']=5;$builder['Pooling']=$false;$builder['Application Name']='SCCRM-ReceiptSync-'+$Mode
 $stage='connect';$db=New-Object Data.SqlClient.SqlConnection $builder.ConnectionString;$db.Open();$builder['Password']='';$p.credentials.password=''
 $q=$db.CreateCommand();$q.CommandTimeout=5;$q.CommandText="SELECT CONVERT(varchar(128),SERVERPROPERTY('MachineName')) machine,DB_NAME() database_name,ORIGINAL_LOGIN() actor,IS_SRVROLEMEMBER('sysadmin') elevated,IS_MEMBER('db_owner') db_owner,IS_MEMBER('db_datawriter') writer"
 $r=$q.ExecuteReader();if(!$r.Read() -or $r['machine'] -cne $t.machine -or $r['database_name'] -cne $t.database){throw 'RECEIPT_DATABASE_REFUSED'}
 if($Mode -ceq 'Live' -and ($r['actor'] -cne ('sccrm_receipt_sync_'+$branch) -or $r['elevated'] -ne 0 -or $r['db_owner'] -ne 0 -or $r['writer'] -ne 0)){throw 'RECEIPT_WORKER_RIGHTS_EXCESSIVE'}
 $r.Dispose();$r=$null;$q.Dispose();$q=$null
 $stage='apply';if($RollbackCopy){$copyTx=$db.BeginTransaction()};$q=$db.CreateCommand();if($copyTx){$q.Transaction=$copyTx};$q.CommandTimeout=10;$q.CommandType=[Data.CommandType]::StoredProcedure;$q.CommandText='dbo.SCCRM_AttachReceiptMember'
 $values=@{OperationId=@([Data.SqlDbType]::UniqueIdentifier,[guid]$j.id);PayloadHash=@([Data.SqlDbType]::Char,[string]$j.payloadHash);AdaCode=@([Data.SqlDbType]::VarChar,[string]$body.adaCode);Branch=@([Data.SqlDbType]::Char,[string]$body.branchCode);Pos=@([Data.SqlDbType]::Char,[string]$body.posCode);Doc=@([Data.SqlDbType]::VarChar,[string]$body.receiptNo);ExpectedName=@([Data.SqlDbType]::NVarChar,[string]$body.expectedName);ExpectedPhone=@([Data.SqlDbType]::VarChar,$(if($body.expectedPhone){[string]$body.expectedPhone}else{[DBNull]::Value}));Items=@([Data.SqlDbType]::Xml,$xml.OuterXml)}
 $sizes=@{PayloadHash=64;AdaCode=20;Branch=3;Pos=3;Doc=20;ExpectedName=255;ExpectedPhone=30}
 foreach($k in $values.Keys){$v=$values[$k];$param=$q.Parameters.Add('@'+$k,$v[0]);if($sizes.ContainsKey($k)){$param.Size=$sizes[$k]};$param.Value=$v[1]}
 $sold=[DateTimeOffset]::Parse([string]$body.soldAt,[Globalization.CultureInfo]::InvariantCulture).ToOffset([TimeSpan]::FromHours(7)).DateTime
 $null=$q.Parameters.Add('@SoldDate',[Data.SqlDbType]::DateTime);$q.Parameters['@SoldDate'].Value=$sold.Date
 $null=$q.Parameters.Add('@SoldTime',[Data.SqlDbType]::VarChar,8);$q.Parameters['@SoldTime'].Value=$sold.ToString('HH:mm:ss',[Globalization.CultureInfo]::InvariantCulture)
 $param=$q.Parameters.Add('@Grand',[Data.SqlDbType]::Decimal);$param.Precision=20;$param.Scale=2;$param.Value=[decimal]::Parse([string]$body.totalAmount,[Globalization.CultureInfo]::InvariantCulture)
 $r=$q.ExecuteReader();if(!$r.Read()){throw 'RECEIPT_ACK_MISSING'}
 $ack=[ordered]@{};for($i=0;$i -lt $r.FieldCount;$i++){$ack[$r.GetName($i)]=[string]$r.GetValue($i)}
 if($r.Read()){throw 'RECEIPT_ACK_MULTIPLE'}
 $r.Dispose();$r=$null
 if($copyTx){$copyTx.Rollback();$copyTx.Dispose();$copyTx=$null}
 @{ok=$true;result=$ack}|ConvertTo-Json -Compress -Depth 5
}catch{
 $e=$_.Exception.GetBaseException();$message=$e.Message;$code=if($message -cmatch '^RECEIPT_[A-Z_0-9]+$'){$message}elseif($e -is [Data.SqlClient.SqlException] -and $e.Number -in @(-2,53,64,121,233,258,1205,1222,10053,10054,10060)){'RECEIPT_SOURCE_RETRY'}else{'RECEIPT_SOURCE_UNAVAILABLE'}
 @{ok=$false;code=$code;stage=$stage;detailsWithheld=$true}|ConvertTo-Json -Compress;exit 1
}finally{if($r){$r.Dispose()};if($q){$q.Dispose()};if($copyTx){try{$copyTx.Rollback()}catch{};$copyTx.Dispose()};if($db){$db.Dispose()};if($builder){$builder['Password']=''};if($p){$p.credentials.password=''}}
