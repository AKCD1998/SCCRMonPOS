param([ValidateSet('Copy','Live')][string]$Mode='Live')
$ErrorActionPreference='Stop';[Console]::InputEncoding=[Text.Encoding]::UTF8;[Console]::OutputEncoding=[Text.Encoding]::UTF8
$p=$null;$db=$null;$cmd=$null;$reader=$null
try{
 [Diagnostics.Process]::GetCurrentProcess().PriorityClass=[Diagnostics.ProcessPriorityClass]::BelowNormal
 $p=[Console]::In.ReadToEnd()|ConvertFrom-Json;$t=$p.target;$b=[string]$t.branch;$j=$p.job;$i=$j.identity
 $peers=@{'000'=@('100.90.166.72','SERVER');'001'=@('100.81.137.41','SC_001');'003'=@('100.77.101.94','POSSRV');'004'=@('100.113.59.42','SERVER004');'005'=@('100.106.107.80','POSSRV')}
 if($p.scope -cne 'SCCRM-READ-RECEIPT-V1' -or !$peers.ContainsKey($b) -or $j.policy -cne 'ada-receipt-completeness-v1' -or $i.branchCode -cnotin @('001','003','004','005') -or $i.posCode -cnotin @('001','002') -or ($b -cne '000' -and $b -cne $i.branchCode)){throw 'RECON_PACKET_REFUSED'}
 if($Mode -ceq 'Copy'){
  if($t.server -cne 'tcp:100.90.166.72,49800' -or $t.machine -cne 'SERVER' -or $t.database -cne ('SCCRM_ReceiptTimeCopy_20261111_'+$b)){throw 'RECON_TARGET_REFUSED'}
 }else{
  $servers=if($b -ceq '000'){@('tcp:127.0.0.1,49800','tcp:100.90.166.72,49800')}else{@($peers[$b][0]+'\SQLEXPRESS')}
  if($t.server -cnotin $servers -or $t.machine -cne $peers[$b][1] -or $t.database -cne 'AdaAcc' -or $p.credentials.user -cne ('sccrm_receipt_sync_'+$b)){throw 'RECON_TARGET_REFUSED'}
 }
 $builder=New-Object Data.SqlClient.SqlConnectionStringBuilder;$builder['Data Source']=$t.server;$builder['Initial Catalog']=$t.database;$builder['User ID']=$p.credentials.user;$builder['Password']=$p.credentials.password;$builder['Connect Timeout']=5;$builder['Pooling']=$false;$builder['Application Name']='SCCRM-Receipt-Completeness-ReadOnly'
 $db=New-Object Data.SqlClient.SqlConnection $builder.ConnectionString;$db.Open();$builder['Password']='';$p.credentials.password=''
 $cmd=$db.CreateCommand();$cmd.CommandTimeout=3;$cmd.CommandText="SELECT CONVERT(varchar(128),SERVERPROPERTY('MachineName')) machine,DB_NAME() db,IS_SRVROLEMEMBER('sysadmin') elevated,IS_MEMBER('db_owner') owner,IS_MEMBER('db_datawriter') writer"
 $reader=$cmd.ExecuteReader();if(!$reader.Read() -or $reader['machine'] -cne $t.machine -or $reader['db'] -cne $t.database){throw 'RECON_TARGET_REFUSED'}
 if($Mode -ceq 'Live' -and ($reader['elevated'] -ne 0 -or $reader['owner'] -ne 0 -or $reader['writer'] -ne 0)){throw 'RECON_RIGHTS_REFUSED'};$reader.Dispose();$reader=$null;$cmd.Dispose();$cmd=$null
 if($Mode -ceq 'Copy'){$cmd=$db.CreateCommand();$cmd.CommandText="IF NOT EXISTS(SELECT 1 FROM dbo.SCCRM_TimeCopyOwner WHERE marker='4afc7446-846e-4d6a-8a1b-e672655b1a38') RAISERROR('RECON_TARGET_REFUSED',16,1);";$null=$cmd.ExecuteNonQuery();$cmd.Dispose();$cmd=$null}
 $cmd=$db.CreateCommand();$cmd.CommandType=[Data.CommandType]::StoredProcedure;$cmd.CommandText='dbo.SCCRM_ReadReceiptSnapshot';$cmd.CommandTimeout=5
 foreach($entry in @(@('Branch',[Data.SqlDbType]::Char,3,$i.branchCode),@('Pos',[Data.SqlDbType]::Char,3,$i.posCode),@('Doc',[Data.SqlDbType]::VarChar,20,$i.receiptNo),@('AdaCode',[Data.SqlDbType]::VarChar,20,$i.adaCode),@('ExpectedName',[Data.SqlDbType]::NVarChar,255,$j.expectedName),@('ExpectedPhone',[Data.SqlDbType]::VarChar,30,$j.expectedPhone))){$param=$cmd.Parameters.Add('@'+$entry[0],$entry[1],$entry[2]);$param.Value=if($null -eq $entry[3]){[DBNull]::Value}else{$entry[3]}}
 $reader=$cmd.ExecuteReader();$sets=@();do{$rows=@();while($reader.Read()){$o=[ordered]@{};for($n=0;$n -lt $reader.FieldCount;$n++){$o[$reader.GetName($n)]=if($reader.IsDBNull($n)){$null}else{$reader.GetValue($n)}};$rows+=[pscustomobject]$o;if($rows.Count -gt 1000){throw 'RECON_SOURCE_FIELDS_INCOMPLETE'}};$sets+=,@($rows)}while($reader.NextResult());
 if($sets.Count -ne 5 -or $sets[0].Count -ne 1 -or $sets[4].Count -ne 1){throw 'RECON_SOURCE_NOT_ARRIVED'}
 $header=$sets[0][0];$table=$header.sourceTable;$header.PSObject.Properties.Remove('sourceTable')
 @{ok=$true;observation=@{policy='ada-receipt-completeness-v1';targetBranch=$b;table=$table;header=$header;items=@($sets[1]);payments=@($sets[2]);journals=@($sets[3]);memberMatches=$sets[4][0].memberMatches;walkInVerified=$sets[4][0].walkInVerified}}|ConvertTo-Json -Depth 12 -Compress
}catch{$e=$_.Exception.GetBaseException();$code=if($e.Message -cmatch '^RECON_[A-Z_]+$'){$e.Message}else{'RECON_SOURCE_UNAVAILABLE'};@{ok=$false;code=$code;detail=$(if($Mode -ceq 'Copy'){$e.Message}else{$null})}|ConvertTo-Json -Compress;exit 1}
finally{if($reader){$reader.Dispose()};if($cmd){$cmd.Dispose()};if($db){$db.Dispose()};if($p){$p.credentials.password=''}}
