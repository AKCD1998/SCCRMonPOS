[CmdletBinding()]
param(
 [Parameter(Mandatory=$true)][ValidateSet('Snapshot','Create','Verify','Query')][string]$Action,
 [Parameter(Mandatory=$true)][ValidateSet('000','001','003','004','005')][string]$Branch,
 [switch]$TargetCopy,
 [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$')][string]$BaselineTag='initial',
 [string]$RuntimeDirectory
)
$ErrorActionPreference='Stop'
[Console]::InputEncoding=[Text.Encoding]::UTF8
[Console]::OutputEncoding=[Text.Encoding]::UTF8
$COPY_MARKER='fa35c153-6692-43b8-afd1-b102a119b002'
$COPY_SCOPE='SCCRM-FANOUT-COPY-LAB-20261029'
$COPY_PREFIX='SCCRM_FanoutCopy_20261029_'
$HQ_SERVER='tcp:100.90.166.72,49800'
if(!$RuntimeDirectory){$RuntimeDirectory=Join-Path $PSScriptRoot 'runtime\copy-lab'}
$PRIVATE_ROOT=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'runtime'))
$RUNTIME=[IO.Path]::GetFullPath($RuntimeDirectory)
$sourceDb=$null;$targetDb=$null;$masterDb=$null
$hqCredentials=$null;$sourceCredentials=$null;$transaction=$null
$stage='preflight'

