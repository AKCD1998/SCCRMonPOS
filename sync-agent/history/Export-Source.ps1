param([Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.Encoding]::UTF8
$settings=@{};$db=$null;$b=$null;$writer=$null;$files=@{};$counts=@{customers=0;sales=0;returns=0;lines=0};$stage='prepare'
try{
 $allowed=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\runtime\history'))+'\';$out=[IO.Path]::GetFullPath($OutputDirectory)
 if(-not $out.StartsWith($allowed,[StringComparison]::OrdinalIgnoreCase) -or (Test-Path -LiteralPath $out)){throw 'NEW_OWNED_EXPORT_FOLDER_REQUIRED'}
 $null=New-Item -ItemType Directory -Path $out
 $acl=New-Object Security.AccessControl.DirectorySecurity;$acl.SetAccessRuleProtection($true,$false)
 foreach($sidText in @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value,'S-1-5-18','S-1-5-32-544')){$sid=New-Object Security.Principal.SecurityIdentifier $sidText;$rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow');$acl.AddAccessRule($rule)};Set-Acl -LiteralPath $out -AclObject $acl
 foreach($line in [IO.File]::ReadAllLines('\\100.90.166.72\C\Users\Administrator\Desktop\Stockdays\SC-StockDay-Ordering\apps\adapos-sync\.env')){if($line -match '^\s*(ADAPOS_SQLSERVER_USER|ADAPOS_SQLSERVER_PASSWORD|ADAPOS_SYNC_BRANCH_CODE)\s*=\s*(.*)$'){$settings[$Matches[1]]=$Matches[2].Trim().Trim([char]34,[char]39)}}
 if($settings.ADAPOS_SYNC_BRANCH_CODE -cne '000'){throw 'WRONG_BRANCH'}
 $b=New-Object Data.SqlClient.SqlConnectionStringBuilder;$b['Data Source']='tcp:100.90.166.72,49800';$b['Initial Catalog']='AdaAcc';$b['User ID']=$settings.ADAPOS_SQLSERVER_USER;$b['Password']=$settings.ADAPOS_SQLSERVER_PASSWORD;$b['Connect Timeout']=4;$b['Application Name']='SCCRM-SELECT-only-member-history-export'
 $db=New-Object Data.SqlClient.SqlConnection $b.ConnectionString;$db.Open();$b.Password='';$settings.Clear()
 $q=$db.CreateCommand();$q.CommandText='SET LOCK_TIMEOUT 1000; SET DEADLOCK_PRIORITY LOW;';$null=$q.ExecuteNonQuery();$q.Dispose()
 function Read-Only([string]$sql,[hashtable]$parameters=@{}){
  if($sql.TrimStart() -notmatch '^SELECT\b' -or $sql -match '(?i)\b(INSERT|UPDATE|DELETE|MERGE|ALTER|CREATE|DROP|TRUNCATE|INTO|EXEC)\b|FTCstPin'){throw 'NON_SELECT_OR_PIN_REFUSED'}
  $q=$db.CreateCommand();$q.CommandTimeout=10;$q.CommandText=$sql
  foreach($key in $parameters.Keys){$p=$q.Parameters.Add('@'+$key,[Data.SqlDbType]::VarChar,50);$p.Value=if($null -eq $parameters[$key]){[DBNull]::Value}else{$parameters[$key]}}
  $r=$q.ExecuteReader();$rows=New-Object Collections.Generic.List[object]
  try{while($r.Read()){$row=[ordered]@{};for($i=0;$i -lt $r.FieldCount;$i++){$v=if($r.IsDBNull($i)){$null}else{$r.GetValue($i)};if($v -is [datetime]){$v=$v.ToString('yyyy-MM-ddTHH:mm:ss.fff',[Globalization.CultureInfo]::InvariantCulture)}elseif($v -is [double] -or $v -is [single]){$v=$v.ToString('R',[Globalization.CultureInfo]::InvariantCulture)}elseif($v -is [long] -or $v -is [decimal]){$v=$v.ToString([Globalization.CultureInfo]::InvariantCulture)};$row[$r.GetName($i)]=$v};$rows.Add([pscustomobject]$row)}}finally{$r.Dispose();$q.Dispose()};return ,$rows.ToArray()
 }
 $identity=Read-Only "SELECT CAST(SERVERPROPERTY('MachineName') AS nvarchar(128)) machine,DB_NAME() db"
 if($identity[0].machine -cne 'SERVER' -or $identity[0].db -cne 'AdaAcc'){throw 'WRONG_SOURCE'}
 $filter="FTShdDocType IN('1','9') AND FTShdStaPaid='3' AND NULLIF(LTRIM(RTRIM(FTCstCode)),'') IS NOT NULL AND FTCstCode<>'0'"
 function Source-Counts{Read-Only ("SELECT 'customers' entity,COUNT_BIG(*) n FROM dbo.TCNMCst UNION ALL SELECT 'sales',COUNT_BIG(*) FROM dbo.TPSTSalHD WHERE "+$filter+" AND FTShdDocType='1' UNION ALL SELECT 'returns',COUNT_BIG(*) FROM dbo.TPSTSalHD WHERE "+$filter+" AND FTShdDocType='9' OPTION(MAXDOP 1)")}
 $before=Source-Counts
 $columns=Read-Only "SELECT name FROM sys.columns WHERE object_id=OBJECT_ID('dbo.TCNMCst') AND name<>('FTCst'+'Pin') ORDER BY column_id"
 $names=@($columns|ForEach-Object{if($_.name -notmatch '^[A-Za-z0-9_]+$'){throw 'UNSAFE_COLUMN'};'['+$_.name+']'})
 foreach($kind in @('customers','receipts','lines')){$files[$kind]=Join-Path $out ($kind+'.jsonl')}
 $writer=New-Object IO.StreamWriter($files.customers,$false,(New-Object Text.UTF8Encoding $false));$after=$null;$stage='customers'
 do{$page=Read-Only ("SELECT TOP(100) "+($names -join ',')+" FROM dbo.TCNMCst WHERE @after IS NULL OR FTCstCode>@after ORDER BY FTCstCode OPTION(MAXDOP 1)") @{after=$after};foreach($row in $page){$writer.WriteLine(($row|ConvertTo-Json -Depth 4 -Compress));$counts.customers++;$after=$row.FTCstCode};$writer.Flush()}while($page.Count -eq 100);$writer.Dispose();$writer=$null
 $headers=New-Object IO.StreamWriter($files.receipts,$false,(New-Object Text.UTF8Encoding $false));$details=New-Object IO.StreamWriter($files.lines,$false,(New-Object Text.UTF8Encoding $false));$lastCustomer=$null;$lastDoc='';$stage='receipts-and-lines'
 try{do{
  $page=Read-Only ("SELECT TOP(100) * FROM dbo.TPSTSalHD WITH(INDEX(IND_TPSTSalHD_FTCstCode)) WHERE "+$filter+" AND (@customer IS NULL OR FTCstCode>@customer OR(FTCstCode=@customer AND FTShdDocNo>@doc)) ORDER BY FTCstCode,FTShdDocNo OPTION(MAXDOP 1)") @{customer=$lastCustomer;doc=$lastDoc}
  if($page.Count){$parameters=@{};$holders=New-Object Collections.Generic.List[string];$j=0;foreach($row in $page){$headers.WriteLine(($row|ConvertTo-Json -Depth 4 -Compress));if($row.FTShdDocType -ceq '1'){$counts.sales++}else{$counts.returns++};$lastCustomer=$row.FTCstCode;$lastDoc=$row.FTShdDocNo;$parameters['doc'+$j]=$row.FTShdDocNo;$holders.Add('@doc'+$j);$j++}
   $lineRows=Read-Only ('SELECT * FROM dbo.TPSTSalDT WHERE FTShdDocNo IN('+($holders.ToArray() -join ',')+') ORDER BY FTShdDocNo,FNSdtSeqNo OPTION(MAXDOP 1)') $parameters
   foreach($row in $lineRows){$details.WriteLine(($row|ConvertTo-Json -Depth 4 -Compress));$counts.lines++};$headers.Flush();$details.Flush()
  }
 }while($page.Count -eq 100)}finally{$headers.Dispose();$details.Dispose()}
 $stage='manifest';$afterCounts=Source-Counts
 foreach($row in $before){$post=@($afterCounts|Where-Object entity -CEQ $row.entity);if($post.Count -ne 1 -or $post[0].n -cne $row.n -or [long]$counts[$row.entity] -ne [long]$row.n){throw 'SOURCE_CHANGED_OR_INCOMPLETE'}}
 $hashes=[ordered]@{};foreach($entry in $files.GetEnumerator()){$hashes[$entry.Key]=(Get-FileHash -LiteralPath $entry.Value -Algorithm SHA256).Hash}
 $manifest=[ordered]@{ok=$true;snapshotId=[guid]::NewGuid().ToString();source='hq000/AdaAcc';capturedAtUtc=[datetime]::UtcNow.ToString('o');counts=$counts;hashes=$hashes;customerColumns=$names.Count;pinRead=$false;productionWrites=0;sourcePageSize=100;scope='all customers; finalized non-general sales and returns with all their lines'}
 [IO.File]::WriteAllText((Join-Path $out 'manifest.json'),($manifest|ConvertTo-Json -Depth 5),(New-Object Text.UTF8Encoding $false));$manifest|ConvertTo-Json -Depth 5 -Compress
}catch{[ordered]@{ok=$false;stage=$stage;code=if($_.Exception.Message -match '^[A-Z_]+$'){$_.Exception.Message}else{'EXPORT_FAILED'};errorType=$_.Exception.GetBaseException().GetType().Name;detailsWithheld=$true;productionWrites=0;pinRead=$false}|ConvertTo-Json -Compress;exit 1}
finally{if($writer){$writer.Dispose()};if($db){$db.Dispose()};if($b){$b.Password=''};$settings.Clear();$line=$null;$Matches=$null}
