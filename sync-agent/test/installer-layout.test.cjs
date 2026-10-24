'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),{spawnSync}=require('node:child_process');

test('Windows PowerShell 5 installer restores every private cluster directory',()=>{
 const root=path.resolve(__dirname,'..');
 const ps=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
 const script=`$ErrorActionPreference='Stop';$root=$env:SCCRM_LAYOUT_SOURCE;$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $root 'Install-TestService.ps1'),[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'INSTALLER_PARSE_FAILED'}
$loop=$ast.Find({param($n) $n -is [Management.Automation.Language.ForEachStatementAst] -and $n.Variable.VariablePath.UserPath -eq 'relative'},$true)
if(-not $loop){throw 'LAYOUT_LOOP_NOT_FOUND'}
$pgData=Join-Path ([IO.Path]::GetTempPath()) ('sccrm-layout-test-'+[guid]::NewGuid().ToString('N'))
$null=New-Item -ItemType Directory -Path $pgData
$pgLayout=Get-Content -LiteralPath (Join-Path $root 'pg-layout.json') -Raw|ConvertFrom-Json
& ([scriptblock]::Create($loop.Extent.Text))
foreach($relative in $pgLayout){if(-not(Test-Path -LiteralPath (Join-Path $pgData $relative) -PathType Container)){throw 'LAYOUT_DIRECTORY_MISSING'}}
$count=@(Get-ChildItem -LiteralPath $pgData -Directory -Recurse).Count
if($count -ne $pgLayout.Count){throw 'UNEXPECTED_DIRECTORY_CREATED'}
[ordered]@{ok=$true;directories=$count;engine=$PSVersionTable.PSVersion.Major}|ConvertTo-Json -Compress`;
 const result=spawnSync(ps,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{encoding:'utf8',timeout:15000,env:{...process.env,SCCRM_LAYOUT_SOURCE:root,PSModulePath:path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','Modules')}});
 assert.equal(result.status,0,result.stderr||result.stdout);
 const report=JSON.parse(result.stdout.replace(/^\uFEFF/,''));
 assert.equal(report.ok,true);assert.equal(report.engine,5);assert.equal(report.directories,27);
});