function Refuse([string]$code){throw $code}
function Safe-Identifier([string]$name){if($name -cnotmatch '^[A-Za-z_][A-Za-z0-9_]*$'){Refuse 'COPY_IDENTIFIER_REFUSED'};return '['+$name+']'}
function Read-Env([string]$file){
 $out=@{}
 foreach($line in [IO.File]::ReadAllLines($file)){
  if($line -match '^\s*(ADAPOS_SQLSERVER_HOST|ADAPOS_SQLSERVER_DATABASE|ADAPOS_SQLSERVER_USER|ADAPOS_SQLSERVER_PASSWORD|ADAPOS_SYNC_BRANCH_CODE)\s*=\s*(.*)$'){
   $out[$Matches[1]]=$Matches[2].Trim().Trim([char]34,[char]39)
  }
 }
 return $out
}
function Read-HqCredentials(){
 $file='\\100.90.166.72\C\Users\Administrator\Desktop\Stockdays\SC-StockDay-Ordering\apps\adapos-sync\.env'
 if($env:COMPUTERNAME -ceq 'SERVER'){$file='C:\Users\Administrator\Desktop\Stockdays\SC-StockDay-Ordering\apps\adapos-sync\.env'}
 $raw=Read-Env $file
 if($raw.ADAPOS_SYNC_BRANCH_CODE -cne '000' -or !$raw.ADAPOS_SQLSERVER_USER -or !$raw.ADAPOS_SQLSERVER_PASSWORD){$raw.Clear();Refuse 'COPY_HQ_CREDENTIAL_SOURCE_REFUSED'}
 $credential=@{user=$raw.ADAPOS_SQLSERVER_USER;password=$raw.ADAPOS_SQLSERVER_PASSWORD};$raw.Clear();return $credential
}
function Read-BranchCredentials([string]$branch){
 if($branch -ceq '000'){return @{user=$hqCredentials.user;password=$hqCredentials.password}}
 $peers=@{'001'='100.81.137.41';'003'='100.77.101.94';'004'='100.113.59.42';'005'='100.106.107.80'}
 $peer=$peers[$branch];$settings=@{}
 try{
  if($branch -ceq '003'){
   $raw=Read-Env '\\100.77.101.94\C\SC-Sync-Config-Backup\.env.branch003.before-transfer.20260909-113453.bak'
   if($raw.ADAPOS_SYNC_BRANCH_CODE -cne '003' -or $raw.ADAPOS_SQLSERVER_DATABASE -cne 'AdaAcc'){Refuse 'COPY_BRANCH_CREDENTIAL_SOURCE_REFUSED'}
   $settings.user=$raw.ADAPOS_SQLSERVER_USER;$settings.password=$raw.ADAPOS_SQLSERVER_PASSWORD;$raw.Clear()
  }else{
   $root='\\'+$peer+'\C\Users\Administrator\AppData\Local\Programs\SCCRMonPOS'
   foreach($file in @('SCCRMonPOS.exe.config','SCCRMonPOS.secrets.config')){
    [xml]$xml=[IO.File]::ReadAllText((Join-Path $root $file))
    foreach($entry in $xml.configuration.appSettings.add){$settings[$entry.key]=$entry.value}
   }
   if($settings.AdaPosDbName -cne 'AdaAcc'){Refuse 'COPY_BRANCH_DATABASE_REFUSED'}
   $settings.user=$settings.AdaPosDbUser;$settings.password=$settings.AdaPosDbPassword
  }
  if($settings.user -cne 'readonly_pilot' -or !$settings.password){Refuse 'COPY_READONLY_CREDENTIAL_REQUIRED'}
  return @{user=$settings.user;password=$settings.password}
 }finally{$settings.Clear();$xml=$null;$raw=$null}
}
function Source-Endpoint([string]$branch){
 if($branch -ceq '000'){return $HQ_SERVER}
 $peers=@{'001'='100.81.137.41';'003'='100.77.101.94';'004'='100.113.59.42';'005'='100.106.107.80'}
 $pf=if($branch -ceq '005'){'Program Files'}else{'Program Files (x86)'}
 $file='\\'+$peers[$branch]+'\C\'+$pf+'\Microsoft SQL Server\MSSQL10_50.SQLEXPRESS\MSSQL\Log\ERRORLOG'
 $port=$null
 $stream=[IO.File]::Open($file,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite)
 $reader=New-Object IO.StreamReader $stream
 try{while($null -ne ($line=$reader.ReadLine())){if($line -match "Server is listening on\s+\[\s*'any'\s+<ipv4>\s+(\d+)\]"){$port=[int]$Matches[1]}}}finally{$reader.Dispose();$stream.Dispose()}
 if(!$port -or $port -lt 1024 -or $port -gt 65535){Refuse 'COPY_BRANCH_LISTENER_REFUSED'}
 return 'tcp:'+$peers[$branch]+','+$port
}
function Open-Database([string]$endpoint,[string]$database,[hashtable]$credential,[bool]$copyOnly=$false){
 if($copyOnly -and $database -cnotmatch '^SCCRM_FanoutCopy_20261029_(000|001|003|004|005)$'){Refuse 'COPY_DATABASE_NAME_REFUSED'}
 $builder=New-Object Data.SqlClient.SqlConnectionStringBuilder
 $builder['Data Source']=$endpoint;$builder['Initial Catalog']=$database
 $builder['User ID']=$credential.user;$builder['Password']=$credential.password
 $builder['Connect Timeout']=5;$builder['Application Name']='SCCRM-Fanout-Copy-Lab';$builder['Pooling']=$false
 $conn=New-Object Data.SqlClient.SqlConnection $builder.ConnectionString
 try{
  $conn.Open();$builder['Password']=''
  $cmd=$conn.CreateCommand();$cmd.CommandTimeout=5;$cmd.CommandText='SET LOCK_TIMEOUT 1000; SET DEADLOCK_PRIORITY LOW;';$null=$cmd.ExecuteNonQuery();$cmd.Dispose()
  return $conn
 }catch{$conn.Dispose();throw}finally{$builder['Password']=''}
}
function Tables([Data.SqlClient.SqlConnection]$conn,[string]$sql,[hashtable]$parameters=@{},[Data.SqlClient.SqlTransaction]$tx=$null){
 $cmd=$conn.CreateCommand();$cmd.CommandTimeout=10;$cmd.CommandText=$sql
 if($tx){$cmd.Transaction=$tx}
 foreach($key in $parameters.Keys){if($key -cnotmatch '^[A-Za-z][A-Za-z0-9_]*$'){Refuse 'COPY_PARAMETER_REFUSED'};$value=$parameters[$key];if($null -eq $value){$value=[DBNull]::Value};$null=$cmd.Parameters.AddWithValue('@'+$key,$value)}
 $adapter=New-Object Data.SqlClient.SqlDataAdapter $cmd;$set=New-Object Data.DataSet
 try{$null=$adapter.Fill($set);return ,$set}finally{$adapter.Dispose();$cmd.Dispose()}
}
function Scalar([Data.SqlClient.SqlConnection]$conn,[string]$sql,[hashtable]$parameters=@{},[Data.SqlClient.SqlTransaction]$tx=$null){
 $cmd=$conn.CreateCommand();$cmd.CommandTimeout=10;$cmd.CommandText=$sql
 if($tx){$cmd.Transaction=$tx}
 foreach($key in $parameters.Keys){$null=$cmd.Parameters.AddWithValue('@'+$key,$parameters[$key])}
 try{return $cmd.ExecuteScalar()}finally{$cmd.Dispose()}
}
function Check-Identity([Data.SqlClient.SqlConnection]$conn,[string]$database,[string]$machine){
 $set=Tables $conn "SELECT CAST(SERVERPROPERTY('MachineName') AS nvarchar(128)) machine,DB_NAME() database_name,ORIGINAL_LOGIN() actor,IS_SRVROLEMEMBER('sysadmin') elevated,IS_MEMBER('db_datawriter') writer,HAS_PERMS_BY_NAME('dbo.TCNMCst','OBJECT','INSERT') can_insert,HAS_PERMS_BY_NAME('dbo.TCNMCst','OBJECT','UPDATE') can_update,HAS_PERMS_BY_NAME('dbo.TCNMCst','OBJECT','DELETE') can_delete"
 $row=$set.Tables[0].Rows[0]
 if($row.machine -cne $machine -or $row.database_name -cne $database){Refuse 'COPY_DATABASE_IDENTITY_REFUSED'}
 if($database -ceq 'AdaAcc' -and $machine -cne 'SERVER'){
  if($row.actor -cne 'readonly_pilot' -or $row.elevated -ne 0 -or $row.writer -ne 0 -or $row.can_insert -ne 0 -or $row.can_update -ne 0 -or $row.can_delete -ne 0){Refuse 'COPY_SOURCE_NOT_READONLY'}
 }
 return @{machine=[string]$row.machine;database=[string]$row.database_name}
}
function Customer-Schema([Data.SqlClient.SqlConnection]$conn){
 $set=Tables $conn "SELECT c.name,t.name data_type,c.max_length,c.precision,c.scale,c.is_nullable,c.is_identity,c.is_computed,c.collation_name,c.default_object_id FROM sys.columns c JOIN sys.types t ON t.user_type_id=c.user_type_id WHERE c.object_id=OBJECT_ID('dbo.TCNMCst') AND c.name NOT LIKE '%pin%' AND c.name NOT LIKE '%password%' AND c.name NOT LIKE '%secret%' AND c.name NOT LIKE '%token%' ORDER BY c.column_id"
 $out=@()
 foreach($r in $set.Tables[0].Rows){
  if($r.name -cmatch '(?i)pin|password|secret|token' -or $r.is_identity -or $r.is_computed){Refuse 'COPY_CUSTOMER_COLUMN_REFUSED'}
  $null=Safe-Identifier $r.name
  if($r.data_type -cnotin @('varchar','nvarchar','char','nchar','float','real','bigint','int','smallint','tinyint','bit','datetime','smalldatetime','date','datetime2','decimal','numeric','money','smallmoney','uniqueidentifier','varbinary','binary')){Refuse 'COPY_CUSTOMER_TYPE_REFUSED'}
  $out+=@{name=[string]$r.name;type=[string]$r.data_type;length=[int]$r.max_length;precision=[int]$r.precision;scale=[int]$r.scale;nullable=[bool]$r.is_nullable;defaulted=($r.default_object_id -ne 0);collation=if($r.collation_name -is [DBNull]){$null}else{[string]$r.collation_name}}
 }
 if($out.Count -ne 101 -or $out[0].name -cne 'FTCstCode' -or $out[0].type -cne 'varchar' -or $out[0].length -ne 20){Refuse 'COPY_SCHEMA_REVIEW_REQUIRED'}
 return ,$out
}
function Hash-Bytes([byte[]]$bytes){$sha=[Security.Cryptography.SHA256]::Create();try{return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}}
function Row-Hash([Data.DataRow]$row,[string[]]$columns){
 $memory=New-Object IO.MemoryStream;$writer=New-Object IO.BinaryWriter $memory,([Text.UTF8Encoding]::new($false,$true))
 try{
  foreach($column in $columns){$writer.Write($column);$value=$row[$column];$nullValue=$value -is [DBNull];$writer.Write([bool]$nullValue);if($nullValue){continue}
   $writer.Write($value.GetType().FullName)
   if($value -is [datetime]){$text=$value.ToString('yyyy-MM-ddTHH:mm:ss.fffffff',[Globalization.CultureInfo]::InvariantCulture)}
   elseif($value -is [double] -or $value -is [single]){$text=$value.ToString('R',[Globalization.CultureInfo]::InvariantCulture)}
   elseif($value -is [byte[]]){$text=[Convert]::ToBase64String($value)}
   elseif($value -is [IFormattable]){$text=$value.ToString($null,[Globalization.CultureInfo]::InvariantCulture)}else{$text=[string]$value}
   $writer.Write($text)
  }
  $writer.Flush();return Hash-Bytes $memory.ToArray()
 }finally{$writer.Dispose();$memory.Dispose()}
}
function Customer-Data([Data.SqlClient.SqlConnection]$conn,[object[]]$schema){
 $columns=@($schema|ForEach-Object{Safe-Identifier $_.name}) -join ','
 $set=Tables $conn ('SELECT '+$columns+' FROM dbo.TCNMCst ORDER BY FTCstCode OPTION(MAXDOP 1)')
 return ,$set.Tables[0]
}
function Baseline([object[]]$schema,[Data.DataTable]$data,[string]$branch,[string]$machine,[string]$sourceDatabase='AdaAcc'){
 $names=@($schema|ForEach-Object{$_.name});$rows=[ordered]@{}
 foreach($row in $data.Rows){$code=[string]$row['FTCstCode'];if($rows.Contains($code)){Refuse 'COPY_DUPLICATE_SOURCE_CODE'};$rows[$code]=Row-Hash $row $names}
 $signature=($schema|ForEach-Object{$_.name+':'+$_.type+':'+$_.length+':'+$_.precision+':'+$_.scale+':'+$_.nullable+':'+$_.collation}) -join '|'
 return [ordered]@{scope=$COPY_SCOPE;marker=$COPY_MARKER;branch=$branch;machine=$machine;database=$sourceDatabase;capturedAt=[DateTime]::UtcNow.ToString('o');columnCount=$schema.Count;schemaHash=(Hash-Bytes ([Text.Encoding]::UTF8.GetBytes($signature)));rowCount=$data.Rows.Count;rows=$rows}
}
function Private-Runtime(){
 if(!$RUNTIME.StartsWith($PRIVATE_ROOT+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){Refuse 'COPY_RUNTIME_PATH_REFUSED'}
 $null=[IO.Directory]::CreateDirectory($RUNTIME)
 $acl=New-Object Security.AccessControl.DirectorySecurity
 $acl.SetAccessRuleProtection($true,$false)
 foreach($sid in @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value,'S-1-5-18','S-1-5-32-544')){
  $identity=New-Object Security.Principal.SecurityIdentifier $sid
  $rule=New-Object Security.AccessControl.FileSystemAccessRule $identity,'FullControl','ContainerInherit,ObjectInherit','None','Allow';$null=$acl.AddAccessRule($rule)
 }
 [IO.Directory]::SetAccessControl($RUNTIME,$acl)
}
function Baseline-File(){return Join-Path $RUNTIME ('baseline-'+$Branch+'-'+$(if($TargetCopy){'copy'}else{'source'})+'-'+$BaselineTag+'.json')}
function Save-Baseline($baseline){
 Private-Runtime
 $file=Baseline-File
 $stream=New-Object IO.FileStream $file,([IO.FileMode]::CreateNew),([IO.FileAccess]::Write),([IO.FileShare]::None)
 $writer=New-Object IO.StreamWriter $stream,([Text.UTF8Encoding]::new($false))
 try{$writer.Write(($baseline|ConvertTo-Json -Compress -Depth 7))}finally{$writer.Dispose();$stream.Dispose()}
 return $file
}
function Read-Baseline(){
 $baseline=Get-Content -LiteralPath (Baseline-File) -Raw|ConvertFrom-Json
 $expectedDatabase=if($TargetCopy){$COPY_PREFIX+$Branch}else{'AdaAcc'}
 if($baseline.scope -cne $COPY_SCOPE -or $baseline.marker -cne $COPY_MARKER -or $baseline.branch -cne $Branch -or $baseline.database -cne $expectedDatabase -or $baseline.columnCount -ne 101){Refuse 'COPY_BASELINE_REFUSED'}
 return $baseline
}
function Compare-Baseline($before,$after){
 if($before.schemaHash -cne $after.schemaHash){Refuse 'COPY_BASELINE_SCHEMA_CHANGED'}
 $missing=@();$changed=@();$oldCodes=@{}
 foreach($entry in $before.rows.PSObject.Properties){$oldCodes[$entry.Name]=$true;if(!$after.rows.Contains($entry.Name)){$missing+=$entry.Name}elseif($after.rows[$entry.Name] -cne $entry.Value){$changed+=$entry.Name}}
 $added=@($after.rows.Keys|Where-Object{!$oldCodes.ContainsKey($_)})
 return @{unchanged=($missing.Count -eq 0 -and $changed.Count -eq 0);baselineRows=[int]$before.rowCount;currentRows=[int]$after.rowCount;missingCodes=$missing;changedCodes=$changed;newCodes=$added;newRows=$added.Count;columnsChecked=101}
}
function Column-Definition($column){
 $type=$column.type
 if($type -in @('varchar','char','varbinary','binary')){$type+='('+$(if($column.length -eq -1){'max'}else{[string]$column.length})+')'}
 elseif($type -in @('nvarchar','nchar')){$type+='('+$(if($column.length -eq -1){'max'}else{[string]([int]$column.length/2)})+')'}
 elseif($type -in @('decimal','numeric')){$type+='('+$column.precision+','+$column.scale+')'}
 elseif($type -eq 'float'){$type+='('+$column.precision+')'}
 elseif($type -eq 'datetime2'){$type+='('+$column.scale+')'}
 if($column.collation){if($column.collation -cnotmatch '^[A-Za-z0-9_]+$'){Refuse 'COPY_COLLATION_REFUSED'};$type+=' COLLATE '+$column.collation}
 return (Safe-Identifier $column.name)+' '+$type+$(if($column.nullable){' NULL'}else{' NOT NULL'})
}
function Copy-Guard([Data.SqlClient.SqlConnection]$conn,[string]$database){
 if($database -cnotmatch '^SCCRM_FanoutCopy_20261029_(000|001|003|004|005)$'){Refuse 'COPY_DATABASE_NAME_REFUSED'}
 $identity=Check-Identity $conn $database 'SERVER'
 $set=Tables $conn 'SELECT marker,scope,branch_code FROM dbo.SCCRM_FanoutCopyMeta'
 if($set.Tables[0].Rows.Count -ne 1){Refuse 'COPY_MARKER_REFUSED'};$row=$set.Tables[0].Rows[0]
 if([string]$row.marker -cne $COPY_MARKER -or $row.scope -cne $COPY_SCOPE -or $row.branch_code -cne $Branch){Refuse 'COPY_MARKER_REFUSED'}
 if((Scalar $conn "SELECT CAST(is_trustworthy_on AS int)+CAST(is_db_chaining_on AS int) FROM sys.databases WHERE database_id=DB_ID()") -ne 0){Refuse 'COPY_CROSS_DATABASE_ACCESS_REFUSED'}
}
function Bulk-Copy([Data.SqlClient.SqlConnection]$conn,[Data.DataTable]$data,[string]$table,[Data.SqlClient.SqlTransaction]$tx){
 if($table -cnotin @('dbo.TCNMCst','dbo.SCCRM_LiveMemberLink')){Refuse 'COPY_BULK_TABLE_REFUSED'}
 $bulk=New-Object Data.SqlClient.SqlBulkCopy $conn,([Data.SqlClient.SqlBulkCopyOptions]::KeepNulls),$tx
 try{$bulk.DestinationTableName=$table;$bulk.BatchSize=100;$bulk.BulkCopyTimeout=30;foreach($c in $data.Columns){$null=$bulk.ColumnMappings.Add($c.ColumnName,$c.ColumnName)};$bulk.WriteToServer($data)}finally{$bulk.Dispose()}
}

