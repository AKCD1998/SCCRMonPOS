'use strict';
// Real private PG source/projection/outbox integration, injected native copy
// adapter only. No SQL Server/Supabase connections or production credentials.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const test=require('node:test'),assert=require('node:assert/strict'),{Client,Pool}=require('pg');
const {createWorker}=require('../points/worker.cjs'),source=require('../points/export.cjs'),model=require('../points/model.cjs'),compensation=require('../points/compensation.cjs');
const RUN=process.env.SCCRM_POINTS_COPY_TEST==='1',BASE='postgresql://postgres@127.0.0.1:55502/postgres';
const MACHINES={'000':'SERVER','001':'SC_001','003':'POSSRV','004':'SERVER004','005':'POSSRV'},A='WORKER-COPY-A',B='WORKER-COPY-B',MEMBER='00000000-0000-4000-8000-000000000099';
const sha=x=>crypto.createHash('sha256').update(String(x)).digest('hex');
const clone=x=>JSON.parse(JSON.stringify(x)),identity=b=>b+'/'+MACHINES[b]+'/AdaAcc';
const localDate='2026-11-02T00:00:00.000';
function point(code,doc,points,branch='001',previous='10',who='PRIVATE_COPY_NATIVE_FIXTURE'){
 return Object.assign(Object.fromEntries(model.POINT_FIELDS.map(k=>[k,null])),{FTBchCode:branch,FTCstCode:code,FTPntRefDoc:doc,FTSplCode:'',FDPntDate:localDate,FCPntPointbyOne:'0',FCPntAmtRcv:'0',FNPntPoint:points,FNPntPointOld:previous,FTPntExpired:'N',FTPntStaPrcDoc:'N',FTPntCardType:'1',FTCptJDate:'',FTCptTime:'09:00:00',FTPntStaExpired:'N',FDDateIns:localDate,FTTimeIns:'09:00:00',FTWhoIns:who});
}
function fixture(schema){return source.BRANCHES.map(branch=>{
 const customers=[{FTCstCode:A,FCCstRetPoint:'10',FCCstRetAmt:'0',FCCstWhsPoint:'0',FCCstDailyPoint:'0',FTBchCode:'001',FDCstLastPoint:null,FDDateUpd:null,FTTimeUpd:null}];
 if(branch==='000')customers.push({...customers[0],FTCstCode:B,FCCstRetPoint:'12'});
 return {scope:source.SCOPE,mode:'Live',branch,identity:{machine:MACHINES[branch],db:'AdaAcc'},databaseIdentity:identity(branch),schema:clone(schema),schemaHash:source.validateSchema(schema),customers,
  points:branch==='001'?[point(A,'PRIVATE-COPY-NATIVE-7','7')]:[],balances:customers.map(c=>({FTCstCode:c.FTCstCode,FNPntPoint:c.FTCstCode===A&&branch==='001'?'17':c.FCCstRetPoint,FCPntAmtRcv:'0'})),productionWrites:0,pinRead:false};
 });}
