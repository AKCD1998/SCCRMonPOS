'use strict';
// Explicit operator export only. No background entry point and no source writes.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawn,spawnSync}=require('node:child_process');
const {databaseIdentity,validateOwnedCompensation}=require('./compensation.cjs');
// Operator-only dependency is loaded only if no scoped runtime reader is injected.
function defaultAdminReader(branch){return require('../fanout/admin-source.cjs').readAdmin(branch);}
const BRANCHES=Object.freeze(['000','001','003','004','005']);
const SCOPE='SCCRM-ADA-POINTS-EXPORT-20261102';
const VIEW_HASH='e6e48b1f9c1a69a3bdf53098530c2dbaffb7e2a9b3f7ee0440c78202cf3a7fa4';
const ROOT=__dirname,RUNTIME=path.join(ROOT,'runtime');
const sha=x=>crypto.createHash('sha256').update(typeof x==='string'?x:JSON.stringify(x)).digest('hex');
function payloadContent(s){return {identity:s.identity,schemaHash:s.schemaHash,customers:s.customers,points:s.points,balances:s.balances,...(Object.hasOwn(s,'databaseIdentity')?{databaseIdentity:s.databaseIdentity}:{}),...(Object.hasOwn(s,'ownedCompensation')?{ownedCompensation:s.ownedCompensation}:{}),sourceConsistency:s.sourceConsistency};}
function fail(code){throw Object.assign(Error(code),{code});}
function normalizeCaptureTimestamp(value){
 if(typeof value!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,7})?Z$/.test(value))fail('POINT_EXPORT_CAPTURE_TIME_REFUSED');
 const milliseconds=Date.parse(value);if(!Number.isFinite(milliseconds))fail('POINT_EXPORT_CAPTURE_TIME_REFUSED');
 const normalized=new Date(milliseconds).toISOString();
 if(normalized.slice(0,19)!==value.slice(0,19))fail('POINT_EXPORT_CAPTURE_TIME_REFUSED');
 return normalized;
}
function normalizeCaptureTimes(snapshot){
 // PowerShell's round-trip timestamp has seven fractional digits; PostgreSQL
 // retains microseconds, while delivery freshness uses JS milliseconds. Give
 // every consumer the same UTC millisecond instant before validation/storage.
 // Native business-calendar dates deliberately never pass through this helper.
 return {...snapshot,captureStartedAt:normalizeCaptureTimestamp(snapshot.captureStartedAt),captureCompletedAt:normalizeCaptureTimestamp(snapshot.captureCompletedAt)};
}
function safeCode(e){return /^[A-Z][A-Z_0-9]{4,100}$/.test(e?.code||e?.message||'')?(e.code||e.message):'POINT_EXPORT_FAILED';}
function privateRuntime(runtimeDirectory=RUNTIME){
 const target=path.resolve(runtimeDirectory),relative=path.relative(RUNTIME,target);
 if(relative.startsWith('..')||path.isAbsolute(relative))fail('POINT_EXPORT_PRIVATE_PATH_REQUIRED');
 fs.mkdirSync(target,{recursive:true,mode:0o700});
 if(process.platform==='win32'){
  const p=spawnSync('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoProfile','-NonInteractive','-File',path.join(ROOT,'Prepare-PrivateRuntime.ps1'),'-RuntimeDirectory',target],{windowsHide:true,encoding:'utf8',timeout:10000,stdio:['ignore','pipe','pipe'],env:{...process.env,PSModulePath:'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules'}});
  if(p.status!==0)fail('POINT_EXPORT_PRIVATE_ACL_REQUIRED');
 }else fs.chmodSync(target,0o700);
 return target;
}
function schemaSignature(schema){
 return sha(schema.columns.map(c=>[c.object_name,c.name,c.data_type,c.max_length,c.precision,c.scale]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))));
}
function validateSchema(schema){
 if(!schema||schema.viewHash!==VIEW_HASH||sha(String(schema.viewDefinition).replace(/\s+/g,' ').trim().toLowerCase())!==VIEW_HASH)fail('POINT_EXPORT_VIEW_FINGERPRINT_REFUSED');
 const pointFields=['FTBchCode','FTCstCode','FTPntRefDoc','FTSplCode','FDPntDate','FCPntPointbyOne','FCPntAmtRcv','FNPntPoint','FNPntPointOld','FTPntExpired','FTPntStaPrcDoc','FTPntCardType','FTCptJDate','FTCptTime','FDPntSplStart','FDPntSplExpired','FTPntStaExpired','FDDateUpd','FTTimeUpd','FTWhoUpd','FDDateIns','FTTimeIns','FTWhoIns'];
 const master=['FTCstCode','FCCstRetPoint','FCCstRetAmt','FCCstWhsPoint','FCCstDailyPoint','FTBchCode','FDCstLastPoint','FDDateUpd','FTTimeUpd'];
 const view=['FTCstCode','FNPntPoint','FCPntAmtRcv'];
 const fields={TCNMCst:master,TCNTCstPoint:pointFields,VCN_TCNMPdtCstPointAmt:view};
 if(!Array.isArray(schema.columns)||schema.columns.length!==master.length+pointFields.length+view.length)fail('POINT_EXPORT_SCHEMA_FIELDS_REFUSED');
 const floatFields=new Set(['FCCstRetPoint','FCCstRetAmt','FCCstWhsPoint','FCCstDailyPoint','FCPntPointbyOne','FCPntAmtRcv']);
 const dates=new Set(['FDPntDate','FDPntSplStart','FDPntSplExpired','FDCstLastPoint','FDDateUpd','FDDateIns']);
 const textSizes={FTBchCode:6,FTCstCode:20,FTPntRefDoc:30,FTSplCode:20,FTPntExpired:1,FTPntStaPrcDoc:1,FTPntCardType:1,FTCptJDate:6,FTCptTime:8,FTPntStaExpired:1,FTTimeUpd:8,FTWhoUpd:50,FTTimeIns:8,FTWhoIns:50};
 for(const [object,names]of Object.entries(fields)){
  const cols=schema.columns.filter(c=>c.object_name===object);
  if(cols.length!==names.length||new Set(cols.map(c=>c.name)).size!==names.length||cols.some(c=>!names.includes(c.name)))fail('POINT_EXPORT_SCHEMA_FIELDS_REFUSED');
  for(const c of cols){
   const type=object==='VCN_TCNMPdtCstPointAmt'&&c.name!=='FTCstCode'?'float':floatFields.has(c.name)?'float':dates.has(c.name)?'datetime':['FNPntPoint','FNPntPointOld'].includes(c.name)?'bigint':'varchar';
   const size=type==='varchar'?(object==='TCNMCst'&&c.name==='FTBchCode'?3:textSizes[c.name]):8;
   if(c.data_type!==type||c.max_length!==size)throw Object.assign(Error('POINT_EXPORT_SCHEMA_TYPE_REFUSED'),{code:'POINT_EXPORT_SCHEMA_TYPE_REFUSED',schemaColumn:{object,column:c.name,type:c.data_type,length:c.max_length,expectedType:type,expectedLength:size}});
  }
 }
 const keys=schema.pointPrimaryKey;
 if(!Array.isArray(keys)||keys.map(k=>k.name).join(',')!=='FTBchCode,FTCstCode,FTPntRefDoc,FTSplCode'||keys.some((k,i)=>k.key_ordinal!==i+1))fail('POINT_EXPORT_SCHEMA_KEY_REFUSED');
 return schemaSignature(schema);
}
function invoke(packet,{mode,timeoutMs=120000}={}){
 if(!['Live','Copy'].includes(mode))fail('POINT_EXPORT_MODE_REFUSED');
 return new Promise((resolve,reject)=>{
  const child=spawn('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoProfile','-NonInteractive','-File',path.join(ROOT,'Read-NativePoints.ps1'),'-Mode',mode],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,PSModulePath:'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules'}});
  let stdout='',done=false;
  const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);error?reject(error):resolve(value);};
  const timer=setTimeout(()=>{child.kill();finish(Object.assign(Error('POINT_EXPORT_TIMEOUT'),{code:'POINT_EXPORT_TIMEOUT'}));},timeoutMs);
  child.stdout.setEncoding('utf8');
  child.stdout.on('data',data=>{stdout+=data;if(Buffer.byteLength(stdout)>96*1024*1024){child.kill();finish(Error('POINT_EXPORT_OUTPUT_LIMIT'));}});
  child.stderr.on('data',()=>{});child.stdin.on('error',()=>{});
  child.on('error',()=>finish(Error('POINT_EXPORT_PROCESS_FAILED')));
  child.on('close',code=>{if(done)return;try{
   let r=JSON.parse(stdout.trim().replace(/^\uFEFF/,''));
   if(code!==0||r.ok!==true){const e=Object.assign(Error(safeCode(r)),{code:safeCode(r),stage:r.stage,sqlNumber:r.sqlNumber});finish(e);return;}
   r=normalizeCaptureTimes(r);
   if(r.scope!==SCOPE||r.mode!==mode||r.branch!==packet.branch||r.identity?.machine!==packet.machine||r.identity?.db!==packet.database||r.productionWrites!==0||r.pinRead!==false)fail('POINT_EXPORT_RESPONSE_IDENTITY_REFUSED');
   r.schemaHash=validateSchema(r.schema);
   if(!Array.isArray(r.customers)||!Array.isArray(r.points)||!Array.isArray(r.balances))fail('POINT_EXPORT_RESPONSE_ROWS_REFUSED');
   if(!r.sourceConsistency||typeof r.sourceConsistency.stable!=='boolean'||!['firstHash','secondHash'].every(k=>/^[a-f0-9]{64}$/.test(r.sourceConsistency[k]))||r.sourceConsistency.stable!==(r.sourceConsistency.firstHash===r.sourceConsistency.secondHash))fail('POINT_EXPORT_STABILITY_PROOF_REQUIRED');
   if(r.databaseIdentity!==databaseIdentity(r))fail('POINT_EXPORT_DATABASE_IDENTITY_REFUSED');
   validateOwnedCompensation(r);
   finish(null,r);
  }catch(e){finish(Object.assign(Error(safeCode(e)),{code:safeCode(e),schemaColumn:e.schemaColumn}));}});
  child.stdin.end(JSON.stringify(packet));
 });
}
async function readSnapshot(branch,{mode='Live',copyKind='UiSandbox',adminReader=defaultAdminReader}={}){
 if(!BRANCHES.includes(branch)||!['Live','Copy'].includes(mode)||mode==='Copy'&&(!['UiSandbox','PointCopy'].includes(copyKind)||copyKind==='UiSandbox'&&branch!=='000'))fail('POINT_EXPORT_TARGET_REFUSED');
 const admin=adminReader(mode==='Copy'?'000':branch);
 try{
  if(admin.branch!==(mode==='Copy'?'000':branch)||admin.database!=='AdaAcc'||admin.provenance?.effectiveConfigRead!==true||admin.provenance?.readonlySqlIdentityVerified!==true||admin.provenance?.remoteFilesWritten!==0||admin.provenance?.pinRead!==false)fail('POINT_EXPORT_ADMIN_PROVENANCE_REFUSED');
  const packet={scope:SCOPE,branch,database:mode==='Live'?'AdaAcc':copyKind==='PointCopy'?`SCCRM_PointCopy_20261102_${branch}`:'SCCRM_UiSandbox_20261024_142127',...(mode==='Copy'?{copyKind}:{}),server:admin.server,machine:admin.machine,sourceHost:admin.provenance.sourceHost,effectiveConfigRead:true,admin:{user:admin.user,password:admin.password}};
  const result=await invoke(packet,{mode});
  result.provenance={kind:admin.provenance.kind,path:admin.provenance.path,configuredServer:admin.configuredServer,resolvedServer:admin.server,serverKey:admin.provenance.serverKey,effectiveConfigRead:true,remoteFilesWritten:0,pinRead:false};
  result.payloadHash=sha(payloadContent(result));
  return result;
 }finally{admin.password='';}
}
function summary(result){return {branch:result.branch,mode:result.mode,identity:result.identity,databaseIdentity:result.databaseIdentity,customers:result.customers.length,points:result.points.length,balances:result.balances.length,ownedReceipts:result.ownedCompensation?.receipts?.length||0,sourceStable:result.sourceConsistency.stable,schemaHash:result.schemaHash,viewHash:result.schema.viewHash,payloadHash:result.payloadHash,productionWrites:0,pinRead:false};}
async function exportAll({mode,copyKind='UiSandbox',branches=BRANCHES,runtimeDirectory=RUNTIME}={}){
 if(!['Live','Copy'].includes(mode)||!Array.isArray(branches)||!branches.length||new Set(branches).size!==branches.length||branches.some(b=>!BRANCHES.includes(b))||mode==='Copy'&&(!['UiSandbox','PointCopy'].includes(copyKind)||copyKind==='UiSandbox'&&branches.some(b=>b!=='000')))fail('POINT_EXPORT_EXPLICIT_SCOPE_REQUIRED');
 runtimeDirectory=privateRuntime(runtimeDirectory);
 const results=[];
 for(const branch of branches){
  try{const r=await readSnapshot(branch,{mode,copyKind});const destination=path.join(runtimeDirectory,'native-'+mode.toLowerCase()+'-'+branch+'.json');fs.writeFileSync(destination,JSON.stringify(r,null,2),{mode:0o600});results.push({ok:r.sourceConsistency.stable,...(!r.sourceConsistency.stable?{code:'POINT_SOURCE_CHANGED_DURING_CAPTURE'}:{}),...summary(r)});}
  catch(e){results.push({ok:false,branch,code:safeCode(e),stage:e.stage,sqlNumber:e.sqlNumber,...(e.schemaColumn?{schemaColumn:e.schemaColumn}:{}),productionWrites:0,pinRead:false});}
 }
 const report={ok:results.every(r=>r.ok),scope:SCOPE,at:new Date().toISOString(),mode,results,productionWrites:0,pinRead:false};
 fs.writeFileSync(path.join(runtimeDirectory,'export-'+mode.toLowerCase()+'-summary.json'),JSON.stringify(report,null,2),{mode:0o600});return report;
}
if(require.main===module){const mode=process.argv[2],branches=process.argv.slice(3);exportAll({mode,branches:branches.length?branches:BRANCHES}).then(r=>{console.log(JSON.stringify(r));if(!r.ok)process.exitCode=1;}).catch(e=>{console.error(JSON.stringify({ok:false,code:safeCode(e),productionWrites:0,pinRead:false}));process.exitCode=1;});}
module.exports={BRANCHES,SCOPE,VIEW_HASH,ROOT,RUNTIME,sha,payloadContent,normalizeCaptureTimestamp,normalizeCaptureTimes,safeCode,privateRuntime,schemaSignature,validateSchema,invoke,readSnapshot,summary,exportAll};
