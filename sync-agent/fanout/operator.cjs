'use strict';
// Explicit administrator entry point. The production service never imports this.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const {createRequire}=require('node:module');
const {Client,Pool}=require('pg');
const {MARKER,SCOPE,PgQueue}=require('./engine.cjs');
const {ROLE,provisionQueue,checkRuntimeRights,registerTarget}=require('./pg-runtime.cjs');
const {localSecrets,saveLocalSecrets}=require('./secrets.cjs');
const {readAdmin}=require('./admin-source.cjs');
const ROOT=__dirname,RUNTIME=path.join(ROOT,'runtime');
const NATIVE_MARKER='86bfa892-2f57-4f60-a3f8-10b90ab5c7a9';
const BRANCHES=['005','001','003','004'];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let stage='operator-start';
function save(value){fs.mkdirSync(RUNTIME,{recursive:true});saveLocalSecrets(value);}
function state(){return fs.existsSync(path.join(RUNTIME,'credentials.dpapi'))?localSecrets():{scope:SCOPE};}
function password(){return 'Sc!'+crypto.randomBytes(24).toString('hex')+'9A';}
function nativeProvision(file,mode,target,admin,worker,approvedFile){
 const args=['-NoProfile','-File',path.join(ROOT,file),'-Mode',mode,...(approvedFile?['-ApprovedTargetsFile',approvedFile]:[])];
 const child=spawnSync('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',args,{input:JSON.stringify({scope:'SCCRM-HQ-MEMBER-FANOUT-PROVISION',marker:NATIVE_MARKER,target,admin:{user:admin.user,password:admin.password},worker}),windowsHide:true,encoding:'utf8',timeout:60000,env:{...process.env,PSModulePath:'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules'}});
 let result;try{result=JSON.parse(child.stdout.replace(/^\uFEFF/,'').trim().split(/\r?\n/).at(-1));}catch{throw Error('NATIVE_PROVISION_NO_SAFE_RESULT');}
 if(child.status!==0||!result.ok)throw Object.assign(Error(result.code||'NATIVE_PROVISION_REFUSED'),{code:result.code||'NATIVE_PROVISION_REFUSED',sqlNumber:result.sqlNumber});return result;
}
function pgAdmin(){
 const backend='C:/Users/scgro/Desktop/Webapp training project/currentSC-official-website-project/backend';
 const load=createRequire(path.join(backend,'package.json'));const env=load('dotenv').parse(fs.readFileSync(path.join(backend,'.env')));
 const url=new URL(env.SC_OFFICIAL_SUPABASE_DATABASE_URL);if(!url.hostname.endsWith('.pooler.supabase.com')||url.port!=='5432'||url.pathname!=='/postgres')throw Error('EXISTING_SUPABASE_ENDPOINT_REQUIRED');
 return {url,ca:fs.readFileSync(path.join(ROOT,'../live/supabase-ca.crt'),'utf8')};
}
function requireCopyProof(){const p=JSON.parse(fs.readFileSync(path.join(RUNTIME,'native-copy-result.json'),'utf8'));if(!p.ok||p.scope!=='SCCRM-FANOUT-NATIVE-COPY-ONLY'||p.productionWrites!==0||p.customerPinRead!==false||p.passed<80||p.membershipPolicy?.years!==100||!BRANCHES.every(b=>p.preservation[b]?.unchanged&&p.preservation[b]?.columnsChecked===101&&p.membershipValidityByBranch?.[b]?.calendarYears===100&&p.membershipValidityByBranch[b].nativeSearchSqlEligible===true&&p.membershipValidityByBranch[b].datesPreservedAfterReplay===true))throw Error('NATIVE_COPY_ACCEPTANCE_REQUIRED');return p;}
async function provisionCopy(){
 const s=state();if(!s.copy){s.copy={nonce:crypto.randomBytes(5).toString('hex'),sourcePassword:password(),targetPasswords:Object.fromEntries(BRANCHES.map(b=>[b,password()])),identities:Object.fromEntries(BRANCHES.map(b=>[b,'copy'+b+'/SERVER.SQLEXPRESS/SCCRM_FanoutCopy_20261029_'+b+'/'+crypto.randomUUID()]))};save(s);}
 const admin=readAdmin('000'),copy=s.copy,results=[];
 stage='copy-source-provision';const sourceLogin='sccrm_member_fanout_source_copy_'+copy.nonce;
 results.push(nativeProvision('Provision-Source.ps1','Copy',{identity:'copy000/SERVER.SQLEXPRESS/SCCRM_FanoutCopy_20261029_000',server:'tcp:100.90.166.72,49800',machine:'SERVER',database:'SCCRM_FanoutCopy_20261029_000',branch:'000'},admin,{login:sourceLogin,password:copy.sourcePassword}));
 const targets=[];
 for(const branch of BRANCHES){stage='copy-receiver-provision-'+branch;const target={identity:copy.identities[branch],server:'tcp:100.90.166.72,49800',machine:'SERVER',database:'SCCRM_FanoutCopy_20261029_'+branch,branch};const login='sccrm_member_fanout_'+branch+'_copy_'+copy.nonce;
  results.push(nativeProvision('Provision-Receiver.ps1','Copy',target,admin,{login,password:copy.targetPasswords[branch]}));
  targets.push({targetId:'branch'+branch,branchCode:branch,databaseIdentity:target.identity,mode:'copy',connection:{...target,user:login,password:copy.targetPasswords[branch],targetIdentity:target.identity}});
 }
 copy.sourceConfig={mode:'copy',connection:{server:'tcp:100.90.166.72,49800',machine:'SERVER',database:'SCCRM_FanoutCopy_20261029_000',user:sourceLogin,password:copy.sourcePassword}};copy.targetConfigs=targets;save(s);
 const report={ok:true,scope:'COPY_ONLY',results,productionCustomerWrites:0};fs.writeFileSync(path.join(RUNTIME,'copy-provision-result.json'),JSON.stringify(report,null,2));return report;
}
async function runCopy(){
 const s=state();if(!s.copy?.sourceConfig||s.copy.targetConfigs?.length!==4)throw Error('PROVISION_ALL_COPY_RECEIVERS_FIRST');
 const dbName='sccrm_fanout_test_native_'+Date.now();const admin=new Client({connectionString:'postgresql://postgres@127.0.0.1:55445/postgres',ssl:false});
 await admin.connect();try{await admin.query('CREATE DATABASE '+dbName);}finally{await admin.end();}
 stage='native-copy-integration';let report;
 try{report=await require('./native.integration.cjs').runNativeIntegration({poolConfig:{connectionString:'postgresql://postgres@127.0.0.1:55445/'+dbName,ssl:false,max:6},sourceConfig:s.copy.sourceConfig,targetConfigs:s.copy.targetConfigs});}
 catch(error){report=error.report||{ok:false,code:error.code||'COPY_INTEGRATION_FAILED'};fs.writeFileSync(path.join(RUNTIME,'native-copy-result.json'),JSON.stringify(report,null,2));throw error;}
 fs.writeFileSync(path.join(RUNTIME,'native-copy-result.json'),JSON.stringify(report,null,2));return report;
}
async function provisionLive(branches=['005']){
 requireCopyProof();const s=state(),pg=pgAdmin();if(!s.live){const url=new URL(pg.url);url.username=ROLE+'.'+decodeURIComponent(url.username).split('.').slice(1).join('.');url.password=crypto.randomBytes(32).toString('hex');s.live={pgUrl:url.href,sourcePassword:password(),targetPasswords:{},targets:{}};save(s);}
 const l=s.live,results=[];
 for(const branch of branches){if(!BRANCHES.includes(branch))throw Error('REVIEWED_BRANCH_REQUIRED');if(!l.targetPasswords['branch'+branch])l.targetPasswords['branch'+branch]=password();}
 save(s);const sourceAdmin=readAdmin('000');stage='live-source-read-role-provision';
 results.push(nativeProvision('Provision-Source.ps1','Live',{identity:'hq000/SERVER.SQLEXPRESS/AdaAcc',server:'tcp:100.90.166.72,49800',machine:'SERVER',database:'AdaAcc',branch:'000'},sourceAdmin,{login:'sccrm_member_fanout_source',password:l.sourcePassword}));
 const targets=[];
 for(const branch of branches){stage='live-receiver-preflight-'+branch;const a=readAdmin(branch);let t=l.targets[branch];
  if(!t){t=l.targets[branch]={targetId:'branch'+branch,branchCode:branch,databaseIdentity:'branch'+branch+'/'+a.machine+'.SQLEXPRESS/AdaAcc/'+crypto.randomUUID(),server:a.server,machine:a.machine,database:'AdaAcc',user:'sccrm_member_fanout_'+branch};save(s);}
  if(t.server!==a.server||t.machine!==a.machine)throw Error('REVIEWED_DESTINATION_CHANGED');
  const allowlist={scope:'SCCRM-HQ-MEMBER-FANOUT-TARGETS',marker:NATIVE_MARKER,targets:[{identity:t.databaseIdentity,server:t.server,machine:t.machine,database:t.database,branch,allowProvision:true,productionApproved:true}]};
  const approvedFile=path.join(RUNTIME,'approved-target-'+branch+'.json');fs.writeFileSync(approvedFile,JSON.stringify(allowlist,null,2));
  stage='live-receiver-provision-'+branch;results.push(nativeProvision('Provision-Receiver.ps1','Live',allowlist.targets[0],a,{login:t.user,password:l.targetPasswords[t.targetId]},approvedFile));targets.push(t);
 }
 stage='live-private-queue-provision';const admin=new Client({connectionString:pg.url.href,ssl:{ca:pg.ca,rejectUnauthorized:true},connectionTimeoutMillis:8000,query_timeout:20000});await admin.connect();
 try{await provisionQueue(admin,{password:decodeURIComponent(new URL(l.pgUrl).password)});for(const t of targets)await registerTarget(admin,t);}finally{await admin.end();}
 const runtime=new Pool({connectionString:l.pgUrl,ssl:{ca:pg.ca,rejectUnauthorized:true},max:2});try{await new PgQueue(runtime).guard();results.push({queueRights:await checkRuntimeRights(runtime)});}finally{await runtime.end();}
 const config={scope:SCOPE,marker:MARKER,mode:'live',pgHost:new URL(l.pgUrl).hostname,source:{server:'tcp:127.0.0.1,49800',machine:'SERVER',database:'AdaAcc',user:'sccrm_member_fanout_source'},targets:Object.values(l.targets),heldSourceIds:{'bf0e4513-a72d-4c83-9b17-afff6779cf9b':'SYNTHETIC_SOURCE_FIXTURE_HELD'}};
 fs.writeFileSync(path.join(RUNTIME,'config.json'),JSON.stringify(config,null,2));save(s);
 const report={ok:true,scope:'LIVE_CREATE_ONLY_PROVISIONED',targets:targets.map(t=>({branch:t.branchCode,identity:t.databaseIdentity})),enabled:false,results,originalCustomerWrites:0};fs.writeFileSync(path.join(RUNTIME,'live-provision-result.json'),JSON.stringify(report,null,2));return report;
}
async function setEnabled(branch,enabled){
 if(enabled)requireCopyProof();if(!BRANCHES.includes(branch))throw Error('BRANCH_REFUSED');const s=state(),a=pgAdmin();if(!s.live?.targets[branch])throw Error('TARGET_NOT_PROVISIONED');
 const admin=new Client({connectionString:a.url.href,ssl:{ca:a.ca,rejectUnauthorized:true},connectionTimeoutMillis:8000});await admin.connect();
 try{return await setTargetEnabled(admin,{targetId:'branch'+branch,enabled,databaseIdentity:s.live.targets[branch].databaseIdentity});}finally{await admin.end();}
}
async function setTargetEnabled(admin,{targetId,enabled,databaseIdentity}){
 if(!/^branch00[1345]$/.test(targetId)||typeof enabled!=='boolean'||typeof databaseIdentity!=='string'||!databaseIdentity||databaseIdentity.length>160)throw Error('TARGET_ENABLE_ARGUMENT_REFUSED');
 await admin.query('BEGIN');try{
  const exists=(await admin.query("SELECT to_regnamespace('sccrm_member_codes') namespace")).rows[0]?.namespace;
  if(exists){const meta=(await admin.query('SELECT marker,scope,schema_version FROM sccrm_member_codes.meta')).rows;const authority=require('../member-codes/assignment.cjs');if(meta.length!==1||meta[0].marker!==authority.MARKER||meta[0].scope!==authority.SCOPE||meta[0].schema_version!==1)throw Error('MEMBER_CODE_SCHEMA_NOT_OWNED');}
  const result=await admin.query('UPDATE sccrm_fanout.targets SET enabled=$2 WHERE target_id=$1 AND database_identity=$3 RETURNING target_id,database_identity,branch_code,enabled',[targetId,enabled,databaseIdentity]);if(result.rows.length!==1)throw Error('TARGET_ENABLE_IDENTITY_REFUSED');
  if(exists){const assigned=await admin.query('UPDATE sccrm_member_codes.targets SET enabled=$2 WHERE target_id=$1 AND database_identity=$3 AND branch_code=$4 RETURNING target_id',[targetId,enabled,databaseIdentity,result.rows[0].branch_code]);if(assigned.rows.length!==1)throw Error('MEMBER_CODE_TARGET_ENABLE_IDENTITY_REFUSED');}
  await admin.query('COMMIT');return {ok:true,target:result.rows[0],memberCodesSynchronized:!!exists};
 }catch(error){await admin.query('ROLLBACK').catch(()=>{});throw error;}
}
async function transferSecrets(){
 requireCopyProof();const s=state();if(!s.live)throw Error('LIVE_QUEUE_NOT_PREPARED');
 const dest='\\\\100.90.166.72\\D\\SCCRM-HQ-LiveSync-20261024\\fanout';const publicFile=path.join(dest,'status/bootstrap-public.json');
 let key;for(let i=0;i<60;i++){if(fs.existsSync(publicFile)){key=JSON.parse(fs.readFileSync(publicFile,'utf8'));break;}await sleep(500);}
 if(!key||key.kty!=='RSA'||Buffer.from(key.n,'base64url').length!==512)throw Error('HQ_BOOTSTRAP_PUBLIC_KEY_REQUIRED');
 const packet=require('./secrets.cjs').seal({pgUrl:s.live.pgUrl,sourcePassword:s.live.sourcePassword,targetPasswords:s.live.targetPasswords},key);
 fs.writeFileSync(path.join(dest,'runtime/credentials.hybrid.json'),JSON.stringify(packet));return {ok:true,scope:SCOPE,hybridEncrypted:true,plaintextSecretsTransferred:false};
}
async function status(){const s=state(),a=pgAdmin();if(!s.live)throw Error('LIVE_QUEUE_NOT_PREPARED');const p=new Pool({connectionString:s.live.pgUrl,ssl:{ca:a.ca,rejectUnauthorized:true},max:1});try{return {ok:true,targets:await new PgQueue(p).status(),jobs:(await p.query('SELECT target_id,member_id,hq_code,state,attempt_count,last_code,hq_created_at,queued_at,completed_at FROM sccrm_fanout.jobs ORDER BY id')).rows,sources:(await p.query('SELECT member_id,hq_code,state,last_code FROM sccrm_fanout.sources ORDER BY hq_created_at,member_id')).rows};}finally{await p.end();}}
async function repairPilotValidity(){
 requireCopyProof();const proof=JSON.parse(fs.readFileSync(path.join(RUNTIME,'validity-repair-copy-result.json'),'utf8'));
 if(!proof.ok||proof.scope!=='SCCRM-VALIDITY-REPAIR-COPY-ONLY'||proof.policy!=='calendar-years-100'||proof.productionWrites!==0||proof.pinRead!==false||proof.passed<13||!proof.preservation?.unchanged)throw Error('VALIDITY_REPAIR_COPY_PROOF_REQUIRED');
 const cohort=JSON.parse(fs.readFileSync(path.join(RUNTIME,'pilot-validity-cohort.json'),'utf8'));
 if(cohort.scope!=='SCCRM-005-OWNED-PILOT-VALIDITY'||cohort.policy!=='calendar-years-100'||!Array.isArray(cohort.memberIds)||cohort.memberIds.length!==2||new Set(cohort.memberIds).size!==2||cohort.memberIds.some(id=>!/^[a-f0-9-]{36}$/.test(id)))throw Error('VALIDITY_REPAIR_COHORT_REFUSED');
 const s=state(),t=s.live?.targets?.['005'],a=pgAdmin();if(!t)throw Error('PILOT_NOT_PROVISIONED');
 const pool=new Pool({connectionString:s.live.pgUrl,ssl:{ca:a.ca,rejectUnauthorized:true},max:1});let members;
 try{const r=await pool.query("SELECT j.member_id,j.hq_code,j.profile_hash FROM sccrm_fanout.jobs j JOIN sccrm_fanout.mappings m ON m.target_id=j.target_id AND m.member_id=j.member_id AND m.ada_code=j.hq_code AND m.profile_hash=j.profile_hash JOIN sccrm_fanout.targets t ON t.target_id=j.target_id AND t.database_identity=m.database_identity WHERE j.target_id='branch005' AND t.enabled=false AND t.database_identity=$2 AND j.state='succeeded' AND j.member_id=ANY($1::uuid[]) ORDER BY j.member_id",[cohort.memberIds,t.databaseIdentity]);if(r.rows.length!==2)throw Error('VALIDITY_PILOT_MAPPING_REVIEW');members=r.rows.map(r=>({memberId:r.member_id,adaCode:r.hq_code,profileHash:r.profile_hash}));}finally{await pool.end();}
 const admin=readAdmin('005');try{return require('./validity-repair.cjs').repairOwnedValidity({mode:'Live',target:{identity:t.databaseIdentity,server:t.server,machine:t.machine,database:t.database,branch:'005'},admin,members,pilotApproved:true});}finally{admin.password='';}
}
if(require.main===module)(async()=>{
 let answer;const [command,...branches]=process.argv.slice(2);
 if(command==='provision-copy')answer=await provisionCopy();
 else if(command==='test-copy')answer=await runCopy();
 else if(command==='provision-live')answer=await provisionLive(branches.length?branches:['005']);
 else if(command==='enable'||command==='disable')answer=await setEnabled(branches[0],command==='enable');
 else if(command==='transfer-secrets')answer=await transferSecrets();
 else if(command==='repair-pilot-validity')answer=await repairPilotValidity();
 else if(command==='status')answer=await status();else throw Error('EXPLICIT_FANOUT_OPERATOR_COMMAND_REQUIRED');
 console.log(JSON.stringify(answer));
})().catch(error=>{console.error(JSON.stringify(error.report||{ok:false,stage,code:error.code||(/^[A-Z_]+$/.test(error.message)?error.message:'FANOUT_OPERATOR_FAILED'),sqlNumber:error.sqlNumber}));process.exitCode=1;});
module.exports={ROOT,RUNTIME,NATIVE_MARKER,BRANCHES,nativeProvision,pgAdmin,provisionCopy,runCopy,provisionLive,setEnabled,setTargetEnabled,transferSecrets,status,repairPilotValidity};