function refresh(s){s.captureStartedAt=new Date(Date.now()-1).toISOString();s.captureCompletedAt=new Date().toISOString();const hash=sha(JSON.stringify({customers:s.customers,points:s.points,balances:s.balances,owned:s.ownedCompensation}));s.sourceConsistency={stable:true,firstHash:hash,secondHash:hash,method:'PRIVATE-PG-WORKER-COPY-FIXTURE'};s.payloadHash=source.sha(source.payloadContent(s));return s;}
test('native-primary worker preserves projection generations across correction readback and service restart',{skip:!RUN,timeout:120000},async t=>{
 const control=new Client({connectionString:BASE,connectionTimeoutMillis:3000});let db,database;const checks=[];await control.connect();
 try{
  const host=(await control.query('SELECT host(inet_server_addr()) host,inet_server_port() port')).rows[0];assert.deepEqual(host,{host:'127.0.0.1',port:55502});
  database='sccrm_points_delivery_copy_worker_'+crypto.randomBytes(5).toString('hex');await control.query(`CREATE DATABASE "${database}"`);const url=new URL(BASE);url.pathname='/'+database;db=new Pool({connectionString:url.href,max:4});
  await db.query(fs.readFileSync(path.join(source.ROOT,'schema.sql'),'utf8'));await db.query(fs.readFileSync(path.join(source.ROOT,'delivery-schema.sql'),'utf8'));
  await db.query('CREATE SCHEMA ada_history;CREATE TABLE ada_history.member_links(member_id uuid NOT NULL,source_id text NOT NULL,ada_code varchar(20) NOT NULL,approval_reference text NOT NULL,PRIMARY KEY(source_id,ada_code));CREATE TABLE public.member_profiles(user_id uuid PRIMARY KEY,member_code varchar(50) NOT NULL,is_active boolean NOT NULL);CREATE TABLE public.point_ledger(id integer PRIMARY KEY,amount integer NOT NULL,note text NOT NULL)');
  await db.query("INSERT INTO ada_history.member_links VALUES($1,'hq000/AdaAcc',$2,'explicit private-copy approval')",[MEMBER,A]);
  await db.query('INSERT INTO public.member_profiles VALUES($1,$2,false)',[MEMBER,A]);
  await db.query(`CREATE VIEW ada_points.approved_owner_links WITH(security_barrier=true,security_invoker=false) AS
   SELECT l.member_id::text,l.ada_code,m.member_code AS canonical_code
   FROM ada_history.member_links l JOIN public.member_profiles m ON m.user_id=l.member_id
   WHERE l.source_id='hq000/AdaAcc' AND btrim(l.approval_reference)<>''`);
  await db.query("INSERT INTO public.point_ledger VALUES(1,807,'old SCCRM points must remain excluded and unchanged')");
  const schema=JSON.parse(fs.readFileSync(path.join(source.RUNTIME,'native-live-000.json'),'utf8')).schema,snapshots=fixture(schema),mastersHash=sha(JSON.stringify(snapshots.map(s=>s.customers)));
  const corrections=[],receipts=new Map(),statuses=[];let unavailable=null,barrier=null,reads=0;
  const adapterFor=branch=>({targetId:'copy-'+branch,databaseIdentity:identity(branch),async apply(job){
   const old=receipts.get(job.operation_id);if(old)return {...old,outcome:'replayed'};
   const raw=snapshots.find(s=>s.branch===branch),intrinsic=compensation.deriveIntrinsicSnapshot(raw).balances.find(b=>b.FTCstCode===job.ada_code).FNPntPoint;
   assert.equal(intrinsic,job.expected_intrinsic);const before=raw.balances.find(b=>b.FTCstCode===job.ada_code).FNPntPoint,delta=BigInt(job.target_balance)-BigInt(before);assert.notEqual(delta,0n);
   const ref='SP'+job.operation_id.replaceAll('-','').slice(0,28),row=point(job.ada_code,ref,(delta<0n?-delta:delta).toString(),branch,before,compensation.WHO);row.FTPntCardType=delta<0n?'2':'1';raw.points.push(row);raw.balances.find(b=>b.FTCstCode===job.ada_code).FNPntPoint=job.target_balance;
   raw.ownedCompensation??={present:true,meta:[{singleton:1,marker:compensation.MARKER,target_identity:identity(branch),branch_code:branch}],receipts:[]};
   raw.ownedCompensation.receipts.push({operation_id:job.operation_id,ada_code:job.ada_code,branch_code:branch,ref_doc:ref,revision:job.projection_version,generation:job.generation,expected_intrinsic:job.expected_intrinsic,previous_balance:before,target_balance:job.target_balance,delta_points:delta.toString(),created_at:localDate});
   corrections.push({operation_id:job.operation_id,delta:delta.toString()});const result={operation_id:job.operation_id,ada_code:job.ada_code,generation:job.generation,target_balance:job.target_balance,projection_version:job.projection_version,database_identity:job.database_identity,outcome:'applied'};receipts.set(job.operation_id,result);return result;
  }});
  const adapter=adapterFor('005');
  const config={mode:'Live',pollMs:5000,runtimeDirectory:path.join(source.RUNTIME,'worker-integration-'+database),projectionPolicy:{allowNativeHomeBranch:true},sources:source.BRANCHES.map(branchCode=>({branchCode,databaseIdentity:identity(branchCode)})),targets:source.BRANCHES.map(branchCode=>({branchCode,databaseIdentity:identity(branchCode),targetId:'copy-'+branchCode,enabled:branchCode==='005'}))};
  const options={db,config,adminReader:()=>({password:'not-used-by-injected-reader'}),targets:[adapter],dependencies:{readSnapshot:async branch=>{reads++;if(barrier)await barrier;if(branch===unavailable)throw Object.assign(Error('source unavailable'),{code:'POINT_EXPORT_TIMEOUT'});return clone(refresh(snapshots.find(s=>s.branch===branch)));},writeStatus:async s=>{statuses.push(clone(s));}}};
  let worker=createWorker(options);
  const value=async code=>(await db.query('SELECT ada_code,balance::text,state,generation::text,version FROM ada_points.balance_values WHERE ada_code=$1',[code])).rows[0];
  await t.test('the first cycle reads all five copies, delivers only to an enabled existing native member and preserves inactive ownership',async()=>{
   const result=await worker.runCycle();assert.equal(result.state,'healthy');assert.equal(result.sourceCount,5);assert.equal(result.queued.inserted,1);assert.equal(result.targets.find(t=>t.targetId==='copy-005').missingNativeMembers,1);assert.ok(result.cycleElapsedMs>=0);assert.equal(corrections.length,1);assert.equal(corrections[0].delta,'7');assert.equal((await value(A)).balance,'17.00000000000000000');assert.equal((await value(B)).balance,'12.00000000000000000');
   assert.equal((await db.query('SELECT details->>\'approvedMemberId\' owner FROM ada_points.balance_values WHERE ada_code=$1',[A])).rows[0].owner,MEMBER);assert.equal((await db.query('SELECT ada_code FROM ada_points.delivery_jobs')).rows.some(r=>r.ada_code===B),false);checks.push('five_source_native_existing_enabled_only');
  });
  let originalGeneration;
  await t.test('owned correction readback changes no projection generation and never awards again',async()=>{
   const before=await value(A);originalGeneration=before.generation;const result=await worker.runCycle(),after=await value(A);
   assert.equal(result.state,'healthy');assert.equal(result.queued.inserted,0);assert.equal(result.queued.aligned,1);assert.equal(result.persisted.balanceChanges,0);assert.equal(after.generation,before.generation);assert.equal(after.version,before.version);assert.equal(corrections.length,1);checks.push('correction_readback_no_loop');
  });
  await t.test('a restarted worker resumes durable state without creating a second operation',async()=>{
   worker=createWorker(options);const result=await worker.runCycle();assert.equal(result.queued.inserted,0);assert.equal((await value(A)).generation,originalGeneration);assert.equal(corrections.length,1);assert.equal((await db.query('SELECT count(*)::int n FROM ada_points.delivery_jobs')).rows[0].n,1);checks.push('worker_restart_stable_generation');
  });
  await t.test('a genuine new native award advances generation and sends only its remaining delta',async()=>{
   const native=snapshots.find(s=>s.branch==='001');native.points.push(point(A,'PRIVATE-COPY-NATIVE-3','3'));native.balances.find(b=>b.FTCstCode===A).FNPntPoint='20';
   const result=await worker.runCycle();assert.equal(result.queued.inserted,1);assert.ok(BigInt((await value(A)).generation)>BigInt(originalGeneration));assert.deepEqual(corrections.map(c=>c.delta),['7','3']);assert.equal(snapshots.find(s=>s.branch==='005').balances.find(b=>b.FTCstCode===A).FNPntPoint,'20');checks.push('late_native_award_exact_delta');
  });
  await t.test('source outage hides the central cache and performs zero new native writes until a fresh five-source recovery',async()=>{
   unavailable='003';const before=corrections.length,result=await worker.runCycle();assert.equal(result.state,'unavailable');assert.equal(corrections.length,before);assert.equal((await db.query('SELECT state,balance FROM ada_points.balance_cache WHERE ada_code=$1',[A])).rows[0].state,'review');
   unavailable=null;const recovered=await worker.runCycle();assert.equal(recovered.state,'healthy');assert.equal(corrections.length,before);checks.push('source_outage_and_recovery');
  });
  await t.test('a second worker process cannot overlap the session-locked cycle',async()=>{
   let resolve;barrier=new Promise(r=>{resolve=r;});const first=worker.runCycle();while(reads%5===0)await new Promise(r=>setImmediate(r));
   const other=createWorker(options);assert.equal((await other.runCycle()).state,'busy');resolve();barrier=null;await first;checks.push('cross_worker_session_lock');
  });
  await t.test('proven foreign correction replication holds the affected operational balance and sends no counter-correction',async()=>{
   const C='AR003-000099',operation='90000000-0000-5000-8000-000000000099',ref='SP'+operation.replaceAll('-','').slice(0,28),source005=snapshots.find(s=>s.branch==='005'),replica003=snapshots.find(s=>s.branch==='003');
   for(const s of snapshots){s.customers.push({...s.customers.find(c=>c.FTCstCode===A),FTCstCode:C});s.balances.push({FTCstCode:C,FNPntPoint:['003','005'].includes(s.branch)?'17':'10',FCPntAmtRcv:'0'});}
   const foreign=point(C,ref,'7','005','10',compensation.WHO);source005.points.push(foreign);replica003.points.push(clone(foreign));
   source005.ownedCompensation.receipts.push({operation_id:operation,ada_code:C,branch_code:'005',ref_doc:ref,revision:sha('private-foreign-copy-fixture'),generation:'1',expected_intrinsic:'10',previous_balance:'10',target_balance:'17',delta_points:'7',created_at:localDate});
   const pilotConfig={...config,deliveryCodes:[C],targets:config.targets.map(t=>({...t,enabled:t.branchCode==='003'}))},pilot=createWorker({...options,config:pilotConfig,targets:[adapterFor('003')]});
   const count=corrections.length,first=await pilot.runCycle();assert.equal(first.state,'attention');assert.equal(first.queued.inserted,0);assert.equal((await value(C)).balance,null);assert.equal((await value(C)).state,'review');assert.equal(corrections.length,count);
   const pure=require('../points/projection.cjs').projectNativePoints(snapshots,{allowNativeHomeBranch:true});assert.equal(pure.balances.find(v=>v.adaCode===C).balanceExact,'10');
   assert.equal((await db.query('SELECT count(*)::int n FROM ada_points.delivery_jobs WHERE ada_code=$1',[C])).rows[0].n,0);assert.ok(first.held.find(v=>v.adaCode===C).reasons.includes('POINT_FOREIGN_PROJECTION_REPLICATION_REVIEW'));
   const generation=(await value(C)).generation;const replay=await pilot.runCycle();assert.equal(replay.queued.inserted,0);assert.equal(corrections.length,count);assert.equal((await value(C)).generation,generation);assert.equal(replica003.balances.find(v=>v.FTCstCode===C).FNPntPoint,'17');checks.push('foreign_owned_replica_operational_hold_no_counter_loop');
  });
  await t.test('trusted release-all control enables all reviewed destinations and remains effective after restart',async()=>{
   const release={scope:'SCCRM-ADA-POINTS-RELEASE-V1',marker:'b16a210f-0567-4a45-8c35-73b6984f8253',branches:source.BRANCHES};fs.mkdirSync(config.runtimeDirectory,{recursive:true});fs.writeFileSync(path.join(config.runtimeDirectory,'release-all.request'),JSON.stringify(release));
   const allOptions={...options,targets:source.BRANCHES.map(adapterFor)},released=createWorker(allOptions);const result=await released.runCycle();assert.equal(result.allReleased,true);assert.equal(result.pilotCodes,null);assert.ok(result.targets.every(t=>t.enabled));assert.equal((await db.query('SELECT count(*)::int n FROM ada_points.delivery_targets WHERE enabled')).rows[0].n,5);
   const before=corrections.length,restarted=createWorker(allOptions);const after=await restarted.runCycle();assert.equal(after.allReleased,true);assert.equal(after.queued.inserted,0);assert.equal(corrections.length,before);checks.push('trusted_release_control_restart_persistence');
  });
  await t.test('native master fixtures and the old SCCRM ledger are unchanged; status contains no source payload or secret',async()=>{
   assert.equal(sha(JSON.stringify(snapshots.map(s=>s.customers.filter(c=>[A,B].includes(c.FTCstCode))))),mastersHash);assert.deepEqual((await db.query('SELECT amount,note FROM public.point_ledger WHERE id=1')).rows[0],{amount:807,note:'old SCCRM points must remain excluded and unchanged'});
   assert.equal(JSON.stringify(statuses).includes('not-used-by-injected-reader'),false);assert.equal(JSON.stringify(statuses).includes('FTCstCode'),false);assert.ok(statuses.every(s=>s.pinRead===false));checks.push('source_masters_old_ledger_and_status_boundaries');
  });
  assert.equal(checks.length,9);console.log(JSON.stringify({ok:true,scope:'LOCAL-POSTGRES-POINT-WORKER-COPY-ONLY',database,checks:checks.length,corrections:corrections.length,productionWrites:0,sqlServerWrites:0,pinRead:false}));
 }finally{if(db)await db.end().catch(()=>{});await control.end();}
});
