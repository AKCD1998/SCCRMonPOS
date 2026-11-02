'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {createWorker}=require('../points/worker.cjs');
const branches=['000','001','003','004','005'],machines={'000':'SERVER','001':'SC_001','003':'POSSRV','004':'SERVER004','005':'POSSRV'};
const identity=b=>b+'/'+machines[b]+'/AdaAcc',now=new Date(),version='a'.repeat(64),code='WORKER-COPY-A';
let serial=0;
function config(){return {mode:'Live',pollMs:5000,runtimeDirectory:path.resolve(__dirname,'../points/runtime','worker-unit-'+process.pid+'-'+(++serial)),projectionPolicy:{allowNativeHomeBranch:true},sources:branches.map(branchCode=>({branchCode,databaseIdentity:identity(branchCode)})),targets:branches.map(branchCode=>({branchCode,databaseIdentity:identity(branchCode),targetId:'copy-'+branchCode,enabled:true}))};}
function snapshot(branch){return {branch,mode:'Live',identity:{machine:machines[branch],db:'AdaAcc'},databaseIdentity:identity(branch),captureCompletedAt:now.toISOString(),sourceConsistency:{stable:true,firstHash:'a'.repeat(64),secondHash:'a'.repeat(64)},customers:[{FTCstCode:code}],balances:[{FTCstCode:code,FNPntPoint:'10'}],points:[]};}
function fixture(extra={}){
 const calls={read:[],apply:[],queued:[],drain:[],status:[],marked:0,release:0,owner:[]};
 const db={query:async sql=>{calls.owner.push(sql);return {rows:[]};}};
 const dependencies={now:()=>now,writeStatus:async s=>{calls.status.push(JSON.parse(JSON.stringify(s)));},lockCycle:async()=>async()=>{calls.release++;},
  readSnapshot:async(b,options)=>{calls.read.push({b,options});return snapshot(b);},readOwnerMap:async()=>[],
  deriveIntrinsicSnapshots:raw=>raw.map(s=>({...s,balances:s.balances.map(v=>({...v,FNPntPoint:s.branch==='005'?'5':v.FNPntPoint}))})),
  deriveIntrinsicSnapshot:s=>({...s,balances:s.balances.map(v=>({...v,FNPntPoint:s.branch==='005'?'5':v.FNPntPoint}))}),
  projectNativePoints:()=>({ready:1,review:0,balances:[]}),readValues:async()=>[{ada_code:code,balance:'20.00000000000000000',state:'ready',version,generation:'99',details:{}}],
  store:{applySnapshots:async(...a)=>{calls.apply.push(a);return {balanceChanges:1,eventChanges:1,sourcePayloadChanges:5};},markUnavailable:async()=>{calls.marked++;}},
  delivery:{registerTargets:async()=>{},enqueue:async(_db,v)=>{calls.queued.push(v);return {inserted:5,superseded:0,refreshed:0,aligned:0};},drainTarget:async(_db,t)=>{calls.drain.push(t.targetId);return {leased:1,results:[{accepted:true,state:'succeeded'}]};},status:async()=>[]},...extra.dependencies};
 const targets=branches.map(b=>({targetId:'copy-'+b,databaseIdentity:identity(b),apply:async()=>{}}));
 const worker=createWorker({db,config:config(),adminReader:()=>({password:'private-not-read-by-mock'}),targets,dependencies,...extra,dependencies});return {worker,calls,dependencies,db,targets};
}
test('worker sends raw sources to the native projection/store and only verified intrinsic balances to the queue',async()=>{
 const {worker,calls}=fixture();const r=await worker.runCycle();assert.equal(r.state,'healthy');assert.equal(calls.read.length,5);assert.ok(calls.read.every(x=>x.options.mode==='Live'&&typeof x.options.adminReader==='function'));
 assert.equal(calls.apply.length,1);assert.equal(calls.apply[0][1].find(s=>s.branch==='005').balances[0].FNPntPoint,'10');
 const queued=calls.queued[0];assert.equal(queued.candidates.length,5);const fifth=queued.candidates.find(x=>x.targetId==='copy-005');assert.equal(fifth.expectedIntrinsic,'5');assert.equal(fifth.rawViewBalance,'10');assert.equal(fifth.targetBalance,'20');assert.equal(fifth.generation,'99');assert.equal(queued.freshness.sources.length,5);assert.equal(calls.release,1);
 assert.equal(JSON.stringify(calls.status).includes('private-not-read-by-mock'),false);
});
test('source reads are limited to two and an overlapping cycle performs no work',async()=>{
 let resolve,active=0,max=0;const gate=new Promise(r=>{resolve=r;});
 const {worker,calls}=fixture({dependencies:{readSnapshot:async b=>{active++;max=Math.max(max,active);await gate;active--;return snapshot(b);}}});
 const pending=worker.runCycle();await new Promise(r=>setImmediate(r));assert.equal((await worker.runCycle()).state,'busy');resolve();await pending;
 assert.equal(max,2);assert.equal(calls.apply.length,1);
});
test('globally proven foreign correction replicas remain in the local receiver expectation',async()=>{
 const {worker,calls}=fixture({dependencies:{deriveIntrinsicSnapshots:raw=>raw.map(s=>({...s,balances:s.balances.map(v=>({...v,FNPntPoint:'10'}))})),deriveIntrinsicSnapshot:s=>({...s,balances:s.balances.map(v=>({...v,FNPntPoint:s.branch==='003'?'17':'10'}))}),readValues:async()=>[{ada_code:code,balance:'10',state:'ready',version,generation:'99',details:{}}]}});
 await worker.runCycle();const third=calls.queued[0].candidates.find(c=>c.targetId==='copy-003');assert.equal(third.expectedIntrinsic,'17');assert.equal(third.targetBalance,'10');
});
test('one failed source hides the cache and prevents enqueue/drain without leaking raw exception text',async()=>{
 const {worker,calls}=fixture({dependencies:{readSnapshot:async b=>{if(b==='004')throw Object.assign(Error('password=must-not-appear'),{code:'ECONNRESET'});return snapshot(b);}}});
 const r=await worker.runCycle();assert.equal(r.state,'unavailable');assert.equal(calls.marked,1);assert.equal(calls.apply.length,0);assert.equal(calls.queued.length,0);assert.equal(calls.drain.length,0);assert.equal(r.sources[0].code,'ECONNRESET');assert.equal(JSON.stringify(r).includes('must-not-appear'),false);
});
test('unstable, wrong-identity or aged source observations cannot advance projections',async()=>{
 for(const mutate of [s=>{s.sourceConsistency.stable=false;},s=>{s.identity.machine='UNREVIEWED';},s=>{s.captureCompletedAt=new Date(now.getTime()-180000).toISOString();}]){
  const {worker,calls}=fixture({dependencies:{readSnapshot:async b=>{const s=snapshot(b);if(b==='003')mutate(s);return s;}}});assert.equal((await worker.runCycle()).state,'unavailable');assert.equal(calls.apply.length,0);assert.equal(calls.queued.length,0);
 }
});
test('pause/stop controls require no screen or source reads and preserve the last observed timestamp',async()=>{
 let control={};const {worker,calls}=fixture({dependencies:{control:()=>control}});const first=await worker.runCycle();
 control={pause:true};const paused=await worker.runCycle();assert.equal(paused.state,'paused');assert.equal(paused.lastObservedAt,first.lastObservedAt);assert.equal(calls.read.length,5);assert.equal(calls.marked,1);
 control={stop:true};assert.equal((await worker.runCycle()).state,'stopped');assert.equal(calls.read.length,5);
});
test('all five target failures are isolated and sanitized; approved per-member holds remain visible',async()=>{
 const {worker,calls}=fixture({dependencies:{readValues:async()=>[{ada_code:code,balance:null,state:'review',version,generation:'100',details:{reasons:['SOURCE_CONFLICT','unsafe secret text']}}],delivery:{registerTargets:async()=>{},enqueue:async(_db,v)=>{calls.queued.push(v);return {inserted:0,superseded:0,refreshed:0,aligned:0};},drainTarget:async(_db,t)=>{if(t.targetId==='copy-004')throw Error('private-connection-secret');return {leased:0,results:[]};},status:async()=>[]}}});
 const r=await worker.runCycle();assert.equal(r.state,'attention');assert.equal(r.heldMembers,1);assert.deepEqual(r.held,[{adaCode:code,reasons:['SOURCE_CONFLICT']}]);assert.equal(r.targets.length,5);assert.equal(r.targets.find(t=>t.targetId==='copy-004').code,'POINT_WORKER_OPERATION_FAILED');assert.equal(calls.queued[0].candidates.length,0);assert.equal(JSON.stringify(r).includes('private-connection-secret'),false);
});
test('default ownership query reads only the private approved ownership view',async()=>{
 const f=fixture();delete f.dependencies.readOwnerMap;
 const worker=createWorker({db:f.db,config:config(),adminReader:()=>({}),targets:f.targets,dependencies:f.dependencies});await worker.runCycle();
 assert.equal(f.calls.owner.length,1);const sql=f.calls.owner[0];assert.match(sql,/SELECT member_id::text,ada_code,canonical_code/);assert.match(sql,/FROM ada_points\.approved_owner_links ORDER BY ada_code/);assert.doesNotMatch(sql,/ada_history|public\.|is_active/);
});
test('unreviewed configuration, implicit admin reads and missing target adapters fail before runtime work',()=>{
 const f=fixture();assert.throws(()=>createWorker({db:f.db,config:{...config(),pollMs:4999},adminReader:()=>({}),targets:f.targets}),/BOUNDS_INVALID/);
 assert.throws(()=>createWorker({db:f.db,config:{...config(),targetConcurrency:3},adminReader:()=>({}),targets:f.targets}),/BOUNDS_INVALID/);
 assert.throws(()=>createWorker({db:f.db,config:config(),targets:f.targets}),/INJECTED_DEPENDENCIES_REQUIRED/);
 assert.throws(()=>createWorker({db:f.db,config:{...config(),sources:config().sources.slice(1)},adminReader:()=>({}),targets:f.targets}),/FIVE_DATABASES_REQUIRED/);
 assert.throws(()=>createWorker({db:f.db,config:config(),adminReader:()=>({}),targets:[]}),/TARGET_ADAPTER_REQUIRED/);
 assert.throws(()=>createWorker({db:f.db,config:{...config(),projectionPolicy:{ownerMap:[]}},adminReader:()=>({}),targets:f.targets}),/OWNER_MAP_MUST_BE_DATABASE_APPROVAL/);
 for(const deliveryCodes of [[],['NOT-AR'],['AR005-000031','AR005-000031'],Array.from({length:21},(_,i)=>'AR005-'+String(i).padStart(6,'0'))])assert.throws(()=>createWorker({db:f.db,config:{...config(),deliveryCodes},adminReader:()=>({}),targets:f.targets}),/DELIVERY_CODES_REFUSED/);
});
test('a reviewed pilot code filters new deliveries without filtering cached members or missing-native counts',async()=>{
 const pilot='AR005-000031',other='AR001-000001',missing='AR003-000001',c={...config(),deliveryCodes:[pilot]};
 const f=fixture({config:c,dependencies:{readSnapshot:async b=>({...snapshot(b),customers:[{FTCstCode:pilot},{FTCstCode:other}],balances:[{FTCstCode:pilot,FNPntPoint:'10'},{FTCstCode:other,FNPntPoint:'10'}]}),readValues:async()=>[pilot,other,missing].map(ada_code=>({ada_code,balance:'20',state:'ready',version,generation:'99',details:{}}))}});
 const result=await f.worker.runCycle();assert.equal(result.readyMembers,3);assert.deepEqual(result.pilotCodes,[pilot]);assert.equal(f.calls.queued[0].candidates.length,5);assert.ok(f.calls.queued[0].candidates.every(c=>c.adaCode===pilot));assert.ok(result.targets.every(t=>t.existingNativeMembers===2&&t.missingNativeMembers===1));
});
test('Pool delivery uses at most two destination slots, reports missing native customers, and measures cycle duration',async()=>{
 let active=0,max=0,clock=100;
 const poolLike={query:async()=>({rows:[]}),connect:async()=>{throw Error('mock must not open connections');}};
 const {worker}=fixture({db:poolLike,dependencies:{monotonicMs:()=>{clock+=25;return clock;},readValues:async()=>[code,'WORKER-COPY-ABSENT'].map(ada_code=>({ada_code,balance:'20',state:'ready',version,generation:'99',details:{}})),
  delivery:{registerTargets:async()=>{},enqueue:async()=>({inserted:5,superseded:0,refreshed:0,aligned:0}),status:async()=>[],drainTarget:async()=>{active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,5));active--;return {leased:1,results:[{accepted:true,state:'succeeded'}]};}}}});
 const result=await worker.runCycle();assert.equal(max,2);assert.equal(result.targets.length,5);assert.ok(result.targets.every(t=>t.missingNativeMembers===1&&t.existingNativeMembers===1));assert.ok(result.cycleElapsedMs>=25);
});
test('a strict private release control enables all targets without a restart and persists across worker restart',async()=>{
 const pilot='AR005-000031',c={...config(),deliveryCodes:[pilot]};c.targets=c.targets.map(t=>({...t,enabled:t.branchCode==='005'}));
 const registrations=[],leaseScopes=[],f=fixture({config:c,dependencies:{delivery:{registerTargets:async(_db,targets)=>{registrations.push(targets.map(t=>({...t})));},enqueue:async(_db,v)=>{f.calls.queued.push(v);return {inserted:0,superseded:0,refreshed:0,aligned:0};},drainTarget:async(_db,t,options)=>{leaseScopes.push({targetId:t.targetId,codes:options.codes});return {leased:0,results:[]};},status:async()=>[]}}});
 const absent=await f.worker.runCycle();assert.equal(absent.allReleased,false);assert.deepEqual(absent.pilotCodes,[pilot]);assert.equal(leaseScopes.length,1);assert.deepEqual(leaseScopes[0].codes,[pilot]);assert.equal(f.calls.queued[0].candidates.length,0);
 fs.mkdirSync(c.runtimeDirectory,{recursive:true});fs.writeFileSync(path.join(c.runtimeDirectory,'release-all.request'),JSON.stringify({scope:'SCCRM-ADA-POINTS-RELEASE-V1',marker:'b16a210f-0567-4a45-8c35-73b6984f8253',branches}));
 const released=await f.worker.runCycle();assert.equal(released.allReleased,true);assert.equal(released.pilotCodes,null);assert.ok(released.targets.every(t=>t.enabled));assert.equal(f.calls.queued[1].candidates.length,5);assert.equal(registrations.length,2);assert.ok(registrations[1].every(t=>t.enabled));assert.ok(leaseScopes.slice(1).every(t=>t.codes===null));
 await f.worker.runCycle();assert.equal(registrations.length,2);
 const restarted=createWorker({db:f.db,config:c,adminReader:()=>({}),targets:f.targets,dependencies:f.dependencies});const afterRestart=await restarted.runCycle();assert.equal(afterRestart.allReleased,true);assert.equal(afterRestart.pilotCodes,null);assert.ok(registrations.at(-1).every(t=>t.enabled));
});
test('malformed release controls and missing release adapters fail closed before source reads or native writes',async()=>{
 const valid={scope:'SCCRM-ADA-POINTS-RELEASE-V1',marker:'b16a210f-0567-4a45-8c35-73b6984f8253',branches};
 for(const value of [{...valid,marker:'wrong'},{...valid,branches:branches.slice(1)},{...valid,extra:true},'not-json']){
  const c=config(),f=fixture({config:c});fs.mkdirSync(c.runtimeDirectory,{recursive:true});fs.writeFileSync(path.join(c.runtimeDirectory,'release-all.request'),typeof value==='string'?value:JSON.stringify(value));
  const result=await f.worker.runCycle();assert.equal(result.state,'unavailable');assert.equal(result.code,'POINT_WORKER_RELEASE_CONTROL_INVALID');assert.equal(result.allReleased,false);assert.equal(f.calls.read.length,0);assert.equal(f.calls.drain.length,0);
 }
 const c=config();c.targets=c.targets.map(t=>({...t,enabled:t.branchCode==='005'}));const f=fixture({config:c,targets:[{targetId:'copy-005',databaseIdentity:identity('005'),apply:async()=>{}}]});fs.mkdirSync(c.runtimeDirectory,{recursive:true});fs.writeFileSync(path.join(c.runtimeDirectory,'release-all.request'),JSON.stringify(valid));const result=await f.worker.runCycle();assert.equal(result.code,'POINT_WORKER_RELEASE_ADAPTER_MISSING');assert.equal(f.calls.read.length,0);
});
test('a competing process lock prevents all source reads and does not mark a working cache unavailable',async()=>{
 const {worker,calls}=fixture({dependencies:{lockCycle:async()=>null}});assert.equal((await worker.runCycle()).state,'busy');assert.equal(calls.read.length,0);assert.equal(calls.marked,0);
});
test('requestStop interrupts the poll wait and the loop does not create another cycle',async()=>{
 const {worker,calls}=fixture();const running=worker.start();while(!calls.status.length)await new Promise(r=>setImmediate(r));worker.requestStop();await running;
 assert.equal(worker.getStatus().state,'stopped');assert.equal(calls.read.length,5);
});
test('default status persistence atomically leaves one sanitized JSON status without temporary files',async()=>{
 const f=fixture(),c=config();delete f.dependencies.writeStatus;
 const worker=createWorker({db:f.db,config:c,adminReader:()=>({}),targets:f.targets,dependencies:f.dependencies});await worker.runCycle();
 const files=fs.readdirSync(c.runtimeDirectory);assert.deepEqual(files,['status.json']);const status=JSON.parse(fs.readFileSync(path.join(c.runtimeDirectory,'status.json'),'utf8'));
 assert.equal(status.state,'healthy');assert.equal(status.lastObservedAt,now.toISOString());assert.equal(status.pinRead,false);assert.equal(JSON.stringify(status).includes('password'),false);
});
