param([Parameter(Mandatory=$true)][ValidateSet('000','001','003','004','005')][string]$Branch)
# INTERNAL PIPE ONLY. Successful stdout contains credentials for the parent Node
# process. Never invoke this helper directly into a console, tool log or transcript.
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.Encoding]::UTF8
$native=@{
 '000'=@{ip='100.90.166.72';machine='SERVER';server='tcp:100.90.166.72,49800'}
 '001'=@{ip='100.81.137.41';machine='SC_001';server='100.81.137.41\SQLEXPRESS'}
 '003'=@{ip='100.77.101.94';machine='POSSRV';server='100.77.101.94\SQLEXPRESS'}
 '004'=@{ip='100.113.59.42';machine='SERVER004';server='100.113.59.42\SQLEXPRESS'}
 '005'=@{ip='100.106.107.80';machine='POSSRV';server='100.106.107.80\SQLEXPRESS'}
}
$source=$native[$Branch];$values=@{};$db=$null;$jet=$null;$privateDir=$null;$privateFile=$null;$builder=$null
$stage='source';$result=$null;$failed=$false;$availableKeys=@()
try{
 if($Branch -ceq '000'){
  $provenancePath='\\100.90.166.72\C\Users\Administrator\Desktop\Stockdays\SC-StockDay-Ordering\apps\adapos-sync\.env'
  foreach($line in [IO.File]::ReadAllLines($provenancePath)){
   if($line -match '^\s*(ADAPOS_SQLSERVER_HOST|ADAPOS_SQLSERVER_DATABASE|ADAPOS_SQLSERVER_USER|ADAPOS_SQLSERVER_PASSWORD|ADAPOS_SYNC_BRANCH_CODE)\s*=\s*(.*)$'){
    $values[$matches[1]]=$matches[2].Trim().Trim([char]34,[char]39)
   }
  }
  if($values.ADAPOS_SYNC_BRANCH_CODE -cne '000'){throw 'ADMIN_SOURCE_BRANCH_REFUSED'}
  $configuredServer=[string]$values.ADAPOS_SQLSERVER_HOST
  $database=[string]$values.ADAPOS_SQLSERVER_DATABASE
  $sqlUser=[string]$values.ADAPOS_SQLSERVER_USER
  $sqlPassword=[string]$values.ADAPOS_SQLSERVER_PASSWORD
  $kind='existing-HQ-agent-env';$serverKey='ADAPOS_SQLSERVER_HOST'
 }else{
  if([Environment]::Is64BitProcess){throw 'ADMIN_SOURCE_REQUIRES_32BIT_JET'}
  $provenancePath='\\'+$source.ip+'\D\AdaSoft\AdaPos4.0HpmFhn\AdaTools\AdaIni.ada'
  $info=Get-Item -LiteralPath $provenancePath
  if($info.Length -lt 16384 -or $info.Length -gt 2097152){throw 'ADMIN_SOURCE_FILE_SCOPE_REFUSED'}
  $stage='private-copy'
  $privateDir=Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) ('SCCRM-Fanout-AdminBootstrap\'+[guid]::NewGuid().ToString('N'))
  $null=New-Item -ItemType Directory -Path $privateDir
  $stage='private-acl'
  $acl=New-Object Security.AccessControl.DirectorySecurity
  $acl.SetAccessRuleProtection($true,$false)
  foreach($sidValue in @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value,'S-1-5-18','S-1-5-32-544')){
   $sid=New-Object Security.Principal.SecurityIdentifier $sidValue
   $rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
   $acl.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $privateDir -AclObject $acl
  $privateFile=Join-Path $privateDir 'AdaIni.ada'
  $stage='private-file-copy'
  $inputFile=[IO.File]::Open($provenancePath,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite)
  try{$outputFile=[IO.File]::Open($privateFile,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);try{$inputFile.CopyTo($outputFile)}finally{$outputFile.Dispose()}}finally{$inputFile.Dispose()}
  $after=Get-Item -LiteralPath $provenancePath
  if($after.Length -ne $info.Length -or $after.LastWriteTimeUtc -ne $info.LastWriteTimeUtc){throw 'ADMIN_SOURCE_CONFIG_CHANGED_DURING_READ'}
  $stage='jet-read'
  $jet=New-Object Data.OleDb.OleDbConnection ('Provider=Microsoft.Jet.OLEDB.4.0;Data Source='+$privateFile+';Mode=Read;')
  $jet.Open();$query=$jet.CreateCommand();$query.CommandTimeout=5
  $query.CommandText="SELECT FTCfgCode FROM TConfig WHERE FTCfgCode LIKE 'Sql%'"
  $reader=$query.ExecuteReader()
  try{while($reader.Read()){$availableKeys+=([string]$reader.GetValue(0)).Trim()}}finally{$reader.Dispose()}
  $query.CommandText="SELECT FTCfgCode,FTCfgOn FROM TConfig WHERE FTCfgCode IN ('SqlDB','SqlSrc','SqlSrv','SqlServer','SqlSvr','SqlSvrName','SqlSrvName','SqlUsrC','SqlUsrP')"
  $reader=$query.ExecuteReader()
  try{while($reader.Read()){$key=([string]$reader.GetValue(0)).Trim();if($values.ContainsKey($key)){throw 'ADMIN_SOURCE_DUPLICATE_CONFIG_KEY'};$values[$key]=[string]$reader.GetValue(1)}}finally{$reader.Dispose();$query.Dispose();$jet.Dispose();$jet=$null}
  $serverKeys=@(@('SqlSrc','SqlSrv','SqlServer','SqlSvr','SqlSvrName','SqlSrvName')|Where-Object{$values.ContainsKey($_) -and ([string]$values[$_]).Trim()})
  if($serverKeys.Count -ne 1){throw 'ADMIN_SOURCE_SQL_SERVER_KEY_UNRESOLVED'}
  $serverKey=$serverKeys[0];$configuredServer=([string]$values[$serverKey]).Trim()
  $database=([string]$values.SqlDB).Trim();$sqlUser=([string]$values.SqlUsrC).Trim()
  $sqlPassword=[string]$values.SqlUsrP;$kind='native-TConfig-private-readonly-Jet-copy'
 }
 if($database -ine 'AdaAcc'){throw 'ADMIN_SOURCE_DATABASE_REFUSED'}
 if(!$sqlUser -or !$sqlPassword -or $sqlUser.Length -gt 128 -or $sqlPassword.Length -gt 1024){throw 'ADMIN_SOURCE_CREDENTIAL_INCOMPLETE'}
 # The logical host comes from the effective native config. A relative local
 # alias is relative to this known source machine, never to the caller's PC.
 $normalized=$configuredServer.Trim();if($normalized.StartsWith('tcp:',[StringComparison]::OrdinalIgnoreCase)){$normalized=$normalized.Substring(4)}
 $hostPart=($normalized -split '[\\,]')[0]
 if($hostPart -ine $source.machine -and $hostPart -ine $source.ip -and $hostPart -notin @('.','(local)','localhost','127.0.0.1')){throw 'ADMIN_SOURCE_CONFIGURED_HOST_REFUSED'}
 $stage='sql-readonly-identity'
 $builder=New-Object Data.SqlClient.SqlConnectionStringBuilder
 $builder['Data Source']=$source.server;$builder['Initial Catalog']='AdaAcc'
 $builder['User ID']=$sqlUser;$builder['Password']=$sqlPassword
 $builder['Connect Timeout']=5;$builder['Application Name']='SCCRM-Fanout-Admin-Source-ReadOnly'
 $db=New-Object Data.SqlClient.SqlConnection $builder.ConnectionString;$db.Open();$builder['Password']=''
 $query=$db.CreateCommand();$query.CommandTimeout=5
 $query.CommandText="SET LOCK_TIMEOUT 1000;SELECT CONVERT(nvarchar(128),SERVERPROPERTY('MachineName')) machine,DB_NAME() db,IS_SRVROLEMEMBER('sysadmin') elevated,HAS_PERMS_BY_NAME(NULL,'SERVER','ALTER ANY LOGIN') can_create_login,HAS_PERMS_BY_NAME(DB_NAME(),'DATABASE','CONTROL') can_provision_database"
 $reader=$query.ExecuteReader()
 try{
  if(!$reader.Read() -or $reader.GetString(0) -ine $source.machine -or $reader.GetString(1) -cne 'AdaAcc'){throw 'ADMIN_SOURCE_SQL_IDENTITY_REFUSED'}
  $actualMachine=$reader.GetString(0)
  if($reader.GetInt32(2) -ne 1 -and ($reader.GetInt32(3) -ne 1 -or $reader.GetInt32(4) -ne 1)){throw 'ADMIN_SOURCE_NOT_PRIVILEGED'}
 }finally{$reader.Dispose();$query.Dispose()}
 $result=[ordered]@{ok=$true;user=$sqlUser;password=$sqlPassword;database='AdaAcc';configuredServer=$configuredServer;server=$source.server;machine=$actualMachine;branch=$Branch;provenance=[ordered]@{kind=$kind;path=$provenancePath;sourceHost=$source.ip;serverKey=$serverKey;effectiveConfigRead=$true;readonlySqlIdentityVerified=$true;pinRead=$false;remoteFilesWritten=0}}
}catch{
 $failed=$true;$sourceError=$_.Exception.GetBaseException()
 $code=if($sourceError.Message -cmatch '^[A-Z_]{6,100}$'){$sourceError.Message}else{'ADMIN_SOURCE_READ_FAILED'}
 $result=[ordered]@{ok=$false;code=$code;branch=$Branch;stage=$stage;type=$sourceError.GetType().Name;sqlNumber=if($sourceError -is [Data.SqlClient.SqlException]){$sourceError.Number}else{$null};availableSqlKeys=$availableKeys;detailsWithheld=$true;remoteFilesWritten=0;pinRead=$false}
}finally{
 if($jet){$jet.Dispose()};if($db){$db.Dispose()};if($builder){$builder['Password']=''}
 $cleanupOk=$true
 if($privateFile){foreach($file in @($privateFile,[IO.Path]::ChangeExtension($privateFile,'.ldb'))){try{if([IO.File]::Exists($file)){[IO.File]::Delete($file)}}catch{$cleanupOk=$false}}}
 if($privateDir){try{if([IO.Directory]::Exists($privateDir)){[IO.Directory]::Delete($privateDir,$false)}}catch{$cleanupOk=$false}}
 if($result){$result.privateTemporaryCopyRemoved=$cleanupOk;[Console]::WriteLine(($result|ConvertTo-Json -Depth 5 -Compress))}
 $values.Clear();$sqlPassword=$null;$sqlUser=$null;$line=$null;$result=$null
}
if($failed){exit 1}
