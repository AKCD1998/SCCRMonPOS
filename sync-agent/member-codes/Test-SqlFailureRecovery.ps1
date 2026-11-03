$ErrorActionPreference='Stop'
# Define only the classifier from the real RPC; never execute its SQL main loop.
$tokens=$null;$parseErrors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'SqlRpc.ps1'),[ref]$tokens,[ref]$parseErrors)
if($parseErrors.Count){throw 'RPC_PARSE_FAILED'}
$function=$ast.Find({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Safe-Code'},$true)
. ([scriptblock]::Create($function.Extent.Text))
Add-Type -ReferencedAssemblies System.Data -TypeDefinition @'
using System;
using System.Data.SqlClient;
using System.Reflection;
public static class SqlFailureFixture {
 public static SqlException Make(int number,string message,Exception inner) {
  var flags=BindingFlags.NonPublic|BindingFlags.Instance;
  var error=(SqlError)typeof(SqlError).GetConstructor(flags,null,new[]{typeof(int),typeof(byte),typeof(byte),typeof(string),typeof(string),typeof(string),typeof(int),typeof(uint)},null)
   .Invoke(new object[]{number,(byte)0,(byte)20,"fixture",message,"fixture",0,(uint)0});
  var list=(SqlErrorCollection)Activator.CreateInstance(typeof(SqlErrorCollection),true);
  typeof(SqlErrorCollection).GetMethod("Add",flags).Invoke(list,new object[]{error});
  return (SqlException)typeof(SqlException).GetConstructor(flags,null,new[]{typeof(string),typeof(SqlErrorCollection),typeof(Exception),typeof(Guid)},null)
   .Invoke(new object[]{message,list,inner,Guid.Empty});
 }
}
'@
$checks=0;$db=$null
function Check($exception,[string]$expected){
 $record=[Management.Automation.ErrorRecord]::new($exception,'fixture',[Management.Automation.ErrorCategory]::NotSpecified,$null)
 if((Safe-Code $record) -cne $expected){throw ('CLASSIFIER_FAILED_'+$expected)};$script:checks++
}
$inner=[ComponentModel.Win32Exception]::new(10054,'private transport details must stay hidden')
$sql=[SqlFailureFixture]::Make(0,'private server and customer must stay hidden',$inner)
if($sql.GetBaseException() -is [Data.SqlClient.SqlException]){throw 'NESTED_PROVIDER_REGRESSION_NOT_REPRODUCED'};$checks++
Check ([Exception]::new('PowerShell invocation wrapper',$sql)) 'TARGET_OFFLINE'
Check ([SqlFailureFixture]::Make(-2,'private timeout',[ComponentModel.Win32Exception]::new(258))) 'SQL_TIMEOUT'
Check ([SqlFailureFixture]::Make(1205,'private deadlock',$null)) 'TARGET_BUSY'
Check ([SqlFailureFixture]::Make(1222,'private lock',$null)) 'TARGET_BUSY'
Check ([SqlFailureFixture]::Make(10054,'private reset',$null)) 'TARGET_OFFLINE'
Check ([SqlFailureFixture]::Make(18456,'private login',[ComponentModel.Win32Exception]::new(10054))) 'SQL_ERROR_18456'
Check ([SqlFailureFixture]::Make(229,'private permission',$null)) 'SQL_ERROR_229'
Check ([SqlFailureFixture]::Make(2627,'private unique constraint',$null)) 'SQL_ERROR_2627'
Check ([SqlFailureFixture]::Make(50000,'MEMBER_CODES_APPROVAL_COLLISION_REVIEW',$null)) 'MEMBER_CODES_APPROVAL_COLLISION_REVIEW'
Check ([Exception]::new('CODE_RPC_IDENTITY_REFUSED')) 'CODE_RPC_IDENTITY_REFUSED'
Check ([Exception]::new('PRIVATE_CUSTOMER_IDENTIFIER_MUST_NOT_LEAK')) 'CODE_OPERATION_REVIEW'
Check ([ComponentModel.Win32Exception]::new(10061,'private refused')) 'TARGET_OFFLINE'
[ordered]@{ok=$true;checks=$checks;realSqlExceptionChain=$true;sqlConnectionsOpened=0;productionWrites=0;secretsPrinted=$false}|ConvertTo-Json -Compress
