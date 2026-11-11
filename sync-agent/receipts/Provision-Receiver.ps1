param([ValidateSet('Preflight','Install')][string]$Action='Preflight')
$ErrorActionPreference='Stop';[Console]::InputEncoding=[Text.Encoding]::UTF8;[Console]::OutputEncoding=[Text.Encoding]::UTF8
$db=$null;$p=$null;$builder=$null;$tx=$null;$stage='packet'
function Rows([string]$sql){$cmd=$db.CreateCommand();$cmd.CommandText=$sql;$cmd.CommandTimeout=10;if($tx){$cmd.Transaction=$tx};$r=$null;$out=@();try{$r=$cmd.ExecuteReader();while($r.Read()){$v=[ordered]@{};for($i=0;$i -lt $r.FieldCount;$i++){$v[$r.GetName($i)]=if($r.IsDBNull($i)){$null}else{$r.GetValue($i)}};$out+=[pscustomobject]$v};return ,$out}finally{if($r){$r.Dispose()};$cmd.Dispose()}}
function Run([string]$sql){$cmd=$db.CreateCommand();$cmd.CommandText=$sql;$cmd.CommandTimeout=10;if($tx){$cmd.Transaction=$tx};try{$null=$cmd.ExecuteNonQuery()}finally{$cmd.Dispose()}}
try{
 $p=[Console]::In.ReadToEnd()|ConvertFrom-Json;$b=[string]$p.branch
 $peers=@{'000'=@('100.90.166.72','SERVER');'001'=@('100.81.137.41','SC_001');'003'=@('100.77.101.94','POSSRV');'004'=@('100.113.59.42','SERVER004');'005'=@('100.106.107.80','POSSRV')}
 if($p.scope -cne 'SCCRM-RECEIPT-RECEIVER-PROVISION-V1' -or !$peers.ContainsKey($b)){throw 'RECEIPT_PROVISION_SCOPE_REFUSED'}
 $endpoint=if($b -ceq '000'){'tcp:100.90.166.72,49800'}else{$peers[$b][0]+'\SQLEXPRESS'}
 $builder=New-Object Data.SqlClient.SqlConnectionStringBuilder;$builder['Data Source']=$endpoint;$builder['Initial Catalog']='AdaAcc';$builder['User ID']=$p.admin.user;$builder['Password']=$p.admin.password;$builder['Connect Timeout']=5;$builder['Pooling']=$false;$builder['Application Name']='SCCRM-Receipt-Receiver-Provision'
 $stage='connect';$db=New-Object Data.SqlClient.SqlConnection $builder.ConnectionString;$db.Open();$builder['Password']='';$p.admin.password=''
 Run 'SET DEADLOCK_PRIORITY LOW;SET LOCK_TIMEOUT 1000;'
 $identity=Rows "SELECT CONVERT(varchar(128),SERVERPROPERTY('MachineName')) machine,DB_NAME() db,IS_SRVROLEMEMBER('sysadmin') elevated"
 if($identity.Count -ne 1 -or $identity[0].machine -cne $peers[$b][1] -or $identity[0].db -cne 'AdaAcc' -or $identity[0].elevated -ne 1){throw 'RECEIPT_PROVISION_TARGET_REFUSED'}
 $stage='schema';$headers=Rows "SELECT name FROM sys.tables WHERE schema_id=SCHEMA_ID('dbo') AND(name IN('TPSTSalHD','TSHD001','TSHD002')) ORDER BY name"
 if(!$headers.Count){throw 'RECEIPT_PROVISION_SALE_SCHEMA_REQUIRED'}
 $active=Rows "SELECT tr.name FROM sys.triggers tr JOIN sys.tables t ON t.object_id=tr.parent_id WHERE tr.is_disabled=0 AND t.name IN('TPSTSalHD','TSHD001','TSHD002')"
 if($active.Count){throw 'RECEIPT_PROVISION_NATIVE_TRIGGER_REVIEW_REQUIRED'}
 foreach($h in $headers){
  $name=[string]$h.name;$cols=Rows ("SELECT name FROM sys.columns WHERE object_id=OBJECT_ID('dbo."+$name+"')")
  foreach($column in @('FTShdDocNo','FTBchCode','FTPosCode','FTCstCode','FTShdDocType','FTShdStaPaid','FTShdStaDoc','FCShdGrand','FDShdDocDate','FTShdDocTime')){if($column -cnotin $cols.name){throw 'RECEIPT_PROVISION_HEADER_REVIEW_REQUIRED'}}
 }
 $login='sccrm_receipt_sync_'+$b
 $existing=Rows "SELECT name FROM sys.objects WHERE schema_id=SCHEMA_ID('dbo') AND name IN('SCCRM_ReceiptSyncMeta','SCCRM_ReceiptSyncJournal','SCCRM_AttachReceiptMember')"
 if($existing.Count){
  if($existing.Count -ne 3){throw 'RECEIPT_PROVISION_EXISTING_OBJECT_REFUSED'}
  $own=Rows "SELECT singleton,CONVERT(varchar(36),marker) marker,target_branch,worker_login FROM dbo.SCCRM_ReceiptSyncMeta"
  if($own.Count -ne 1 -or $own[0].marker -cne 'ab01553b-576c-465e-af30-87daa20e2d33' -or $own[0].target_branch -cne $b -or $own[0].worker_login -cne $login){throw 'RECEIPT_PROVISION_EXISTING_OBJECT_REFUSED'}
  if($Action -ceq 'Install'){throw 'RECEIPT_PROVISION_ALREADY_INSTALLED'}
 }
 $counts=(Rows 'SELECT COUNT(*) customers FROM dbo.TCNMCst')[0]
 if($Action -ceq 'Install'){
  $stage='copy-proof'
  $expected=([string]$p.copyProof.receiverHash)
  $actual=(Get-FileHash -LiteralPath (Join-Path $PSScriptRoot 'native-receiver.sql') -Algorithm SHA256).Hash.ToLowerInvariant()
  if($p.copyProof.ok -ne $true -or $p.copyProof.productionWrites -ne 0 -or $expected -cne $actual -or @($p.copyProof.branches).Count -ne 5 -or ('000','001','003','004','005'|Where-Object{$_ -cnotin @($p.copyProof.branches)}).Count){throw 'RECEIPT_PROVISION_COPY_PROOF_REQUIRED'}
  if([string]$p.workerPassword -cnotmatch '^Sc![a-f0-9]{56}$'){throw 'RECEIPT_PROVISION_CREDENTIAL_REFUSED'}
  if((Rows "SELECT name FROM sys.server_principals WHERE name='$login'").Count -or (Rows "SELECT name FROM sys.database_principals WHERE name='$login'").Count){throw 'RECEIPT_PROVISION_LOGIN_COLLISION'}
  $stage='owned-schema';$tx=$db.BeginTransaction();$password=[string]$p.workerPassword
  Run "CREATE LOGIN [$login] WITH PASSWORD='$password',CHECK_POLICY=ON,DEFAULT_DATABASE=[AdaAcc];CREATE USER [$login] FOR LOGIN [$login];GRANT CONNECT TO [$login];
   CREATE TABLE dbo.SCCRM_ReceiptSyncMeta(singleton int PRIMARY KEY CHECK(singleton=1),marker uniqueidentifier NOT NULL,target_branch char(3) NOT NULL,worker_login sysname NOT NULL,receiver_hash char(64) NOT NULL);
   INSERT dbo.SCCRM_ReceiptSyncMeta VALUES(1,'ab01553b-576c-465e-af30-87daa20e2d33','$b','$login','$actual');
   CREATE TABLE dbo.SCCRM_ReceiptSyncJournal(operation_id uniqueidentifier PRIMARY KEY,payload_hash char(64) NOT NULL,ada_code varchar(20) NOT NULL,
    branch_code char(3) NOT NULL,pos_code char(3) NOT NULL,doc_no varchar(20) NOT NULL,created_at datetime NOT NULL,UNIQUE(branch_code,doc_no));"
  $stage='owned-procedure'
  $sql=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'native-receiver.sql')).Replace('__DATABASE__','AdaAcc').Replace('__TARGET__',$b)
  Run $sql
  Run "GRANT EXECUTE ON dbo.SCCRM_AttachReceiptMember TO [$login];DENY SELECT,INSERT,UPDATE,DELETE,ALTER ON dbo.TCNMCst TO [$login];DENY INSERT,UPDATE,DELETE,ALTER ON dbo.SCCRM_ReceiptSyncMeta TO [$login];DENY INSERT,UPDATE,DELETE,ALTER ON dbo.SCCRM_ReceiptSyncJournal TO [$login];"
  foreach($name in @('TPSTSalHD','TSHD001','TSHD002','TPSTSalDT','TSDT001','TSDT002','TCNTCstPoint')){
   if((Rows "SELECT OBJECT_ID('dbo.$name') id")[0].id){Run "DENY INSERT,UPDATE,DELETE,ALTER ON dbo.[$name] TO [$login]"}
  }
  $tx.Commit();$tx.Dispose();$tx=$null
 }
 @{ok=$true;branch=$b;machine=$peers[$b][1];database='AdaAcc';action=$Action;installed=($Action -ceq 'Install');headers=@($headers.name);originalCustomers=$counts.customers;customerWrites=0;saleWrites=0;pointWrites=0;pinRead=$false}|ConvertTo-Json -Compress -Depth 5
}catch{
 if($tx){try{$tx.Rollback()}catch{}}
 $e=$_.Exception.GetBaseException();$code=if($e.Message -cmatch '^RECEIPT_[A-Z_0-9]+$'){$e.Message}else{'RECEIPT_PROVISION_FAILED'}
 @{ok=$false;code=$code;stage=$stage;detailsWithheld=$true;sqlNumber=$(if($e -is [Data.SqlClient.SqlException]){$e.Number}else{$null})}|ConvertTo-Json -Compress;exit 1
}finally{if($tx){$tx.Dispose()};if($db){$db.Dispose()};if($builder){$builder['Password']=''};if($p){$p.admin.password='';$p.workerPassword=''}}
