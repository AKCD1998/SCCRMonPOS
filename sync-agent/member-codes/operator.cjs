'use strict';
// Explicit administrator tooling. Never imported by a background worker.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const {Client,Pool}=require('pg');
const old=require('../fanout/operator.cjs');
const {localSecrets,saveLocalSecrets,seal}=require('../fanout/secrets.cjs');
const {readAdmin}=require('../fanout/admin-source.cjs');
const {provisionCodeRoles,checkRights,AUTHORITY_ROLE,DELIVERY_ROLE}=require('./pg-runtime.cjs');
const {registerTarget}=require('./queue.cjs');
const {HQ_IDENTITY,validateServiceConfig}=require('./service.cjs');
const {HqMigrationAuthority}=require('./sql-adapter.cjs');
const ROOT=__dirname,RUNTIME=path.join(ROOT,'runtime');
const MARKER='64fa3170-80ae-45ee-b9f3-7478b2a46e34',SCOPE='SCCRM-HQ-MEMBER-CODES-V1';
const IDS=['30b4d6d8-f29b-443e-be66-46d9c2248853','dd313ef6-b74c-4548-960a-f42582239289'];
const BRANCHES=['000','005','001','003','004'];
const pw=()=>`Sc!${crypto.randomBytes(24).toString('hex')}9A`;
function requireValue(ok,code){if(!ok)throw Error(code);}
function validateCohort(cohort){
 requireValue(Array.isArray(cohort)&&cohort.length===2&&new Set(cohort.map(m=>m?.memberId)).size===2&&cohort.every(m=>IDS.includes(m.memberId)&&m.previousCode==='SC-'+m.memberId.replaceAll('-','').slice(0,16).toUpperCase()&&typeof m.name==='string'&&m.name.trim()&&m.name.length<=200&&/^0[0-9]{9}$/.test(m.phone)&&typeof m.email==='string'&&m.email.length<=100),'EXACT_APPROVED_MIGRATION_COHORT_REQUIRED');return cohort;
}
function validateTargets(s){
 const targets=s.live?.targets;
 requireValue(targets&&Object.keys(targets).sort().join(',')==='001,003,004,005'&&Object.entries(targets).every(([b,t])=>t.branchCode===b&&t.targetId==='branch'+b),'ALL_REVIEWED_TARGETS_REQUIRED');
 // The original worker validator pins endpoint, login, branch and database identity.
 const legacy=require('../fanout/engine.cjs');
 const original={scope:legacy.SCOPE,marker:legacy.MARKER,mode:'live',pgHost:new URL(s.live.pgUrl).hostname,source:{machine:'SERVER',database:'AdaAcc',user:'sccrm_member_fanout_source',server:'tcp:127.0.0.1,49800'},targets:Object.values(targets),heldSourceIds:{'bf0e4513-a72d-4c83-9b17-afff6779cf9b':'SYNTHETIC_SOURCE_FIXTURE_HELD'}};
 require('../fanout/worker.cjs').validate(original,{pgUrl:s.live.pgUrl,targetPasswords:s.live.targetPasswords});
 return Object.values(targets);
}
function saveReport(name,value){fs.mkdirSync(RUNTIME,{recursive:true});fs.writeFileSync(path.join(RUNTIME,name+'.json'),JSON.stringify(value,null,2));return value;}
function invoke(file,args,packet){
 const child=spawnSync('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoProfile','-File',path.join(ROOT,file),...args],{input:JSON.stringify(packet),encoding:'utf8',windowsHide:true,timeout:60000,maxBuffer:1048576,env:{...process.env,PSModulePath:'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules'}});
 let answer;try{answer=JSON.parse(child.stdout.trim().replace(/^\uFEFF/,''));}catch{throw Error('CODE_OPERATOR_SAFE_RESULT_REQUIRED');}
 if(child.status!==0||!answer.ok)throw Object.assign(Error(answer.code||'CODE_OPERATOR_REFUSED'),{safeResult:answer});return answer;
}
function readNative(action,branch='000',code,mode='Live'){
 requireValue(BRANCHES.includes(branch),'CODE_OPERATOR_BRANCH_REFUSED');const admin=readAdmin(mode==='Copy'?'000':branch);
 try{return invoke('OperatorRead.ps1',['-Mode',mode],{scope:SCOPE,action,branch,code,admin:{user:admin.user,password:admin.password}}).rows;}finally{admin.password='';}
}
function copyProof(){
 const p=JSON.parse(fs.readFileSync(path.join(ROOT,'../fanout/runtime/acceptance/member-code-native-result.json'),'utf8'));
 requireValue(p.ok&&p.scope==='SCCRM-MEMBER-CODES-NATIVE-COPY-ONLY'&&p.productionWrites===0&&p.pinRead===false&&p.passed>=30&&BRANCHES.every(b=>p.preservation[b]?.unchanged&&p.preservation[b]?.columnsChecked===101),'MEMBER_CODE_NATIVE_COPY_PROOF_REQUIRED');return p;
}
function configFor(s){
 const state=s.memberCodes;requireValue(state&&s.live,'CODE_OPERATOR_STATE_REQUIRED');
 validateTargets(s);
 return {enabled:true,scope:SCOPE,hqIdentity:HQ_IDENTITY,source:{server:'tcp:127.0.0.1,49800',database:'AdaAcc',machine:'SERVER',branchCode:'000',user:'sccrm_member_codes_source',hqIdentity:HQ_IDENTITY,targetIdentity:HQ_IDENTITY},targets:Object.values(s.live.targets).map(t=>({...t,authorityUser:'sccrm_member_code_authority_'+t.branchCode}))};
}
async function provisionLive(){
 copyProof();const s=localSecrets(),pg=old.pgAdmin();validateTargets(s);
 if(!s.memberCodes){const url=new URL(pg.url);url.username=AUTHORITY_ROLE+'.'+decodeURIComponent(url.username).split('.').slice(1).join('.');url.password=crypto.randomBytes(32).toString('hex');
  s.memberCodes={authorityPgUrl:url.href,sourcePassword:pw(),authorityPasswords:Object.fromEntries(BRANCHES.map(b=>[b,pw()])),cohort:readNative('cohort')};saveLocalSecrets(s);
 }
 const state=s.memberCodes;validateCohort(state.cohort);
 const results=[];fs.mkdirSync(RUNTIME,{recursive:true});
 for(const branch of BRANCHES){
  const admin=readAdmin(branch),t=branch==='000'?{identity:HQ_IDENTITY,server:admin.server,machine:'SERVER',database:'AdaAcc',branch,role:'hq'}:{identity:s.live.targets[branch].databaseIdentity,server:s.live.targets[branch].server,machine:s.live.targets[branch].machine,database:'AdaAcc',branch,role:'branch'};
  const allowFile=path.join(RUNTIME,'approved-target-'+branch+'.json');fs.writeFileSync(allowFile,JSON.stringify({scope:SCOPE,marker:MARKER,targets:[{...t,allowProvision:true}]}));
  try{results.push(invoke('Provision-Native.ps1',['-Mode','Live','-ApprovedTargetsFile',allowFile],{scope:SCOPE,marker:MARKER,target:t,hqIdentity:HQ_IDENTITY,admin:{user:admin.user,password:admin.password},runtime:branch==='000'?{login:'sccrm_member_codes_source',password:state.sourcePassword}:{login:s.live.targets[branch].user},authority:{login:'sccrm_member_code_authority_'+branch,password:state.authorityPasswords[branch]},creator:branch==='000'?{login:'sccrm_hq_member_sync'}:undefined,cohort:state.cohort}));}finally{admin.password='';}
 }
 const admin=new Client({connectionString:pg.url.href,ssl:{ca:pg.ca,rejectUnauthorized:true},connectionTimeoutMillis:8000,query_timeout:20000});await admin.connect();
 try{
  results.push(await provisionCodeRoles(admin,{authorityPassword:decodeURIComponent(new URL(state.authorityPgUrl).password),expectedHqIdentity:HQ_IDENTITY}));
  await admin.query('BEGIN');try{for(const target of Object.values(s.live.targets)){await registerTarget(admin,target);const base=(await admin.query('SELECT enabled FROM sccrm_fanout.targets WHERE target_id=$1 AND database_identity=$2',[target.targetId,target.databaseIdentity])).rows[0];requireValue(base,'CODE_LEGACY_TARGET_BINDING_REFUSED');await admin.query('UPDATE sccrm_member_codes.targets SET enabled=$2 WHERE target_id=$1 AND database_identity=$3',[target.targetId,base.enabled,target.databaseIdentity]);}await admin.query('COMMIT');}catch(e){await admin.query('ROLLBACK');throw e;}
 }finally{await admin.end();}
 for(const [role,url] of [[AUTHORITY_ROLE,state.authorityPgUrl],[DELIVERY_ROLE,s.live.pgUrl]]){const pool=new Pool({connectionString:url,ssl:{ca:pg.ca,rejectUnauthorized:true},max:1});try{results.push(await checkRights(pool,{role}));}finally{await pool.end();}}
 const oldConfig=JSON.parse(fs.readFileSync(path.join(old.RUNTIME,'config.json'),'utf8'));oldConfig.memberCodes=configFor(s);fs.writeFileSync(path.join(RUNTIME,'config.json'),JSON.stringify(oldConfig,null,2));
 return saveReport('live-provision-result',{ok:true,scope:SCOPE,results,customerRowsWritten:0,sourceWrapperSwitched:false});
}
function runtimeSecret(s){const targets=validateTargets(s),secrets={authorityPgUrl:s.memberCodes.authorityPgUrl,sourcePassword:s.memberCodes.sourcePassword,authorityPasswords:Object.fromEntries(targets.map(t=>[t.targetId,s.memberCodes.authorityPasswords[t.branchCode]]))};validateServiceConfig(configFor(s),secrets,{pgHost:new URL(s.live.pgUrl).hostname,targets});return secrets;}
function transferSecrets(){
 copyProof();const s=localSecrets(),dest='\\\\100.90.166.72\\D\\SCCRM-HQ-LiveSync-20261024\\fanout';
 const key=JSON.parse(fs.readFileSync(path.join(dest,'status/bootstrap-public.json'),'utf8'));requireValue(key.kty==='RSA'&&Buffer.from(key.n,'base64url').length===512,'CODE_BOOTSTRAP_KEY_REQUIRED');
 const packet=seal({pgUrl:s.live.pgUrl,sourcePassword:s.live.sourcePassword,targetPasswords:s.live.targetPasswords,memberCodes:runtimeSecret(s)},key);
 fs.writeFileSync(path.join(dest,'runtime/credentials.hybrid.json'),JSON.stringify(packet));
 return {ok:true,encrypted:true,hqMigrationCredentialTransferred:false};
}
async function migrateApproved(){
 copyProof();const s=localSecrets(),state=s.memberCodes;validateTargets(s);validateCohort(state?.cohort);
 const rpc=new HqMigrationAuthority({mode:'live',connection:{server:'tcp:100.90.166.72,49800',database:'AdaAcc',machine:'SERVER',branchCode:'000',user:'sccrm_member_code_authority_000',password:state.authorityPasswords['000'],hqIdentity:HQ_IDENTITY,targetIdentity:HQ_IDENTITY}});
 const results=[];try{for(const m of state.cohort)results.push({memberId:m.memberId,rows:await rpc.migrate({memberId:m.memberId,previousCode:m.previousCode,profile:{name:m.name,phone:m.phone,email:m.email}})});}finally{rpc.close();}
 return saveReport('live-migration-result',{ok:true,scope:SCOPE,results,unrelatedNativeWrites:0});
}
async function status(){const s=localSecrets(),pg=old.pgAdmin(),p=new Pool({connectionString:s.live.pgUrl,ssl:{ca:pg.ca,rejectUnauthorized:true},max:1});try{return {ok:true,assignments:(await p.query('SELECT assignment_id,member_id,ada_code,kind,deliver_to_branches,assigned_at FROM sccrm_member_codes.assignments ORDER BY assigned_at')).rows,targets:(await p.query('SELECT target_id,enabled FROM sccrm_member_codes.targets ORDER BY target_id')).rows,jobs:(await p.query('SELECT target_id,member_id,hq_code,state,attempt_count,last_code,queued_at,completed_at FROM sccrm_member_codes.jobs ORDER BY id')).rows,publication:(await p.query('SELECT member_id,code,previous_code,outcome,published_at FROM sccrm_member_codes.publication_events ORDER BY published_at')).rows};}finally{await p.end();}}
if(require.main===module)(async()=>{const c=process.argv[2];const answer=c==='provision-live'?await provisionLive():c==='transfer-secrets'?transferSecrets():c==='migrate-approved'?await migrateApproved():c==='status'?await status():null;requireValue(answer,'EXPLICIT_MEMBER_CODE_OPERATOR_ACTION_REQUIRED');console.log(JSON.stringify(answer));})().catch(e=>{console.error(JSON.stringify({ok:false,code:/^[A-Z_]{5,100}$/.test(e.message)?e.message:'CODE_OPERATOR_FAILED',safeResult:e.safeResult}));process.exitCode=1;});
module.exports={ROOT,RUNTIME,MARKER,SCOPE,IDS,BRANCHES,validateCohort,validateTargets,invoke,readNative,copyProof,configFor,runtimeSecret,provisionLive,transferSecrets,migrateApproved,status,saveReport};
