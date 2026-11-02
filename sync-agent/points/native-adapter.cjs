'use strict';
const path=require('node:path');
const {spawn}=require('node:child_process');
const {safeCode}=require('./export.cjs');
const SCOPE='SCCRM-ADA-POINT-NATIVE-V1';
function invokeNative({mode,target,credentials,action,job,adaCode,timeoutMs=45000}){
 if(!['Copy','Live'].includes(mode)||!target||!credentials||typeof credentials.password!=='string')throw Error('POINT_NATIVE_ARGUMENT_REFUSED');
 return new Promise((resolve,reject)=>{
  const child=spawn('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoProfile','-NonInteractive','-File',path.join(__dirname,'Invoke-PointNative.ps1'),'-Mode',mode],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,PSModulePath:'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules'}});
  let output='',done=false;
  const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);error?reject(error):resolve(value);};
  const timer=setTimeout(()=>{child.kill();finish(Object.assign(Error('POINT_NATIVE_TIMEOUT'),{code:'POINT_NATIVE_TIMEOUT'}));},timeoutMs);
  child.stdout.setEncoding('utf8');child.stdout.on('data',s=>{output+=s;if(output.length>8*1024*1024){child.kill();finish(Error('POINT_NATIVE_OUTPUT_LIMIT'));}});
  child.stderr.on('data',()=>{});child.stdin.on('error',()=>{});child.on('error',()=>finish(Error('POINT_NATIVE_PROCESS_FAILED')));
  child.on('close',code=>{if(done)return;try{const r=JSON.parse(output.trim().replace(/^\uFEFF/,''));if(code!==0||!r.ok)throw Object.assign(Error(safeCode(r)),{code:safeCode(r),stage:r.stage,sqlNumber:r.sqlNumber});if(r.mode!==mode||r.identity!==target.identity||r.branch!==target.branch)throw Error('POINT_NATIVE_ACK_IDENTITY_REFUSED');finish(null,r.result);}catch(e){finish(Object.assign(Error(safeCode(e)),{code:safeCode(e),stage:e.stage,sqlNumber:e.sqlNumber}));}});
  child.stdin.end(JSON.stringify({scope:SCOPE,target,credentials,action,job,adaCode}));
 });
}
function createTarget({mode,target,credentials,targetId}){
 return {targetId,databaseIdentity:target.identity,async apply(job){
  const nativeJob={operationId:job.operation_id,adaCode:job.ada_code,generation:job.generation,projectionVersion:job.projection_version,targetBalance:job.target_balance,expectedIntrinsic:job.expected_intrinsic};
  const r=await invokeNative({mode,target,credentials,action:'apply',job:nativeJob});
  if(r.operation_id!==job.operation_id||r.ada_code!==job.ada_code||String(r.generation)!==String(job.generation)||r.revision!==job.projection_version||r.target_identity!==target.identity||String(r.target_balance)!==String(job.target_balance)||!['applied','replayed','superseded'].includes(r.outcome))throw Error('POINT_NATIVE_ACK_PAYLOAD_REFUSED');
  return {operation_id:r.operation_id,ada_code:r.ada_code,generation:r.generation,projection_version:r.revision,target_balance:r.target_balance,database_identity:r.target_identity,outcome:r.outcome,delta_points:r.delta_points??null,ref_doc:r.ref_doc??null};
 }};
}
module.exports={SCOPE,invokeNative,createTarget};