try{
 if(!$RUNTIME.StartsWith($PRIVATE_ROOT+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){Refuse 'COPY_RUNTIME_PATH_REFUSED'}
 if($TargetCopy -and $Action -cnotin @('Snapshot','Verify')){Refuse 'COPY_BASELINE_MODE_REFUSED'}
 $database=$COPY_PREFIX+$Branch
 $stage='hq-credential-source';$hqCredentials=Read-HqCredentials
 if($Action -ceq 'Query'){
  $packet=[Console]::In.ReadToEnd()|ConvertFrom-Json
  if(!$packet -or $packet.sql -isnot [string] -or $packet.sql.Length -gt 1048576 -or !$packet.sql.Trim()){Refuse 'COPY_QUERY_PACKET_REFUSED'}
  # NO REVERT locks this session in a database-only user; even dynamic SQL cannot
  # restore the admin login. TRUSTWORTHY and DB_CHAINING remain off on every copy.
  $stage='copy-query-connect';$targetDb=Open-Database $HQ_SERVER $database $hqCredentials $true;Copy-Guard $targetDb $database
  $null=Scalar $targetDb "EXECUTE AS USER='SCCRM_FanoutCopyExecutor' WITH NO REVERT;"
  if((Scalar $targetDb 'SELECT DB_NAME()') -cne $database){Refuse 'COPY_QUERY_TARGET_REFUSED'}
  $parameters=@{};if($packet.parameters){foreach($entry in $packet.parameters.PSObject.Properties){$parameters[$entry.Name]=$entry.Value}}
  $stage='copy-query-execute';$set=Tables $targetDb $packet.sql $parameters;$results=@()
  foreach($table in $set.Tables){$rows=@();foreach($row in $table.Rows){$record=[ordered]@{};foreach($column in $table.Columns){$value=$row[$column];if($value -is [DBNull]){$value=$null};if($value -is [datetime]){$value=$value.ToString('yyyy-MM-ddTHH:mm:ss.fffffff',[Globalization.CultureInfo]::InvariantCulture)};$record[$column.ColumnName]=$value};$rows+=[pscustomobject]$record};$results+=,@($rows)}
  [ordered]@{ok=$true;action='Query';database=$database;results=$results;productionWrites=0}|ConvertTo-Json -Depth 20 -Compress
  exit 0
 }
 $machines=@{'000'='SERVER';'001'='SC_001';'003'='POSSRV';'004'='SERVER004';'005'='POSSRV'}
 if($TargetCopy){
  $stage='copy-snapshot-connect';$sourceDb=Open-Database $HQ_SERVER $database $hqCredentials $true;Copy-Guard $sourceDb $database
  $baselineMachine='SERVER';$baselineDatabase=$database
 }else{
  $stage='source-credentials';$sourceCredentials=Read-BranchCredentials $Branch
  $stage='source-connect';$sourceDb=Open-Database (Source-Endpoint $Branch) 'AdaAcc' $sourceCredentials
  $identity=Check-Identity $sourceDb 'AdaAcc' $machines[$Branch]
  $baselineMachine=$machines[$Branch];$baselineDatabase='AdaAcc'
 }
 $stage='source-schema';$schema=Customer-Schema $sourceDb
 $stage='source-customer-read';$data=Customer-Data $sourceDb $schema
 $stage='source-customer-hash';$baseline=Baseline $schema $data $Branch $baselineMachine $baselineDatabase
 if($Action -ceq 'Snapshot'){
  if(Test-Path -LiteralPath (Baseline-File)){Refuse 'COPY_BASELINE_ALREADY_EXISTS'}
  $stage='baseline-write';$file=Save-Baseline $baseline
  [ordered]@{ok=$true;action='Snapshot';branch=$Branch;targetCopy=[bool]$TargetCopy;rows=$data.Rows.Count;columns=101;schemaHash=$baseline.schemaHash;baselineFile=$file;productionWrites=0}|ConvertTo-Json -Compress
  exit 0
 }
 if($Action -ceq 'Verify'){
  $comparison=Compare-Baseline (Read-Baseline) $baseline
  [ordered]@{ok=$comparison.unchanged;action='Verify';branch=$Branch;targetCopy=[bool]$TargetCopy;proof=$comparison;productionWrites=0}|ConvertTo-Json -Depth 5 -Compress
  if(!$comparison.unchanged){exit 2};exit 0
 }
 if(!(Test-Path -LiteralPath (Baseline-File))){$null=Save-Baseline $baseline}else{$comparison=Compare-Baseline (Read-Baseline) $baseline;if(!$comparison.unchanged){Refuse 'COPY_SOURCE_CHANGED_BEFORE_CREATE'}}
 $stage='copy-master-connect';$masterDb=Open-Database $HQ_SERVER 'master' $hqCredentials
 $identity=Check-Identity $masterDb 'master' 'SERVER'
 $exists=Scalar $masterDb 'SELECT COUNT(*) FROM sys.databases WHERE name=@name' @{name=$database}
 $stage='copy-database-create';if($exists -eq 0){$null=Scalar $masterDb ('CREATE DATABASE '+(Safe-Identifier $database)+' COLLATE Thai_CI_AS');$null=Scalar $masterDb ('ALTER DATABASE '+(Safe-Identifier $database)+' SET TRUSTWORTHY OFF');$null=Scalar $masterDb ('ALTER DATABASE '+(Safe-Identifier $database)+' SET DB_CHAINING OFF')}
 $targetDb=Open-Database $HQ_SERVER $database $hqCredentials $true
 $identity=Check-Identity $targetDb $database 'SERVER'
 $hasMarker=Scalar $targetDb "SELECT OBJECT_ID('dbo.SCCRM_FanoutCopyMeta')"
 if($hasMarker -is [DBNull]){
  if($exists -ne 0){Refuse 'COPY_EXISTING_DATABASE_NOT_OWNED'}
  $null=Scalar $targetDb 'CREATE TABLE dbo.SCCRM_FanoutCopyMeta(marker uniqueidentifier NOT NULL,scope varchar(80) NOT NULL,branch_code char(3) NOT NULL,created_at datetime NOT NULL DEFAULT GETUTCDATE());INSERT dbo.SCCRM_FanoutCopyMeta(marker,scope,branch_code) VALUES(@marker,@scope,@branch)' @{marker=[guid]$COPY_MARKER;scope=$COPY_SCOPE;branch=$Branch}
 }
 Copy-Guard $targetDb $database
 if((Scalar $targetDb "SELECT OBJECT_ID('dbo.TCNMCst')") -isnot [DBNull]){
  $count=Scalar $targetDb 'SELECT COUNT(*) FROM dbo.TCNMCst'
  [ordered]@{ok=$true;action='Create';branch=$Branch;database=$database;created=$false;existingCopyRows=[int]$count;productionWrites=0}|ConvertTo-Json -Compress
  exit 0
 }
 $stage='copy-table-create';$transaction=$targetDb.BeginTransaction()
 $definitions=@($schema|ForEach-Object{Column-Definition $_})
 $null=Scalar $targetDb ('CREATE TABLE dbo.TCNMCst('+($definitions -join ',')+',CONSTRAINT PK_TCNMCst PRIMARY KEY(FTCstCode))') @{} $transaction
 $stage='copy-customer-bulk';Bulk-Copy $targetDb $data 'dbo.TCNMCst' $transaction
 $links=0
 if($Branch -ceq '000'){
  $marker=Scalar $sourceDb "SELECT CONVERT(nvarchar(36),value) FROM sys.extended_properties WHERE class=1 AND major_id=OBJECT_ID('dbo.SCCRM_LiveMemberLink') AND name='SCCRM_LiveSyncMarker'"
  if($marker -cne 'ef76cc14-1b6b-49c9-8da7-1bfaea3dd92b'){Refuse 'COPY_HQ_LINK_SOURCE_REFUSED'}
  $set=Tables $sourceDb 'SELECT member_id,ada_code,created_at,profile_name,profile_phone,profile_email FROM dbo.SCCRM_LiveMemberLink ORDER BY member_id'
  $null=Scalar $targetDb 'CREATE TABLE dbo.SCCRM_LiveMemberLink(member_id uniqueidentifier NOT NULL PRIMARY KEY,ada_code varchar(20) NOT NULL UNIQUE,created_at datetime NOT NULL,profile_name nvarchar(200) NOT NULL,profile_phone varchar(30) NOT NULL,profile_email nvarchar(100) NULL)' @{} $transaction
  Bulk-Copy $targetDb $set.Tables[0] 'dbo.SCCRM_LiveMemberLink' $transaction;$links=$set.Tables[0].Rows.Count
  $null=Scalar $targetDb "EXEC sys.sp_addextendedproperty @name='SCCRM_LiveSyncMarker',@value='ef76cc14-1b6b-49c9-8da7-1bfaea3dd92b',@level0type='SCHEMA',@level0name='dbo',@level1type='TABLE',@level1name='SCCRM_LiveMemberLink'" @{} $transaction
 }
 $null=Scalar $targetDb "CREATE USER SCCRM_FanoutCopyExecutor WITHOUT LOGIN;EXEC sp_addrolemember 'db_owner','SCCRM_FanoutCopyExecutor'" @{} $transaction
 $stage='copy-commit';$transaction.Commit();$transaction.Dispose();$transaction=$null
 $copyData=Customer-Data $targetDb $schema;$copyBaseline=Baseline $schema $copyData $Branch $machines[$Branch]
 $comparison=Compare-Baseline (Read-Baseline) $copyBaseline
 if(!$comparison.unchanged -or $copyData.Rows.Count -ne $data.Rows.Count){Refuse 'COPY_READBACK_MISMATCH'}
 [ordered]@{ok=$true;action='Create';branch=$Branch;database=$database;created=$true;copiedRows=$data.Rows.Count;copiedColumns=101;copiedNativeLinks=$links;nonNullableColumns=@($schema|Where-Object{!$_.nullable}|ForEach-Object{$_.name});sourceDefaultedColumns=@($schema|Where-Object{$_.defaulted}|ForEach-Object{$_.name});readbackMatches=$true;productionWrites=0}|ConvertTo-Json -Compress
}catch{
 if($transaction){try{$transaction.Rollback()}catch{}}
 $labError=$_.Exception.GetBaseException();$code=if($labError.Message -cmatch '^[A-Z][A-Z0-9_]{4,79}$'){$labError.Message}else{'COPY_LAB_OPERATION_FAILED'}
 [ordered]@{ok=$false;action=$Action;branch=$Branch;stage=$stage;code=$code;type=$labError.GetType().Name;sqlNumber=if($labError -is [Data.SqlClient.SqlException]){$labError.Number}else{$null};detailsWithheld=$true;productionWrites=0}|ConvertTo-Json -Compress
 exit 1
}finally{
 if($transaction){$transaction.Dispose()};foreach($conn in @($sourceDb,$targetDb,$masterDb)){if($conn){$conn.Dispose()}}
 if($hqCredentials){$hqCredentials.Clear()};if($sourceCredentials){$sourceCredentials.Clear()};$packet=$null;$password=$null
}
