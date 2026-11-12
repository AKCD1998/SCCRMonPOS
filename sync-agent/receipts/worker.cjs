'use strict';
const {REVIEW}=require('./native-adapter.cjs');
const TARGETS=['000','001','003','004','005'];
const SCOPE='SCCRM-HQ-RECEIPT-SYNC-V1';
function failureCode(e){const c=e?.code||e?.message;return /^RECEIPT_[A-Z_0-9]{2,70}$/.test(c||'')?c:'RECEIPT_SOURCE_UNAVAILABLE';}
function createWorker({api,receive,probe=async()=>{},targets,onStatus=()=>{},stopping=()=>false,sleep=ms=>new Promise(r=>setTimeout(r,ms)),pollMs=2000}){
 if(!Array.isArray(targets)||targets.length!==5||new Set(targets.map(t=>t.branch)).size!==5||targets.some(t=>!TARGETS.includes(t.branch))||pollMs!==2000)throw Error('RECEIPT_WORKER_CONFIG_REFUSED');
 const state=new Map(),verified=new Set();let stop=false;
 // The status file is observational. A sharing violation while a monitor is
 // reading it must not terminate a delivery lane or the worker Promise.all.
 const publish=()=>{try{onStatus({scope:SCOPE,state:stop?'stopped':([...state.values()].some(t=>t.state==='retry'||t.state==='review')?'attention-required':'healthy'),
  targets:TARGETS.map(branch=>({branch,...(state.get(branch)||{state:'waiting'})}))});}catch{}};
 async function cycle(target){
  let job;
  try{
   if(!verified.has(target.branch)){await probe(target);verified.add(target.branch);}
   const data=await api('lease',{targetBranch:target.branch,timePolicy:'ada-final-time-v1'});job=data.job;
   if(!job){state.set(target.branch,{state:'healthy',sqlVerified:true,at:new Date().toISOString()});publish();return;}
   if(job.targetBranch!==target.branch||job.payload?.operationId!==job.id)throw Error('RECEIPT_ACK_IDENTITY_REFUSED');
   let outcome;
   try{outcome={state:'succeeded',code:'ADA_RECEIPT_VERIFIED',proof:await receive(target,job)};}
   catch(error){const code=failureCode(error);if(/^RECEIPT_SOURCE_/.test(code))verified.delete(target.branch);outcome={state:REVIEW.test(code)?'review':'retry',code};}
   const ack=await api('acknowledge',{id:job.id,targetBranch:target.branch,leaseToken:job.leaseToken,payloadHash:job.payloadHash,...outcome});
   if(ack.accepted!==true)throw Error('RECEIPT_ACK_EXPIRED_RETRY');
   state.set(target.branch,{state:outcome.state,sqlVerified:true,code:outcome.code,jobId:job.id,at:new Date().toISOString()});publish();
  }catch(error){state.set(target.branch,{state:'retry',code:failureCode(error),...(job?{jobId:job.id}:{}),at:new Date().toISOString()});publish();}
 }
 async function lane(target){while(!stop&&!stopping()){await cycle(target);for(let i=0;i<pollMs&&!stop&&!stopping();i+=250)await sleep(250);}}
 return {cycle,requestStop(){stop=true;publish();},async start(){await Promise.all(targets.map(lane));}};
}
function httpApi({token,fetchImpl=globalThis.fetch}){
 if(typeof token!=='string'||token.length<32)throw Error('RECEIPT_WORKER_CREDENTIAL_REQUIRED');
 return async(action,body)=>{
  if(!['lease','acknowledge','completeness-lease','completeness-acknowledge'].includes(action))throw Error('RECEIPT_WORKER_ACTION_REFUSED');
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);
  try{
   const response=await fetchImpl('https://sc-official-website.onrender.com/internal/sccrm-receipt-sync/'+action,{method:'POST',redirect:'error',signal:controller.signal,
    headers:{'Content-Type':'application/json','x-sccrm-receipt-worker':token},body:JSON.stringify(body)});
   if(!response.ok||Number(response.headers.get('content-length')||0)>2097152)throw Error('RECEIPT_QUEUE_UNAVAILABLE');
   let text='';const decoder=new TextDecoder();for await(const chunk of response.body){text+=decoder.decode(chunk,{stream:true});if(Buffer.byteLength(text)>2097152)throw Error('RECEIPT_QUEUE_RESPONSE_REFUSED');}text+=decoder.decode();
   const data=JSON.parse(text);if(data.ok!==true)throw Error('RECEIPT_QUEUE_UNAVAILABLE');return data;
  }finally{clearTimeout(timer);}
 };
}
module.exports={createWorker,httpApi,SCOPE,TARGETS};
