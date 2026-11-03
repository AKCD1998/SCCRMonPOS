$ErrorActionPreference='Stop'
$file=Join-Path $PSScriptRoot '..\points\Invoke-PointNative.ps1'
$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($file,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Native adapter syntax failed'}
$function=$ast.FindAll({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Assert-LiveTarget'},$true)
if($function.Count -ne 1){throw 'Expected one isolated target guard'}
. ([ScriptBlock]::Create($function[0].Extent.Text))
$cases=@(
 @('000','100.90.166.72','49800','SERVER'),@('001','100.81.137.41','49754','SC_001'),
 @('003','100.77.101.94','49703','POSSRV'),@('004','100.113.59.42','49976','SERVER004'),@('005','100.106.107.80','49711','POSSRV')
)
$checks=0
foreach($case in $cases){
 $branch=$case[0];$ip=$case[1];$port=$case[2];$machine=$case[3]
 $target=@{branch=$branch;server=$ip+'\SQLEXPRESS';machine=$machine;database='AdaAcc';identity=$branch+'/'+$machine+'/AdaAcc'}
 $credentials=@{user='sccrm_point_sync_'+$branch}
 Assert-LiveTarget $target $credentials 'rights';$checks++
 $target.server='tcp:'+$ip+','+$port;Assert-LiveTarget $target $credentials 'apply';$checks++
 foreach($mutation in @(
  @{server='100.99.142.113\SQLEXPRESS'},@{server=$ip+'\OTHER'},@{server='tcp:'+$ip+',1'},
  @{database='OtherDatabase'},@{machine='OtherMachine'},@{identity='other/'+$machine+'/AdaAcc'},@{branch='999'}
 )){
  $changed=$target.Clone();foreach($key in $mutation.Keys){$changed[$key]=$mutation[$key]}
  $denied=$false;try{Assert-LiveTarget $changed $credentials 'rights'}catch{$denied=$_.Exception.Message -ceq 'POINT_LIVE_TARGET_REFUSED'}
  if(!$denied){throw 'Unsafe target accepted'};$checks++
 }
 $denied=$false;try{Assert-LiveTarget $target @{user='sa'} 'rights'}catch{$denied=$_.Exception.Message -ceq 'POINT_LIVE_WORKER_LOGIN_REQUIRED'}
 if(!$denied){throw 'Broad SQL credential accepted'};$checks++
 $denied=$false;try{Assert-LiveTarget $target $credentials 'upgrade-copy'}catch{$denied=$_.Exception.Message -ceq 'POINT_LIVE_TARGET_REFUSED'}
 if(!$denied){throw 'Copy-only action accepted in live mode'};$checks++
}
[ordered]@{ok=$true;checks=$checks;sqlConnections=0;productionWrites=0}|ConvertTo-Json -Compress
