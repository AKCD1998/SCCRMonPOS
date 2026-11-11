'use strict';
// Operator-only: credentials stay in memory, protected local storage and stdin.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawnSync}=require('node:child_process');
const {readAdmin}=require('../fanout/admin-source.cjs');
const {localSecrets,saveLocalSecrets,seal}=require('./secrets.cjs');
const {SCOPE,TARGETS}=require('./worker.cjs');
const ROOT=__dirname,RUNTIME=path.join(ROOT,'runtime');
function privateRuntime(){
 fs.mkdirSync(RUNTIME,{recursive:true});
 // The existing helper binds to its own folder, so prepare the new operator
 // runtime using a separately owned copy, never change the points directory.
 const own=path.join(ROOT,'Prepare-PrivateRuntime.ps1');
 if(!fs.existsSync(own))throw Error('RECEIPT_PRIVATE_RUNTIME_HELPER_REQUIRED');
 const r=spawnSync('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoProfile','-NonInteractive','-File',own,'-RuntimeDirectory',RUNTIME],{windowsHide:true,encoding:'utf8',timeout:10000,env:{...process.env,PSModulePath:'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules'}});
 if(r.status!==0)throw Error('RECEIPT_PRIVATE_RUNTIME_REQUIRED');
}
function state(){
 privateRuntime();
 if(fs.existsSync(path.join(RUNTIME,'credentials.dpapi')))return localSecrets();
 const value={scope:SCOPE,apiToken:crypto.randomBytes(32).toString('hex'),credentials:Object.fromEntries(TARGETS.map(b=>[b,{user:'sccrm_receipt_sync_'+b,password:'Sc!'+crypto.randomBytes(28).toString('hex')}]))};
 saveLocalSecrets(value);return value;
}
async function verifyCopies(){
 privateRuntime();
 const results=await Promise.all(TARGETS.map(branch=>require('./native-copy.integration.cjs').run(branch)));
 const adapter=await require('./adapter-copy.integration.cjs').run();
 if(results.some(r=>!r.ok||r.productionWrites!==0||!r.customerAndSalesUnchanged)||!adapter.ok)throw Error('RECEIPT_COPY_PROOF_REQUIRED');
 const proof={ok:true,scope:SCOPE,at:new Date().toISOString(),branches:TARGETS,results,adapter,productionWrites:0,pinRead:false,
  receiverHash:crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT,'native-receiver.sql'))).digest('hex')};
 fs.writeFileSync(path.join(RUNTIME,'copy-proof.json'),JSON.stringify(proof,null,2));return proof;
}
function provision(action,branches){
 if(!['Preflight','Install'].includes(action)||!Array.isArray(branches)||!branches.length||new Set(branches).size!==branches.length||branches.some(b=>!TARGETS.includes(b)))throw Error('RECEIPT_PROVISION_EXPLICIT_TARGETS_REQUIRED');
 const secret=action==='Install'?state():null;
 const proof=action==='Install'?JSON.parse(fs.readFileSync(path.join(RUNTIME,'copy-proof.json'),'utf8')):null;
 const results=[];
 for(const branch of branches){let admin;
  try{
   admin=readAdmin(branch);
   const packet={scope:'SCCRM-RECEIPT-RECEIVER-PROVISION-V1',branch,admin:{user:admin.user,password:admin.password},
    ...(secret?{workerPassword:secret.credentials[branch].password,copyProof:proof}:{})};
   const r=spawnSync('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoProfile','-NonInteractive','-File',path.join(ROOT,'Provision-Receiver.ps1'),'-Action',action],
    {windowsHide:true,encoding:'utf8',input:JSON.stringify(packet),timeout:30000,maxBuffer:65536,env:{...process.env,PSModulePath:'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules'}});
   let result;try{result=JSON.parse((r.stdout||'').trim());}catch{throw Error('RECEIPT_PROVISION_RESULT_REFUSED');}
   if(r.status!==0||result.ok!==true)throw Object.assign(Error(result.code||'RECEIPT_PROVISION_FAILED'),{code:result.code,stage:result.stage,branch});
   results.push(result);
  }finally{if(admin)admin.password='';}
 }
 const result={ok:true,scope:SCOPE,action,at:new Date().toISOString(),results};
 if(action==='Install')fs.writeFileSync(path.join(RUNTIME,'receiver-install-result.json'),JSON.stringify(result,null,2));
 return result;
}
function verifyRights(){
 const secret=state(),results=[];
 for(const branch of TARGETS){
  const r=spawnSync('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoProfile','-NonInteractive','-File',path.join(ROOT,'Read-ReceiverRights.ps1')],
   {windowsHide:true,encoding:'utf8',input:JSON.stringify({branch,credentials:secret.credentials[branch]}),timeout:15000,env:{...process.env,PSModulePath:'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules'}});
  let result;try{result=JSON.parse(r.stdout.trim());}catch{throw Error('RECEIPT_RIGHTS_RESULT_REFUSED');}
  if(r.status!==0||!result.ok)throw Object.assign(Error(result.code||'RECEIPT_RIGHTS_VERIFY_FAILED'),{branch});results.push(result);
 }
 const out={ok:true,scope:SCOPE,at:new Date().toISOString(),results};fs.writeFileSync(path.join(RUNTIME,'receiver-rights.json'),JSON.stringify(out,null,2));return out;
}
function sealService(){
 const remote='\\\\100.90.166.72\\D\\SCCRM-HQ-LiveSync-20261024\\receipts';
 const owner=JSON.parse(fs.readFileSync(path.join(remote,'.receipt-service-owner.json'),'utf8'));
 if(owner.marker!=='a7dc1e0f-91d3-431c-bd97-fb142c5ae082'||owner.service!=='SCCRMHQReceiptSync'||owner.root!=='D:\\SCCRM-HQ-LiveSync-20261024\\receipts')throw Error('RECEIPT_SERVICE_OWNER_REFUSED');
 const rights=JSON.parse(fs.readFileSync(path.join(RUNTIME,'receiver-rights.json'),'utf8'));
 if(!rights.ok||rights.results.length!==5||rights.results.some(r=>!r.ok||r.receiver_execute!==1||r.customer_update!==0))throw Error('RECEIPT_RIGHTS_PROOF_REQUIRED');
 const jwk=JSON.parse(fs.readFileSync(path.join(remote,'status','bootstrap-public.json'),'utf8'));
 fs.writeFileSync(path.join(remote,'runtime','credentials.hybrid.json'),JSON.stringify(seal(state(),jwk)));
 return {ok:true,scope:SCOPE,protectedPacketDelivered:true,plaintextFilesWritten:0,deliveryEnabled:false};
}
module.exports={state,privateRuntime,verifyCopies,provision,verifyRights,sealService,RUNTIME};
if(require.main===module)(async()=>{
 const [action,...branches]=process.argv.slice(2);
 if(action==='verify-copies')return verifyCopies();
 if(action==='preflight')return provision('Preflight',branches);
 if(action==='install-receivers')return provision('Install',branches);
 if(action==='verify-rights')return verifyRights();
 if(action==='seal-service')return sealService();
 throw Error('RECEIPT_OPERATOR_ACTION_REQUIRED');
})().then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(JSON.stringify({ok:false,code:/^RECEIPT_[A-Z_]+$/.test(e.code||e.message)?e.code||e.message:'RECEIPT_OPERATOR_FAILED',stage:e.stage,branch:e.branch,detailsWithheld:true}));process.exitCode=1;});
