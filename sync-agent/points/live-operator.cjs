'use strict';
// Explicit provisioning/review entry point. Never loaded by the service.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {Client,Pool}=require('pg');
const {ROOT,RUNTIME,TCP,invoke}=require('./native-operator.cjs');
const {privateRuntime,safeCode,BRANCHES,readSnapshot}=require('./export.cjs');
const {readAdmin}=require('../fanout/admin-source.cjs');
const {pgAdmin}=require('../fanout/operator.cjs');
const {localSecrets,saveLocalSecrets,seal}=require('./secrets.cjs');
const {invokeNative}=require('./native-adapter.cjs');
const SCOPE='SCCRM-ADA-PRIMARY-POINTS-SERVICE-V1';
function hashFile(file){return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');}
function proof(){
 const a=JSON.parse(fs.readFileSync(path.join(RUNTIME,'native-copy-result.json'))),b=JSON.parse(fs.readFileSync(path.join(RUNTIME,'native-protocol-result.json'))),c=JSON.parse(fs.readFileSync(path.join(RUNTIME,'store-copy-result.json')));
 if(!a.ok||a.passed<30||a.productionWrites!==0||a.pinRead!==false||!BRANCHES.every(k=>a.preservation?.[k]?.unchanged&&a.preservation[k].customerColumns===101)||!b.ok||!b.unchanged||b.productionWrites!==0||b.nativeTemplateSha256!==hashFile(path.join(ROOT,'native-receiver.sql'))||!c.ok)throw Error('POINT_CURRENT_COPY_PROOFS_REQUIRED');
 return {nativeChecks:a.passed,protocolChecks:b.checks,storeVerified:c.ok,templateHash:b.nativeTemplateSha256};
}
function state(){return fs.existsSync(path.join(RUNTIME,'credentials.dpapi'))?localSecrets():null;}
function save(s){if(s.scope!==SCOPE)throw Error('POINT_OPERATOR_SECRET_SCOPE_REQUIRED');saveLocalSecrets(s);}
async function prepare(){
 privateRuntime();proof();let s=state();if(s){if(s.scope!==SCOPE)throw Error('POINT_OPERATOR_SCOPE_COLLISION');return {ok:true,action:'prepared-already',nativeInstalled:s.nativeInstalled||[]};}
 const existing=pgAdmin(),url=new URL(existing.url),project=decodeURIComponent(url.username).split('.').slice(1).join('.');
 if(project!=='fneevjmjlgvjqcocknft')throw Error('POINT_EXISTING_SUPABASE_PROJECT_REQUIRED');
 url.username='sccrm_ada_points.'+project;url.password=crypto.randomBytes(32).toString('hex');
 s={scope:SCOPE,pgUrl:url.href,sourceCredentials:{},nativeInstalled:[],config:{scope:SCOPE,mode:'Live',sources:[],targets:[],projectionPolicy:{allowNativeHomeBranch:true,openingSourceByCode:{}},pollMs:30000,sourceConcurrency:2,targetConcurrency:2,maxAgeMs:120000,drainLimit:20,leaseMs:60000,deliveryCodes:['AR005-000031']}};
 for(const branch of BRANCHES){const a=readAdmin(branch);try{
  const databaseIdentity=branch+'/'+a.machine+'/AdaAcc';
  s.sourceCredentials[branch]={user:'sccrm_point_sync_'+branch,password:'Sc!'+crypto.randomBytes(32).toString('hex')+'9A'};
  s.config.sources.push({branchCode:branch,databaseIdentity,machine:a.machine,server:TCP[branch],configuredServer:a.configuredServer,provenance:{kind:a.provenance.kind,path:a.provenance.path,sourceHost:a.provenance.sourceHost,serverKey:a.provenance.serverKey,effectiveConfigRead:true,remoteFilesWritten:0,pinRead:false}});
  s.config.targets.push({targetId:'branch'+branch,branchCode:branch,databaseIdentity,enabled:branch==='005'});
 }finally{a.password='';}}
 save(s);fs.writeFileSync(path.join(RUNTIME,'config.json'),JSON.stringify(s.config,null,2));
 return {ok:true,action:'prepared-encrypted-operator-state',pilotCode:'AR005-000031',deliveryEnabled:false,productionWrites:0};
}
async function installNative(){
 proof();const s=state();if(s?.scope!==SCOPE)throw Error('POINT_PREPARE_REQUIRED');const results=[];
 for(const branch of BRANCHES){if(s.nativeInstalled.includes(branch)){results.push({branch,alreadyInstalled:true});continue;}
  const a=readAdmin(branch),source=s.config.sources.find(t=>t.branchCode===branch);
  try{
   if(a.machine!==source.machine||a.database!=='AdaAcc')throw Error('POINT_EFFECTIVE_SOURCE_CHANGED');
   const target={branch,server:source.server,machine:source.machine,database:'AdaAcc',identity:source.databaseIdentity};
   const r=invoke('Provision-LivePoints.ps1',{scope:'SCCRM-ADA-PRIMARY-POINTS-LIVE-PROVISION-V1',target,admin:{user:a.user,password:a.password},worker:s.sourceCredentials[branch],copyVerified:true},30000,['-Action','Install']);
   const rights=await invokeNative({mode:'Live',target,credentials:s.sourceCredentials[branch],action:'rights'});
   s.nativeInstalled.push(branch);save(s);results.push({...r,rights});
  }finally{a.password='';}
 }
 const r={ok:true,at:new Date().toISOString(),action:'native-restricted-receivers-installed',results,pointDeliveryEnabled:false,profileWrites:0,nativePointWrites:0,pinRead:false};fs.writeFileSync(path.join(RUNTIME,'live-native-install-result.json'),JSON.stringify(r,null,2));return r;
}
async function installPg(){
 proof();const s=state();if(s?.nativeInstalled?.length!==5)throw Error('POINT_ALL_NATIVE_ROLES_REQUIRED');
 const a=pgAdmin(),admin=new Client({connectionString:a.url.href,ssl:{ca:a.ca,rejectUnauthorized:true},connectionTimeoutMillis:8000,query_timeout:60000});await admin.connect();
 try{await require('./pg-runtime.cjs').provision(admin,{password:decodeURIComponent(new URL(s.pgUrl).password)});}finally{await admin.end();}
 s.pgInstalled=true;save(s);
 const runtime=new Pool({connectionString:s.pgUrl,ssl:{ca:a.ca,rejectUnauthorized:true},max:2,connectionTimeoutMillis:8000});let rights;
 try{rights=await require('./pg-runtime.cjs').checkRights(runtime);}finally{await runtime.end();}
 const r={ok:true,at:new Date().toISOString(),action:'private-pg-projection-installed',rights,pointDeliveryEnabled:false,oldLedgerWrites:0};fs.writeFileSync(path.join(RUNTIME,'live-pg-install-result.json'),JSON.stringify(r,null,2));return r;
}
async function readRestricted(){
 const s=state();if(s?.nativeInstalled?.length!==5)throw Error('POINT_ALL_NATIVE_ROLES_REQUIRED');const results=[];
 const reader=branch=>{const c=s.config.sources.find(t=>t.branchCode===branch);return {branch,database:'AdaAcc',server:c.server,machine:c.machine,configuredServer:c.configuredServer,...s.sourceCredentials[branch],provenance:{...c.provenance,readonlySqlIdentityVerified:true}};};
 for(const branch of BRANCHES){const start=Date.now();const r=await readSnapshot(branch,{mode:'Live',adminReader:reader});fs.writeFileSync(path.join(RUNTIME,'restricted-live-'+branch+'.json'),JSON.stringify(r));results.push({branch,stable:r.sourceConsistency.stable,rows:r.points.length,elapsedMs:Date.now()-start,identity:r.databaseIdentity});}
 const r={ok:results.every(x=>x.stable),at:new Date().toISOString(),action:'all-five-restricted-source-read',results,nativePointWrites:0,pinRead:false};fs.writeFileSync(path.join(RUNTIME,'restricted-read-result.json'),JSON.stringify(r,null,2));return r;
}
async function verifyProjection(){
 const s=state();if(!s?.pgInstalled)throw Error('POINT_PRIVATE_PG_REQUIRED');const a=pgAdmin();
 const db=new Pool({connectionString:s.pgUrl,ssl:{ca:a.ca,rejectUnauthorized:true},max:4,connectionTimeoutMillis:8000,query_timeout:45000});
 const config={...s.config,targets:s.config.targets.map(t=>({...t,enabled:false}))};
 const adminReader=branch=>{const c=config.sources.find(t=>t.branchCode===branch);return {branch,database:'AdaAcc',server:c.server,machine:c.machine,configuredServer:c.configuredServer,...s.sourceCredentials[branch],provenance:{...c.provenance,readonlySqlIdentityVerified:true}};};
 try{
  const r=await require('./worker.cjs').createWorker({db,config,adminReader}).runCycle();
  const jobs=(await db.query('SELECT count(*)::int n FROM ada_points.delivery_jobs')).rows[0].n;
  const out={ok:['healthy','attention'].includes(r.state)&&r.sourceCount===5&&jobs===0,at:new Date().toISOString(),action:'actual-private-projection-only',status:r,jobs,nativePointWrites:0,oldLedgerWrites:0};
  fs.writeFileSync(path.join(RUNTIME,'live-projection-result.json'),JSON.stringify(out,null,2));return out;
 }finally{await db.end();}
}
async function transfer(){
 const s=state();if(!s?.pgInstalled||s.nativeInstalled.length!==5)throw Error('POINT_ALL_RUNTIME_ROLES_REQUIRED');
 const dest='\\\\100.90.166.72\\D\\SCCRM-HQ-LiveSync-20261024\\points';
 const identity=JSON.parse(fs.readFileSync(path.join(dest,'status','bootstrap-identity.json'))),key=JSON.parse(fs.readFileSync(path.join(dest,'status','bootstrap-public.json')));
 if(identity.machine!=='SERVER'||identity.sessionId!==0||identity.accountSid!=='S-1-5-19')throw Error('POINT_LOCAL_SERVICE_BOOTSTRAP_REQUIRED');
 const packet=seal({scope:SCOPE,pgUrl:s.pgUrl,sourceCredentials:s.sourceCredentials},key);
 fs.writeFileSync(path.join(dest,'runtime','credentials.hybrid.json'),JSON.stringify(packet));return {ok:true,action:'encrypted-runtime-credentials-transferred',machine:'SERVER',sessionId:0,plaintextSecretsWritten:false};
}
if(require.main===module)(async()=>{const action=process.argv[2],actions={'prepare':prepare,'install-native':installNative,'install-pg':installPg,'read-restricted':readRestricted,'verify-projection':verifyProjection,'transfer':transfer};if(!actions[action])throw Error('POINT_EXPLICIT_OPERATOR_ACTION_REQUIRED');console.log(JSON.stringify(await actions[action]()));})().catch(e=>{console.error(JSON.stringify({ok:false,code:safeCode(e),stage:e.stage,sqlNumber:e.sqlNumber,detailsWithheld:true}));process.exitCode=1;});
module.exports={SCOPE,proof,state,prepare,installNative,installPg,readRestricted,verifyProjection,transfer};
