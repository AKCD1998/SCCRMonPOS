param([Parameter(Mandatory=$true)][string]$RuntimeDirectory)
$ErrorActionPreference='Stop'
$stage='path'
try{
 $owned=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'runtime')).TrimEnd('\')
 $target=[IO.Path]::GetFullPath($RuntimeDirectory).TrimEnd('\')
 if(!$target.Equals($owned,[StringComparison]::OrdinalIgnoreCase) -and !$target.StartsWith($owned+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'PRIVATE_RUNTIME_PATH_REFUSED'}
 if($target.StartsWith('\\')){throw 'PRIVATE_RUNTIME_NETWORK_PATH_REFUSED'}
 $current=$target
 while($current.Length -ge $owned.Length){
  $item=Get-Item -LiteralPath $current
  if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'PRIVATE_RUNTIME_REPARSE_REFUSED'}
  $current=[IO.Path]::GetDirectoryName($current)
 }
 $stage='acl-read'
 $sidTexts=@([Security.Principal.WindowsIdentity]::GetCurrent().User.Value,'S-1-5-18','S-1-5-32-544')
 $acl=[IO.Directory]::GetAccessControl($target,[Security.AccessControl.AccessControlSections]::Access)
 $rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
 if([Security.Principal.WindowsIdentity]::GetCurrent().User.Value -ceq 'S-1-5-19'){
  if($owned -cne 'D:\SCCRM-HQ-LiveSync-20261024\receipts\runtime' -or -not $acl.AreAccessRulesProtected){throw 'RECEIPT_SERVICE_RUNTIME_ACL_REQUIRED'}
  $owner=[IO.Directory]::GetAccessControl($target,[Security.AccessControl.AccessControlSections]::Owner).GetOwner([Security.Principal.SecurityIdentifier]).Value
  $allowed=@('S-1-5-18','S-1-5-32-544','S-1-5-19',$owner)
  foreach($rule in $rules){if($rule.IdentityReference.Value -notin $allowed -or $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow){throw 'RECEIPT_SERVICE_RUNTIME_ACL_EXCESSIVE'}}
  $serviceRules=@($rules|Where-Object{$_.IdentityReference.Value -ceq 'S-1-5-19'})
  if($serviceRules.Count -ne 1 -or ($serviceRules[0].FileSystemRights -band [Security.AccessControl.FileSystemRights]::Modify) -ne [Security.AccessControl.FileSystemRights]::Modify){throw 'RECEIPT_SERVICE_RUNTIME_ACL_MISSING'}
  [Console]::WriteLine('{"ok":true}');exit 0
 }
 $correct=$acl.AreAccessRulesProtected -and $rules.Count -eq $sidTexts.Count
 foreach($rule in $rules){if($rule.IdentityReference.Value -notin $sidTexts -or $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or $rule.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or $rule.InheritanceFlags -ne ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit) -or $rule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None){$correct=$false}}
 if($correct){[Console]::WriteLine('{"ok":true}');exit 0}
 $stage='acl-build'
 $acl.SetAccessRuleProtection($true,$false)
 foreach($old in @($acl.GetAccessRules($true,$false,[Security.Principal.SecurityIdentifier]))){$acl.RemoveAccessRuleSpecific($old)}
 foreach($sidText in $sidTexts){
  $sid=New-Object Security.Principal.SecurityIdentifier $sidText
  $rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
  $acl.AddAccessRule($rule)
 }
 $stage='acl-set'
 [IO.Directory]::SetAccessControl($target,$acl)
 [Console]::WriteLine('{"ok":true}')
}catch{$e=$_.Exception.GetBaseException();[ordered]@{ok=$false;code='PRIVATE_RUNTIME_PREPARATION_FAILED';stage=$stage;type=$e.GetType().Name;hresult=$e.HResult}|ConvertTo-Json -Compress;exit 1}
