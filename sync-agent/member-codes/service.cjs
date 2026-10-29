'use strict';
// Runtime wiring only. No provisioning, code allocation or operator migration.
const {Pool}=require('pg');
const {AssignmentSource,AssignmentAuthority,AssignedReceiver}=require('./sql-adapter.cjs');
const {newAssignmentRuntime}=require('./runtime.cjs');
const HQ_IDENTITY='hq000/SERVER.SQLEXPRESS/AdaAcc/64fa3170-80ae-45ee-b9f3-7478b2a46e34';
const AUTHORITY='sccrm_hq_member_code_authority';
const PEERS={'001':{ip:'100.81.137.41',machine:'SC_001'},'003':{ip:'100.77.101.94',machine:'POSSRV'},'004':{ip:'100.113.59.42',machine:'SERVER004'},'005':{ip:'100.106.107.80',machine:'POSSRV'}};
function validateServiceConfig(config,secrets,{pgHost,targets}){
 if(!config||config.enabled!==true||config.scope!=='SCCRM-HQ-MEMBER-CODES-V1'||config.hqIdentity!==HQ_IDENTITY||config.source?.server!=='tcp:127.0.0.1,49800'||config.source?.database!=='AdaAcc'||config.source?.machine!=='SERVER'||config.source?.branchCode!=='000'||config.source?.user!=='sccrm_member_codes_source'||config.source?.hqIdentity!==HQ_IDENTITY||config.source?.targetIdentity!==HQ_IDENTITY)throw Error('MEMBER_CODE_SOURCE_CONFIG_REFUSED');
 let url;try{url=new URL(secrets?.authorityPgUrl||'invalid:');}catch{throw Error('MEMBER_CODE_AUTHORITY_CONFIG_REFUSED');}if(!['postgres:','postgresql:'].includes(url.protocol)||url.hostname!==pgHost||!url.hostname.endsWith('.pooler.supabase.com')||url.port!=='5432'||url.pathname!=='/postgres'||!decodeURIComponent(url.username).startsWith(AUTHORITY+'.')||typeof secrets.sourcePassword!=='string'||!secrets.sourcePassword.trim())throw Error('MEMBER_CODE_AUTHORITY_CONFIG_REFUSED');
 if(!Array.isArray(targets)||!Array.isArray(config.targets)||config.targets.length!==targets.length||config.targets.length>4)throw Error('MEMBER_CODE_TARGET_LIST_REFUSED');
 const seen=new Set();for(const t of config.targets){const base=targets.find(b=>b.targetId===t?.targetId),peer=PEERS[t?.branchCode];if(!base||!peer||seen.has(t.targetId)||t.branchCode!==base.branchCode||t.targetId!=='branch'+t.branchCode||t.databaseIdentity!==base.databaseIdentity||t.database!=='AdaAcc'||t.machine!==peer.machine||t.server!==base.server||t.user!==base.user||t.authorityUser!=='sccrm_member_code_authority_'+t.branchCode||typeof secrets.authorityPasswords?.[t.targetId]!=='string'||!secrets.authorityPasswords[t.targetId].trim())throw Error('MEMBER_CODE_TARGET_BINDING_REFUSED');seen.add(t.targetId);}
 return config;
}
async function checkTargetBindings(pool,targets){
 const ids=targets.map(t=>t.targetId);
 const rows=(await pool.query(`SELECT COALESCE(v.target_id,a.target_id) target_id,v.database_identity legacy_identity,v.branch_code legacy_branch,v.enabled legacy_enabled,a.database_identity assigned_identity,a.branch_code assigned_branch,a.enabled assigned_enabled FROM sccrm_fanout.targets v FULL JOIN sccrm_member_codes.targets a USING(target_id) WHERE v.target_id=ANY($1::text[]) OR a.target_id=ANY($1::text[])`,[ids])).rows;
 if(rows.length!==targets.length||targets.some(t=>!rows.some(r=>r.target_id===t.targetId&&r.legacy_identity===t.databaseIdentity&&r.assigned_identity===t.databaseIdentity&&r.legacy_branch===t.branchCode&&r.assigned_branch===t.branchCode&&typeof r.legacy_enabled==='boolean'&&r.legacy_enabled===r.assigned_enabled)))throw Error('MEMBER_CODE_TARGET_STATE_MISMATCH');
 return {matched:rows.length};
}
function createCodeResources({config,secrets,deliveryPool,deliveryPasswords,pgHost,targets,ca},dependencies={}){
 validateServiceConfig(config,secrets,{pgHost,targets});
 if(config.targets.some(t=>typeof deliveryPasswords?.[t.targetId]!=='string'||!deliveryPasswords[t.targetId].trim()))throw Error('MEMBER_CODE_DELIVERY_CREDENTIAL_REQUIRED');
 const FactoryPool=dependencies.Pool||Pool,Source=dependencies.AssignmentSource||AssignmentSource,Authority=dependencies.AssignmentAuthority||AssignmentAuthority,Receiver=dependencies.AssignedReceiver||AssignedReceiver,makeRuntime=dependencies.newAssignmentRuntime||newAssignmentRuntime;
 const authorityPool=new FactoryPool({connectionString:secrets.authorityPgUrl,ssl:{ca,rejectUnauthorized:true},max:3,connectionTimeoutMillis:5000,query_timeout:8000,application_name:'SCCRM-HQ-MemberCodeAuthority'});authorityPool.on('error',()=>{});
 const sourceConfig={mode:'live',connection:{...config.source,password:secrets.sourcePassword}};
 const source=new Source(sourceConfig),snapshotSource=new Source(sourceConfig);
 const resources=[source,snapshotSource],adapters={};
 for(const target of config.targets){
  const common={...target,hqIdentity:config.hqIdentity,targetIdentity:target.databaseIdentity};
  const authority=new Authority({mode:'live',connection:{...common,user:target.authorityUser,password:secrets.authorityPasswords[target.targetId]}});
  const receiver=new Receiver({mode:'live',connection:{...common,password:deliveryPasswords[target.targetId]}});resources.push(authority,receiver);
  adapters[target.targetId]={async receive(job,{signal}={}){
   // Authorization uses a separate principal which cannot change customers.
   // Only this immutable HQ-verified tuple can be consumed by the receiver.
   await authority.approve({assignment:job.assignment,assignmentHash:job.assignment_hash,profile:job.profile,previousNativeCode:job.previous_native_code||null},signal);
   return receiver.receive(job,{signal});
  }};
 }
 const runtime=makeRuntime({deliveryPool,authorityPool,source,snapshotSource,adapters,expectedHqIdentity:config.hqIdentity});
 let closing;return {runtime,close(){return closing||=(async()=>{let failure;try{await runtime.stop();}catch(error){failure=error;}for(const r of resources){try{r.close();}catch(error){failure||=error;}}try{await authorityPool.end();}catch(error){failure||=error;}if(failure)throw failure;})();}};
}
module.exports={HQ_IDENTITY,AUTHORITY,PEERS,validateServiceConfig,checkTargetBindings,createCodeResources};
