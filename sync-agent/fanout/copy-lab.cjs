'use strict';
// Operator-invoked copy lab. This is not imported by the production worker.
const path=require('node:path');
const {spawn}=require('node:child_process');
const BRANCHES=Object.freeze(['000','001','003','004','005']);
const PREFIX='SCCRM_FanoutCopy_20261029_';
const POWERSHELL='C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
function branchCode(branch){if(typeof branch!=='string'||!BRANCHES.includes(branch))throw Error('COPY_BRANCH_REFUSED');return branch;}
function databaseFor(branch){return PREFIX+branchCode(branch);}
function run(action,branch,{sql,parameters={},runtimeDirectory,baselineTag='initial',timeoutMs=120000,copy=false}={}){
 branchCode(branch);
 if(!['Snapshot','Create','Verify','Query'].includes(action))throw Error('COPY_ACTION_REFUSED');
 if(typeof copy!=='boolean'||copy&&!['Snapshot','Verify'].includes(action))throw Error('COPY_BASELINE_MODE_REFUSED');
 if(typeof baselineTag!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/.test(baselineTag))throw Error('COPY_BASELINE_TAG_REFUSED');
 if(action==='Query'&&(typeof sql!=='string'||!sql.trim()||sql.length>1048576))throw Error('COPY_QUERY_PACKET_REFUSED');
 if(!parameters||typeof parameters!=='object'||Array.isArray(parameters)||Object.keys(parameters).some(k=>!/^[A-Za-z][A-Za-z0-9_]*$/.test(k)))throw Error('COPY_PARAMETER_REFUSED');
 const args=['-NoProfile','-NonInteractive','-File',path.join(__dirname,'CopyLab.ps1'),'-Action',action,'-Branch',branch,'-BaselineTag',baselineTag];
 if(copy)args.push('-TargetCopy');
 if(runtimeDirectory)args.push('-RuntimeDirectory',path.resolve(runtimeDirectory));
 return new Promise((resolve,reject)=>{
  const child=spawn(POWERSHELL,args,{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,PSModulePath:'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules'}});
  child.stdout.setEncoding('utf8');
  let stdout='',settled=false;
  const finish=(error,result)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(result);};
  const timer=setTimeout(()=>{child.kill();finish(Object.assign(Error('COPY_LAB_TIMEOUT'),{code:'COPY_LAB_TIMEOUT'}));},timeoutMs);
  child.stdout.on('data',data=>{stdout+=data;if(Buffer.byteLength(stdout)>8*1024*1024){child.kill();finish(Error('COPY_LAB_OUTPUT_REFUSED'));}});
  // PowerShell diagnostics may include SQL text; never forward stderr.
  child.stderr.on('data',()=>{});
  child.on('error',()=>finish(Error('COPY_LAB_PROCESS_FAILED')));
  child.on('close',code=>{
   if(settled)return;
   try{
    const lines=stdout.replace(/^\uFEFF/,'').trim().split(/\r?\n/).filter(Boolean);
    const result=JSON.parse(lines.at(-1));
    if(result.productionWrites!==0||result.branch&&result.branch!==branch||result.database&&result.database!==databaseFor(branch))throw Error('COPY_LAB_ACK_REFUSED');
    if(code!==0||result.ok!==true){const error=Object.assign(Error(result.code||'COPY_LAB_VERIFY_FAILED'),{code:result.code||'COPY_LAB_VERIFY_FAILED',result});finish(error);return;}
    finish(null,result);
   }catch(error){finish(Object.assign(Error('COPY_LAB_RESPONSE_REFUSED'),{code:'COPY_LAB_RESPONSE_REFUSED'}));}
  });
  child.stdin.on('error',()=>{});
  child.stdin.end(action==='Query'?JSON.stringify({sql,parameters}):'');
 });
}
const snapshot=(branch,options)=>run('Snapshot',branch,options);
const create=(branch,options)=>run('Create',branch,options);
const verify=(branch,options)=>run('Verify',branch,options);
const query=(branch,sql,parameters={},options={})=>run('Query',branch,{...options,sql,parameters});
module.exports={BRANCHES,PREFIX,databaseFor,run,snapshot,create,verify,query};
if(require.main===module){
 const [action,branch,tag]=process.argv.slice(2);
 if(!['snapshot','create','verify'].includes(action)){console.error(JSON.stringify({ok:false,code:'EXPLICIT_COPY_ACTION_REQUIRED'}));process.exitCode=1;}
 else run(action[0].toUpperCase()+action.slice(1),branch,{...(tag?{baselineTag:tag}:{})}).then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(JSON.stringify({ok:false,code:error.code||error.message,...(error.result?{result:error.result}:{})}));process.exitCode=1;});
}
