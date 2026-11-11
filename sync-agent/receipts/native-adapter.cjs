'use strict';
const path=require('node:path'),{spawn}=require('node:child_process');
const REVIEW=/^RECEIPT_(?:OTHER_MEMBER|ALREADY_OWNED|OPERATION_REUSED|MEMBER_REQUIRES_REVIEW|HEADER_CHANGED|ITEMS_CHANGED|AMBIGUOUS_HEADER|SCHEMA_REQUIRES_REVIEW|PACKET_REFUSED|JOB_REFUSED|VOID_POLICY_REFUSED|ACK_.*|READBACK_FAILED|DATABASE_REFUSED|LIVE_TARGET_REFUSED|WORKER_RIGHTS_EXCESSIVE)$/;
function receive(target,credentials,job,{mode='Live',timeout=20000,rollbackCopy=false}={}){
 if(typeof rollbackCopy!=='boolean'||rollbackCopy&&mode!=='Copy')throw Error('RECEIPT_COPY_ONLY');
 return new Promise((resolve,reject)=>{
  const child=spawn('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoProfile','-NonInteractive','-File',path.join(__dirname,'Invoke-ReceiptNative.ps1'),'-Mode',mode,...(rollbackCopy?['-RollbackCopy']:[])],
   {windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,PSModulePath:'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules'}});
  let output='',settled=false;
  const done=(e,v)=>{if(settled)return;settled=true;clearTimeout(timer);e?reject(e):resolve(v);};
  const timer=setTimeout(()=>{child.kill();done(Object.assign(Error('RECEIPT_SOURCE_RETRY'),{code:'RECEIPT_SOURCE_RETRY'}));},timeout);
  child.stdout.on('data',b=>{output+=b.toString('utf8');if(output.length>65536){child.kill();done(Error('RECEIPT_ACK_SIZE_REFUSED'));}});
  child.stderr.on('data',()=>{});child.on('error',()=>done(Error('RECEIPT_SOURCE_UNAVAILABLE')));
  child.on('close',code=>{
   try{
    const data=JSON.parse(output.trim().replace(/^\uFEFF/,''));
    if(code!==0||!data.ok){const value=/^RECEIPT_[A-Z_0-9]{2,70}$/.test(data.code||'')?data.code:'RECEIPT_SOURCE_UNAVAILABLE';throw Object.assign(Error(value),{code:value,stage:data.stage});}
    const a=data.result,p=job.payload;
    if(a.operation_id!==job.id||a.payload_hash!==job.payloadHash||a.ada_code!==p.adaCode||a.doc_no!==p.receiptNo||a.branch_code!==p.branchCode||a.pos_code!==p.posCode||a.target_branch!==job.targetBranch)throw Error('RECEIPT_ACK_IDENTITY_REFUSED');
    done(null,{operationId:a.operation_id,payloadHash:a.payload_hash,adaCode:a.ada_code,receiptNo:a.doc_no,branchCode:a.branch_code,posCode:a.pos_code,
     targetBranch:a.target_branch,tables:a.tables.split(','),outcome:a.outcome,verifiedAt:a.verified_at});
   }catch(e){done(e);}
  });child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify({scope:'SCCRM-NATIVE-RECEIPT-V1',target,credentials,job}));
 });
}
function verifyRights(target,credentials){
 return new Promise((resolve,reject)=>{
  const child=spawn('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoProfile','-NonInteractive','-File',path.join(__dirname,'Read-ReceiverRights.ps1')],
   {windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,PSModulePath:'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules'}});
  let output='',settled=false;
  const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(value);};
  const timer=setTimeout(()=>{child.kill();finish(Error('RECEIPT_SOURCE_UNAVAILABLE'));},12000);
  child.stdout.on('data',chunk=>{output+=chunk.toString('utf8');if(output.length>65536){child.kill();finish(Error('RECEIPT_RIGHTS_VERIFY_FAILED'));}});
  child.stderr.on('data',()=>{});child.on('error',()=>finish(Error('RECEIPT_SOURCE_UNAVAILABLE')));
  child.on('close',code=>{try{const r=JSON.parse(output.trim().replace(/^\uFEFF/,''));if(code!==0||!r.ok||r.branch!==target.branch||r.worker!==credentials.user||r.customer_update!==0||r.receiver_execute!==1)throw Error('RECEIPT_SOURCE_UNAVAILABLE');finish(null,{ok:true});}catch{finish(Error('RECEIPT_SOURCE_UNAVAILABLE'));}});
  child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify({branch:target.branch,credentials}));
 });
}
module.exports={receive,verifyRights,REVIEW};
