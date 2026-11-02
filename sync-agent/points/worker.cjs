'use strict';
// Runtime secrets, SQL identities and adapters are injected by the service
// bootstrap. No admin-source import, native credentials, customer creation,
// legacy points writes, GUI, or service management belongs in this worker.
const fs=require('node:fs'),path=require('node:path');
const source=require('./export.cjs'),model=require('./model.cjs');
const {deriveIntrinsicSnapshots,deriveIntrinsicSnapshot}=require('./compensation.cjs');
const {projectNativePoints}=require('./projection.cjs');
const store=require('./store.cjs'),delivery=require('./delivery.cjs');
const BRANCHES=source.BRANCHES;
const fail=code=>{throw Object.assign(Error(code),{code});};
const safe=error=>/^[A-Z][A-Z0-9_]{4,100}$/.test(error?.code||'')?error.code:'POINT_WORKER_OPERATION_FAILED';
function normalizeConfig(input){
 if(!input||input.mode!=='Live')fail('POINT_WORKER_LIVE_CONFIG_REQUIRED');
 const c={...input,pollMs:input.pollMs??30000,sourceConcurrency:input.sourceConcurrency??2,targetConcurrency:input.targetConcurrency??2,maxAgeMs:input.maxAgeMs??120000,drainLimit:input.drainLimit??50,leaseMs:input.leaseMs??60000};
 if(!Number.isInteger(c.pollMs)||c.pollMs<5000||c.pollMs>300000||!Number.isInteger(c.sourceConcurrency)||c.sourceConcurrency<1||c.sourceConcurrency>2||!Number.isInteger(c.targetConcurrency)||c.targetConcurrency<1||c.targetConcurrency>2||!Number.isInteger(c.maxAgeMs)||c.maxAgeMs<5000||c.maxAgeMs>120000||!Number.isInteger(c.drainLimit)||c.drainLimit<1||c.drainLimit>500||!Number.isInteger(c.leaseMs)||c.leaseMs<5000||c.leaseMs>1800000)fail('POINT_WORKER_BOUNDS_INVALID');
 for(const key of ['sources','targets']){
  if(!Array.isArray(c[key])||c[key].length!==5||c[key].map(s=>s?.branchCode).sort().join(',')!==BRANCHES.join(','))fail('POINT_WORKER_FIVE_DATABASES_REQUIRED');
  if(c[key].some(s=>typeof s.databaseIdentity!=='string'||!s.databaseIdentity||s.databaseIdentity.length>1024||/[\x00-\x1f\x7f]/.test(s.databaseIdentity)))fail('POINT_WORKER_IDENTITY_REQUIRED');
  if(new Set(c[key].map(s=>s.databaseIdentity)).size!==5)fail('POINT_WORKER_DUPLICATE_IDENTITY');
 }
 if(new Set(c.targets.map(t=>t.targetId)).size!==5||c.targets.some(t=>typeof t.targetId!=='string'||!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(t.targetId)||typeof t.enabled!=='boolean'||c.sources.find(s=>s.branchCode===t.branchCode).databaseIdentity!==t.databaseIdentity))fail('POINT_WORKER_TARGET_BINDING_REFUSED');
 if(c.projectionPolicy?.ownerMap!==undefined)fail('POINT_WORKER_OWNER_MAP_MUST_BE_DATABASE_APPROVAL');
 const p=c.projectionPolicy??{};
 if(p.allowNativeHomeBranch!==undefined&&typeof p.allowNativeHomeBranch!=='boolean')fail('POINT_WORKER_OPENING_POLICY_REFUSED');
 const selection=p.openingSourceByCode??{};
 if(!selection||typeof selection!=='object'||Array.isArray(selection)||Object.entries(selection).some(([code,b])=>!code||code.length>20||!BRANCHES.includes(b)))fail('POINT_WORKER_OPENING_POLICY_REFUSED');
 const deliveryCodes=c.deliveryCodes??null;
 if(deliveryCodes!==null&&(!Array.isArray(deliveryCodes)||deliveryCodes.length<1||deliveryCodes.length>20||new Set(deliveryCodes).size!==deliveryCodes.length||deliveryCodes.some(code=>typeof code!=='string'||code.length>20||!/^AR\d{3}-\d{6}$/.test(code))))fail('POINT_WORKER_DELIVERY_CODES_REFUSED');
 return {...c,deliveryCodes:deliveryCodes===null?null:deliveryCodes.slice().sort(),projectionPolicy:{allowNativeHomeBranch:p.allowNativeHomeBranch??false,openingSourceByCode:{...selection}},sources:c.sources.map(s=>({...s})),targets:c.targets.map(t=>({...t}))};
}
async function readOwnerMap(db){
 // Trusted-owner private view exposes only approved native-code ownership. The
 // worker has no direct rights over external member/profile tables or policies.
 const rows=(await db.query(`SELECT member_id::text,ada_code,canonical_code
  FROM ada_points.approved_owner_links ORDER BY ada_code`)).rows;
 if(rows.length>20000)fail('POINT_WORKER_OWNER_MAP_LIMIT');return rows;
}
async function readValues(db){return (await db.query('SELECT ada_code,balance::text,state,version,generation::text,details FROM ada_points.balance_values ORDER BY ada_code')).rows;}
async function lockCycle(db){
 const pooled=typeof db.connect==='function'&&!db.connectionParameters&&typeof db.release!=='function';
 const c=pooled?await db.connect():db;let held=false;
 try{held=(await c.query("SELECT pg_try_advisory_lock(hashtextextended('SCCRM_ADA_POINT_WORKER_CYCLE_V1',0)) AS held")).rows[0]?.held===true;
  if(!held){if(pooled)c.release();return null;}
  return async()=>{try{await c.query("SELECT pg_advisory_unlock(hashtextextended('SCCRM_ADA_POINT_WORKER_CYCLE_V1',0))");}finally{if(pooled)c.release();}};
 }catch(e){if(pooled)c.release();throw e;}
}
async function boundedMap(values,limit,fn){
 const results=new Array(values.length);let cursor=0;
 await Promise.all(Array.from({length:Math.min(limit,values.length)},async()=>{while(cursor<values.length){const i=cursor++;try{results[i]={ok:true,value:await fn(values[i])};}catch(error){results[i]={ok:false,error};}}}));return results;
}
function buildCandidates(snapshots,intrinsic,values,config){
 const byCode=new Map(values.map(v=>[v.ada_code,v])),intrinsicByBranch=new Map(intrinsic.map(s=>[s.branch,new Map(s.balances.map(b=>[b.FTCstCode,b]))]));
 const rawByBranch=new Map(snapshots.map(s=>[s.branch,{customers:new Set(s.customers.map(c=>c.FTCstCode)),balances:new Map(s.balances.map(b=>[b.FTCstCode,b]))}]));
 const candidates=[],scopes=[],ready=[...byCode].filter(([,v])=>v.state==='ready');
 for(const target of config.targets){const raw=rawByBranch.get(target.branchCode),clean=intrinsicByBranch.get(target.branchCode);
  const missingNativeMembers=ready.filter(([code])=>!raw.customers.has(code)).length;
  scopes.push({targetId:target.targetId,branchCode:target.branchCode,enabled:target.enabled,existingNativeMembers:ready.length-missingNativeMembers,missingNativeMembers});
  if(!target.enabled)continue;
  for(const [code,v]of ready){if(!raw.customers.has(code)||config.deliveryCodes!==null&&!config.deliveryCodes.includes(code))continue;
   const rawBalance=raw.balances.get(code),intrinsicBalance=clean.get(code);if(!rawBalance||!intrinsicBalance)fail('POINT_WORKER_NATIVE_BALANCE_MISSING');
   candidates.push({targetId:target.targetId,adaCode:code,generation:v.generation,projectionVersion:v.version,targetBalance:delivery.integer(v.balance),expectedIntrinsic:delivery.integer(intrinsicBalance.FNPntPoint),rawViewBalance:delivery.integer(rawBalance.FNPntPoint),nativeExists:true});
  }
 }return {candidates,scopes};
}
function heldValues(values){return values.filter(v=>v.state!=='ready').map(v=>({adaCode:v.ada_code,reasons:[...new Set([...(Array.isArray(v.details?.reasons)?v.details.reasons:[]),...(Array.isArray(v.details?.storeReviewReasons)?v.details.storeReviewReasons:[])])].filter(x=>typeof x==='string'&&/^[A-Z][A-Z0-9_]{1,100}$/.test(x))}));}
function createWorker({db,config,adminReader,targets=[],dependencies={},onStatus}={}){
 config=normalizeConfig(config);
 if(!db||typeof db.query!=='function'||typeof adminReader!=='function')fail('POINT_WORKER_INJECTED_DEPENDENCIES_REQUIRED');
 const adapterById=new Map(targets.map(t=>[t.targetId,t]));
 if(adapterById.size!==targets.length||config.targets.some(t=>t.enabled&&(!adapterById.has(t.targetId)||adapterById.get(t.targetId).databaseIdentity!==t.databaseIdentity||typeof adapterById.get(t.targetId).apply!=='function')))fail('POINT_WORKER_TARGET_ADAPTER_REQUIRED');
 const runtimeDirectory=config.runtimeDirectory?path.resolve(config.runtimeDirectory):source.RUNTIME;
 let prepared=false;
 async function writeStatus(value){
  if(!prepared){source.privateRuntime(runtimeDirectory);prepared=true;}
  const temp=path.join(runtimeDirectory,`status.${process.pid}.${require('node:crypto').randomUUID()}.tmp`);
  fs.writeFileSync(temp,JSON.stringify(value,null,2),{mode:0o600});fs.renameSync(temp,path.join(runtimeDirectory,'status.json'));
 }
 const deps={readSnapshot:source.readSnapshot,deriveIntrinsicSnapshots,deriveIntrinsicSnapshot,projectNativePoints,store,delivery,readOwnerMap,readValues,lockCycle,now:()=>new Date(),monotonicMs:()=>Number(process.hrtime.bigint()/1000000n),control:()=>({}),writeStatus,...dependencies};
 let active=false,stopping=false,startPromise=null,wake=null,registeredScope=null,allReleased=false,cycleStarted=null,lastStatus={state:'starting',lastObservedAt:null};
 function effectiveConfig(){
  allReleased=false;const releaseFile=path.join(runtimeDirectory,'release-all.request');
  if(!fs.existsSync(releaseFile))return config;
  let value;try{if(!fs.statSync(releaseFile).isFile()||fs.statSync(releaseFile).size>2048)fail('POINT_WORKER_RELEASE_CONTROL_INVALID');value=JSON.parse(fs.readFileSync(releaseFile,'utf8'));}catch{fail('POINT_WORKER_RELEASE_CONTROL_INVALID');}
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='branches,marker,scope'||value.scope!=='SCCRM-ADA-POINTS-RELEASE-V1'||value.marker!=='b16a210f-0567-4a45-8c35-73b6984f8253'||!Array.isArray(value.branches)||value.branches.length!==5||value.branches.slice().sort().join(',')!==BRANCHES.join(','))fail('POINT_WORKER_RELEASE_CONTROL_INVALID');
  if(config.targets.some(t=>!adapterById.has(t.targetId)||adapterById.get(t.targetId).databaseIdentity!==t.databaseIdentity||typeof adapterById.get(t.targetId).apply!=='function'))fail('POINT_WORKER_RELEASE_ADAPTER_MISSING');
  allReleased=true;return {...config,deliveryCodes:null,targets:config.targets.map(t=>({...t,enabled:true}))};
 }
 function controls(){const extra=deps.control();return {pause:fs.existsSync(path.join(runtimeDirectory,'pause.request'))||extra.pause===true,stop:stopping||fs.existsSync(path.join(runtimeDirectory,'stop.request'))||extra.stop===true};}
 async function publish(value){lastStatus={...value,at:deps.now().toISOString(),pollMs:config.pollMs,allReleased,pilotCodes:allReleased?null:config.deliveryCodes,cycleElapsedMs:cycleStarted===null?(lastStatus.cycleElapsedMs??0):Math.max(0,Math.round(deps.monotonicMs()-cycleStarted)),pinRead:false};
  await deps.writeStatus(lastStatus);if(onStatus)await onStatus(JSON.parse(JSON.stringify(lastStatus)));return lastStatus;
 }
 async function unavailable(code,extra={}){let markCode;try{await deps.store.markUnavailable(db);}catch(e){markCode=safe(e);}return publish({state:'unavailable',code,lastObservedAt:lastStatus.lastObservedAt,...extra,...(markCode?{cacheStatusCode:markCode}:{})});}
 async function runCycle(){
  if(active)return {state:'busy',lastObservedAt:lastStatus.lastObservedAt};active=true;cycleStarted=deps.monotonicMs();let release;
  try{
   const control=controls();if(control.stop)return await publish({state:'stopped',lastObservedAt:lastStatus.lastObservedAt});
   if(control.pause){await deps.store.markUnavailable(db);return await publish({state:'paused',lastObservedAt:lastStatus.lastObservedAt});}
   const cycleConfig=effectiveConfig();
   release=await deps.lockCycle(db);if(!release)return {state:'busy',lastObservedAt:lastStatus.lastObservedAt};
   const captured=await boundedMap(BRANCHES,config.sourceConcurrency,branch=>deps.readSnapshot(branch,{mode:'Live',adminReader}));
   const errors=captured.flatMap((r,i)=>r.ok?[]:[{branchCode:BRANCHES[i],code:safe(r.error)}]);
   if(errors.length)return await unavailable('POINT_WORKER_SOURCE_UNAVAILABLE',{sources:errors});
   const snapshots=captured.map(r=>r.value),now=deps.now().getTime();
   for(const s of snapshots){const expected=config.sources.find(r=>r.branchCode===s?.branch),observed=Date.parse(s?.captureCompletedAt);
    if(!expected||s.mode!=='Live'||model.databaseId(s)!==expected.databaseIdentity||s.databaseIdentity!==undefined&&s.databaseIdentity!==expected.databaseIdentity||s.sourceConsistency?.stable!==true||s.sourceConsistency?.firstHash!==s.sourceConsistency?.secondHash)fail('POINT_WORKER_SOURCE_IDENTITY_OR_STABILITY_REFUSED');
    if(!Number.isFinite(observed)||observed<now-config.maxAgeMs||observed>now+5000)fail('POINT_WORKER_SOURCE_AGE_REFUSED');
   }
   const afterRead=controls();if(afterRead.stop)return await publish({state:'stopped',lastObservedAt:lastStatus.lastObservedAt});
   if(afterRead.pause){await deps.store.markUnavailable(db);return await publish({state:'paused',lastObservedAt:lastStatus.lastObservedAt});}
   const ownerMap=await deps.readOwnerMap(db),policy={...config.projectionPolicy,ownerMap};
   // Global proof validation strips proven corrections/replicas for projection.
   // The receiver itself can subtract only its LOCAL owned receipts. A foreign
   // owned replica remains in its expectation and is compensated, not echoed.
   deps.deriveIntrinsicSnapshots(snapshots);
   const intrinsic=snapshots.map(s=>deps.deriveIntrinsicSnapshot(s)),projection=deps.projectNativePoints(snapshots,policy);
   const persisted=await deps.store.applySnapshots(db,snapshots,projection,policy);
   const observedAt=new Date(Math.min(...snapshots.map(s=>Date.parse(s.captureCompletedAt)))).toISOString();lastStatus.lastObservedAt=observedAt;
   const values=await deps.readValues(db),held=heldValues(values);
   const scopeKey=allReleased?'released':'configured';if(registeredScope!==scopeKey){await deps.delivery.registerTargets(db,cycleConfig.targets);registeredScope=scopeKey;}
   const freshness={maxAgeMs:config.maxAgeMs,sources:snapshots.map(s=>({branchCode:s.branch,databaseIdentity:model.databaseId(s),observedAt:s.captureCompletedAt}))};
   const {candidates,scopes}=buildCandidates(snapshots,intrinsic,values,cycleConfig),queued=await deps.delivery.enqueue(db,{freshness,candidates});
   const enabled=cycleConfig.targets.filter(t=>t.enabled),targetResults=scopes.map(s=>({...s,state:s.enabled?'pending':'disabled'}));
   // Separate Pool leases isolate each destination; failure/offline at one does
   // not stall another. A single explicitly supplied Client runs sequentially.
   const parallel=typeof db.connect==='function'&&!db.connectionParameters&&typeof db.release!=='function';
   const drained=await boundedMap(enabled,parallel?config.targetConcurrency:1,async target=>{
    if(controls().stop||controls().pause)return {targetId:target.targetId,state:'paused'};
    const r=await deps.delivery.drainTarget(db,adapterById.get(target.targetId),{freshness,limit:config.drainLimit,leaseMs:config.leaseMs,codes:cycleConfig.deliveryCodes});
    return {targetId:target.targetId,leased:r.leased,succeeded:r.results.filter(x=>x.accepted&&x.state==='succeeded').length,
     retry:r.results.filter(x=>x.accepted&&x.state==='retry').length,review:r.results.filter(x=>x.accepted&&x.state==='review').length,superseded:r.results.filter(x=>x.accepted&&x.state==='superseded').length};
   });
   for(let i=0;i<drained.length;i++){const index=targetResults.findIndex(t=>t.targetId===enabled[i].targetId);targetResults[index]={...targetResults[index],state:'online',...(drained[i].ok?drained[i].value:{state:'unavailable',code:safe(drained[i].error)})};}
   const queueStatus=await deps.delivery.status(db);
   return await publish({state:held.length||targetResults.some(t=>t.state==='unavailable'||t.retry||t.review)||queueStatus.some(q=>q.jobs>0&&['review','retry'].includes(q.state))?'attention':'healthy',lastObservedAt:observedAt,
    sourceCount:snapshots.length,readyMembers:values.length-held.length,heldMembers:held.length,held:held.slice(0,200),heldTruncated:Math.max(0,held.length-200),
    persisted:{balanceChanges:persisted.balanceChanges,eventChanges:persisted.eventChanges,sourcePayloadChanges:persisted.sourcePayloadChanges},
    queued:{inserted:queued.inserted,superseded:queued.superseded,refreshed:queued.refreshed,aligned:queued.aligned},targets:targetResults,queue:queueStatus});
  }catch(error){return await unavailable(safe(error));}
  finally{try{if(release)await release();}finally{active=false;cycleStarted=null;}}
 }
 async function start(){if(startPromise)return startPromise;
  startPromise=(async()=>{while(!stopping){const result=await runCycle();if(result.state==='stopped'||controls().stop)break;
   await new Promise(resolve=>{const timer=setTimeout(()=>{wake=null;resolve();},config.pollMs);wake=()=>{clearTimeout(timer);wake=null;resolve();};});}
   return publish({state:'stopped',lastObservedAt:lastStatus.lastObservedAt});})();return startPromise;
 }
 function requestStop(){stopping=true;if(wake)wake();}
 return {runCycle,start,requestStop,getStatus:()=>JSON.parse(JSON.stringify(lastStatus)),config};
}
module.exports={createWorker};
