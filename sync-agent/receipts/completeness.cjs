'use strict';
const {spawn}=require('node:child_process'),path=require('node:path'),{isDeepStrictEqual:equal}=require('node:util');
const POLICY='ada-receipt-completeness-v1';
const retryCodes=new Set(['RECON_SOURCE_UNAVAILABLE','RECON_SOURCE_RETRY','RECON_SOURCE_NOT_ARRIVED','RECON_SOURCE_FIELDS_INCOMPLETE']);
function read(target,credentials,job,{mode='Live'}={}){
 return new Promise((resolve,reject)=>{
  const child=spawn('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoProfile','-NonInteractive','-File',path.join(__dirname,'Read-ReceiptSnapshot.ps1'),'-Mode',mode],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,PSModulePath:'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules'}});
  let output='',done=false;const finish=(error,result)=>{if(done)return;done=true;clearTimeout(timer);error?reject(error):resolve(result);};
  const timer=setTimeout(()=>{child.kill();finish(Error('RECON_SOURCE_RETRY'));},15000);
  child.stdout.on('data',b=>{output+=b.toString('utf8');if(output.length>1500000){child.kill();finish(Error('RECON_SOURCE_FIELDS_INCOMPLETE'));}});child.stderr.on('data',()=>{});
  child.on('error',()=>finish(Error('RECON_SOURCE_UNAVAILABLE')));child.on('close',code=>{try{const r=JSON.parse(output.trim().replace(/^\uFEFF/,''));if(code!==0||!r.ok)throw Object.assign(Error(retryCodes.has(r.code)?r.code:'RECON_SOURCE_UNAVAILABLE'),{copyDetail:r.detail});finish(null,r.observation);}catch(e){finish(e);}});
  child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify({scope:'SCCRM-READ-RECEIPT-V1',target,credentials,job}));
 });
}
async function stableRead(target,credentials,job,{reader=read,pause=()=>new Promise(r=>setTimeout(r,500)),mode='Live'}={}){
 let previous;for(let n=0;n<4;n++){const current=await reader(target,credentials,job,{mode});if(previous&&equal(previous,current))return {...current,stableReadCount:2};previous=current;if(n<3)await pause();}throw Error('RECON_SOURCE_RETRY');
}
function createReconciler({api,targets,credentials,reader=stableRead,onStatus=()=>{},stopping=()=>false,sleep=ms=>new Promise(r=>setTimeout(r,ms))}){
 let stop=false;const statuses=new Map();
 async function cycle(branch){let job;try{
  job=(await api('completeness-lease',{originBranch:branch,policy:POLICY})).job;if(!job){statuses.set(branch,{at:new Date().toISOString(),state:'idle',code:'RECON_NO_DUE_JOB'});try{onStatus({policy:POLICY,branches:[...statuses].map(([branch,value])=>({branch,...value}))});}catch{}return;}
  if(job.policy!==POLICY||job.identity?.branchCode!==branch)throw Error('RECON_SOURCE_UNAVAILABLE');
  let packet={id:job.id,leaseToken:job.leaseToken,baselineHash:job.baselineHash,policy:POLICY};
  try{packet.source=await reader(targets.find(t=>t.branch===branch),credentials[branch],job);packet.hq=await reader(targets.find(t=>t.branch==='000'),credentials['000'],job);}
  catch(error){delete packet.source;delete packet.hq;packet.errorCode=retryCodes.has(error.message)?error.message:'RECON_SOURCE_UNAVAILABLE';}
  const ack=await api('completeness-acknowledge',packet);statuses.set(branch,{at:new Date().toISOString(),claimId:job.id,accepted:ack.accepted,state:ack.state,code:ack.code});
 }catch{statuses.set(branch,{at:new Date().toISOString(),state:'retry',code:'RECON_SOURCE_UNAVAILABLE'});}try{onStatus({policy:POLICY,branches:[...statuses].map(([branch,value])=>({branch,...value}))});}catch{}}
 async function lane(branch){while(!stop&&!stopping()){await cycle(branch);for(let ms=0;ms<2000&&!stop&&!stopping();ms+=250)await sleep(250);}}
 return {cycle,requestStop(){stop=true;},start:()=>Promise.all(['001','003','004','005'].map(lane))};
}
module.exports={POLICY,read,stableRead,createReconciler};
