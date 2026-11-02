'use strict';
// Explicit local PostgreSQL copy only. Never connects to SQL Server or Supabase.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const test=require('node:test'),assert=require('node:assert/strict');
const {Client}=require('pg');
const source=require('../points/export.cjs'),model=require('../points/model.cjs');
const store=require('../points/store.cjs'),{projectNativePoints}=require('../points/projection.cjs');
const RUN=process.env.SCCRM_POINTS_COPY_TEST==='1';
const BASE_URL='postgresql://postgres@127.0.0.1:55502/sccrm_points_copy';
const clone=x=>JSON.parse(JSON.stringify(x));
const A='LAB-POINTS-COPY-A',B='LAB-POINTS-COPY-B',POLICY={allowNativeHomeBranch:true};
function nativePoint(doc,points='7',code=A){return Object.assign(Object.fromEntries(model.POINT_FIELDS.map(k=>[k,null])),{FTBchCode:'001',FTCstCode:code,FTPntRefDoc:doc,FTSplCode:'',FDPntDate:'2026-11-02T00:00:00.000',FCPntPointbyOne:'100',FCPntAmtRcv:'700',FNPntPoint:points,FNPntPointOld:'10',FTPntExpired:'N',FTPntStaPrcDoc:'N',FTPntCardType:'1',FTCptJDate:'',FTCptTime:'09:00:00',FTPntStaExpired:'N',FDDateIns:'2026-11-02T00:00:00.000',FTTimeIns:'09:00:00',FTWhoIns:'LOCAL_COPY_FIXTURE'});}
function fixtureSnapshots(original){return original.map(s=>{const v=clone(s);for(const code of[A,B]){
 v.customers.push({FTCstCode:code,FCCstRetPoint:'10',FCCstRetAmt:'0',FCCstWhsPoint:'0',FCCstDailyPoint:'0',FTBchCode:'001',FDCstLastPoint:null,FDDateUpd:null,FTTimeUpd:null});
 v.balances.push({FTCstCode:code,FNPntPoint:'10',FCPntAmtRcv:'0'});
 }return v;});}
function refresh(snapshots,advanceMs=1000){
 for(const s of snapshots){s.captureStartedAt=new Date(Date.parse(s.captureStartedAt)+advanceMs).toISOString();s.captureCompletedAt=new Date(Date.parse(s.captureCompletedAt)+advanceMs).toISOString();
  for(const code of[A,B]){const n=s.points.filter(p=>p.FTCstCode===code&&p.FTPntExpired==='N'&&p.FTPntStaPrcDoc==='N').reduce((n,p)=>n+(p.FTPntCardType==='1'?BigInt(p.FNPntPoint):p.FTPntCardType==='2'?-BigInt(p.FNPntPoint):0n),10n);s.balances.find(b=>b.FTCstCode===code).FNPntPoint=n.toString();}
  s.sourceConsistency={stable:true,firstHash:'a'.repeat(64),secondHash:'a'.repeat(64),method:'synthetic-fixture-in-private-pg-copy'};
  s.payloadHash=source.sha(source.payloadContent(s));
 }return snapshots;
}
async function hashTable(c,table,key){return (await c.query(`SELECT md5(COALESCE(string_agg(to_jsonb(t)::text,'' ORDER BY ${key}),'')) hash,count(*)::int count FROM ${table} t`)).rows[0];}
async function persisted(c){const result={};for(const[t,k]of[['ada_points.sources','branch_code'],['ada_points.source_snapshots','branch_code'],['ada_points.source_audit','id'],['ada_points.source_openings','branch_code,ada_code'],['ada_points.native_events','event_key'],['ada_points.balance_values','ada_code'],['ada_points.projection_journal','id'],['ada_points.global_state','singleton']])result[t]=await hashTable(c,t,k);return result;}
test('durable native point store on a fresh localhost-only PostgreSQL copy',{skip:!RUN,timeout:240000},async t=>{
 const checks=[],original=source.BRANCHES.map(b=>JSON.parse(fs.readFileSync(path.join(source.RUNTIME,`native-live-${b}.json`),'utf8')));
 const control=new Client({connectionString:BASE_URL,connectionTimeoutMillis:3000});let c,database;
 await control.connect();
 try{
  const id=(await control.query('SELECT current_database() db,host(inet_server_addr()) host,inet_server_port() port')).rows[0];assert.equal(id.db,'sccrm_points_copy');assert.equal(id.host,'127.0.0.1');assert.equal(id.port,55502);
  database='sccrm_points_store_copy_'+crypto.randomBytes(6).toString('hex');await control.query(`CREATE DATABASE "${database}"`);
  const url=new URL(BASE_URL);url.pathname='/'+database;c=new Client({connectionString:url.href,connectionTimeoutMillis:3000});await c.connect();
  await c.query("DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN;END IF;IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN;END IF;END $$");
  await c.query(fs.readFileSync(path.join(source.ROOT,'schema.sql'),'utf8'));
  await c.query('CREATE SCHEMA test_source;CREATE TABLE test_source.snapshots(branch text PRIMARY KEY,payload jsonb NOT NULL);CREATE TABLE public.users(id uuid PRIMARY KEY,name text NOT NULL);CREATE TABLE public.point_ledger(id uuid PRIMARY KEY,user_id uuid NOT NULL,amount integer NOT NULL,note text)');
  for(const s of original)await c.query('INSERT INTO test_source.snapshots VALUES($1,$2::jsonb)',[s.branch,JSON.stringify(s)]);
  await c.query("INSERT INTO public.users VALUES('00000000-0000-4000-8000-000000000001','existing-copy-customer');INSERT INTO public.point_ledger VALUES('00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001',807,'must remain unchanged and excluded')");
  const originalFixture={users:await hashTable(c,'public.users','id'),ledger:await hashTable(c,'public.point_ledger','id'),source:await hashTable(c,'test_source.snapshots','branch')};
  let current=refresh(fixtureSnapshots(original));
  const project=s=>projectNativePoints(s,POLICY),apply=(s,extra={})=>store.applySnapshots(c,s,project(s),{...POLICY,...extra});
  const cache=async code=>(await c.query('SELECT ada_code,balance::text,state,observed_at FROM ada_points.balance_cache WHERE ada_code=$1',[code])).rows[0];
  await t.test('full real source copies persist, match the native projection and exclude the old SCCRM ledger',async()=>{
   const expected=project(current),statements=[];
   const observedClient={connectionParameters:{},query(...args){statements.push(args[0]);return c.query(...args);}};
   const result=await store.applySnapshots(observedClient,current,expected,POLICY);assert.equal(result.sourcePayloadChanges,5);assert.equal(result.balanceChanges,expected.balances.length);assert.equal(result.eventChanges,expected.nativeEvents);assert.equal((await cache(A)).balance,'10.00000000000000000');
   assert.equal(statements.filter(sql=>sql.includes('INSERT INTO ada_points.projection_journal')).length,1);assert.ok(statements.length<35,'bootstrap must batch journal writes instead of one roundtrip per customer');
   const rows=(await c.query('SELECT ada_code,balance::text,state FROM ada_points.balance_values')).rows;
   for(const b of expected.balances){const stored=rows.find(r=>r.ada_code===b.adaCode);assert.equal(stored.state,b.state);assert.equal(stored.balance,b.balanceExact===null?null:b.balanceExact+'.00000000000000000');}
   checks.push('full_sources_and_native_projection');
  });
  await t.test('exact replay causes zero source payload, native event, balance or journal changes',async()=>{
   const before=await persisted(c),r=await apply(current),after=await persisted(c);for(const key of Object.keys(before).filter(k=>k!=='ada_points.global_state'))assert.deepEqual(after[key],before[key]);
   assert.deepEqual([r.sourcePayloadChanges,r.eventChanges,r.retiredEvents,r.balanceChanges,r.journalChanges],[0,0,0,0,0]);checks.push('replay_zero_data_changes');
  });
  await t.test('fresh source timestamps update only metadata/global heartbeat, with unchanged payload and value row xmin',async()=>{
   const before=(await c.query('SELECT ada_code,xmin::text FROM ada_points.balance_values ORDER BY ada_code')).rows;
   const payloadBefore=(await c.query('SELECT branch_code,(payload::text) AS payload,xmin::text,observed_at FROM ada_points.source_snapshots ORDER BY branch_code')).rows;
   const old=(await cache(A)).observed_at;current=refresh(clone(current),5000);const r=await apply(current);assert.equal(r.sourcePayloadChanges,0);assert.equal(r.sourceObservationChanges,5);assert.equal(r.balanceChanges,0);assert.equal(r.journalChanges,0);
   assert.deepEqual((await c.query('SELECT ada_code,xmin::text FROM ada_points.balance_values ORDER BY ada_code')).rows,before);assert.deepEqual((await c.query('SELECT branch_code,(payload::text) AS payload,xmin::text,observed_at FROM ada_points.source_snapshots ORDER BY branch_code')).rows,payloadBefore);assert.ok((await cache(A)).observed_at>old);checks.push('freshness_without_payload_or_balance_rewrites');
  });
  await t.test('a late native award is stored exactly once',async()=>{
   const before=(await c.query('SELECT generation::text FROM ada_points.balance_values WHERE ada_code=$1',[A])).rows[0].generation;
   current=clone(current);current.find(s=>s.branch==='001').points.push(nativePoint('COPY-REF-A'));refresh(current);const r=await apply(current);assert.equal(r.eventChanges,1);assert.equal(r.balanceChanges,1);assert.equal((await cache(A)).balance,'17.00000000000000000');
   const generation=(await c.query('SELECT generation::text FROM ada_points.balance_values WHERE ada_code=$1',[A])).rows[0].generation;assert.ok(BigInt(generation)>BigInt(before));await apply(current);assert.equal((await c.query('SELECT generation::text FROM ada_points.balance_values WHERE ada_code=$1',[A])).rows[0].generation,generation);assert.equal((await c.query('SELECT generation::text FROM ada_points.projection_journal WHERE ada_code=$1 ORDER BY id DESC LIMIT 1',[A])).rows[0].generation,generation);checks.push('late_native_award_and_monotonic_generation');
  });
  await t.test('commit followed by acknowledgement loss replays without duplicate awards or journals',async()=>{
   current=clone(current);current.find(s=>s.branch==='001').points.push(nativePoint('COPY-REF-B','3'));refresh(current);
   await assert.rejects(apply(current,{fault:async stage=>{if(stage==='afterCommit')throw Error('SIMULATED_ACK_LOSS');}}),/SIMULATED_ACK_LOSS/);
   assert.equal((await cache(A)).balance,'20.00000000000000000');const replay=await apply(current);assert.equal(replay.eventChanges,0);assert.equal(replay.balanceChanges,0);assert.equal(replay.journalChanges,0);checks.push('commit_then_lost_ack_replay');
  });
  let pending;
  await t.test('failure before commit rolls back source checkpoints, raw events, balances and journals together',async()=>{
   const before=await persisted(c);pending=clone(current);pending.find(s=>s.branch==='001').points.push(nativePoint('COPY-REF-C','4'));refresh(pending);
   await assert.rejects(apply(pending,{fault:async stage=>{if(stage==='beforeCommit')throw Error('SIMULATED_PROCESS_FAILURE');}}),/SIMULATED_PROCESS_FAILURE/);assert.deepEqual(await persisted(c),before);assert.equal((await cache(A)).balance,'20.00000000000000000');checks.push('atomic_rollback');
  });
  await t.test('reopening the database connection resumes a pending operation once',async()=>{
   await c.end();const url=new URL(BASE_URL);url.pathname='/'+database;c=new Client({connectionString:url.href});await c.connect();current=pending;const r=await apply(current);assert.equal(r.eventChanges,1);assert.equal((await cache(A)).balance,'24.00000000000000000');assert.equal((await apply(current)).journalChanges,0);checks.push('restart_resume');
  });
  await t.test('native flag mutation changes contribution instead of becoming a new award',async()=>{
   current=clone(current);current.find(s=>s.branch==='001').points.find(p=>p.FTPntRefDoc==='COPY-REF-A').FTPntExpired='Y';refresh(current);const r=await apply(current);assert.equal(r.eventChanges,1);assert.equal((await cache(A)).balance,'17.00000000000000000');const event=(await c.query("SELECT contribution::text,active,state FROM ada_points.native_events WHERE doc_no='COPY-REF-A' AND ada_code=$1",[A])).rows[0];assert.equal(event.contribution,'0');assert.equal(event.active,false);assert.equal(event.state,'ready');checks.push('flag_mutation');
  });
  await t.test('an identical event arriving in a replica adds provenance but no second balance',async()=>{
   current=clone(current);current.find(s=>s.branch==='003').points.push(clone(current.find(s=>s.branch==='001').points.find(p=>p.FTPntRefDoc==='COPY-REF-A')));refresh(current);const r=await apply(current);assert.equal(r.eventChanges,1);assert.equal(r.balanceChanges,0);assert.equal(r.journalChanges,0);assert.equal((await cache(A)).balance,'17.00000000000000000');checks.push('replica_dedup');
  });
  await t.test('contradictory replicas hold only the affected member',async()=>{
   current=clone(current);current.find(s=>s.branch==='003').points.find(p=>p.FTPntRefDoc==='COPY-REF-A').FNPntPoint='9';refresh(current);await apply(current);assert.equal((await cache(A)).state,'review');assert.equal((await cache(A)).balance,null);assert.equal((await cache(B)).state,'ready');assert.equal((await cache(B)).balance,'10.00000000000000000');checks.push('conflict_isolated_per_member');
  });
  await t.test('resolved identical source evidence restores a held member without deleting the conflict audit',async()=>{
   current=clone(current);current.find(s=>s.branch==='003').points.find(p=>p.FTPntRefDoc==='COPY-REF-A').FNPntPoint='7';refresh(current);const before=(await c.query('SELECT count(*)::int n FROM ada_points.projection_journal WHERE ada_code=$1',[A])).rows[0].n;await apply(current);assert.equal((await cache(A)).state,'ready');assert.equal((await cache(A)).balance,'17.00000000000000000');assert.equal((await c.query('SELECT count(*)::int n FROM ada_points.projection_journal WHERE ada_code=$1',[A])).rows[0].n,before+1);checks.push('resolution_preserves_journal');
  });
  await t.test('historical owner changes retire the old event and hold both identities',async()=>{
   current=clone(current);current.find(s=>s.branch==='001').points.find(p=>p.FTPntRefDoc==='COPY-REF-B').FTCstCode=B;refresh(current);const r=await apply(current);assert.equal(r.retiredEvents,1);assert.equal((await cache(A)).state,'review');assert.equal((await cache(B)).state,'review');const rows=(await c.query("SELECT ada_code,state FROM ada_points.native_events WHERE doc_no='COPY-REF-B' ORDER BY ada_code")).rows;assert.equal(rows.length,2);assert.equal(rows.find(r=>r.ada_code===A).state,'retired');assert.equal(rows.find(r=>r.ada_code===B).state,'review');assert.equal((await apply(current)).balanceChanges,0);checks.push('historical_owner_change_held');
  });
  await t.test('missing source events are retained retired and never silently subtracted into a ready balance',async()=>{
   current=clone(current);const s=current.find(s=>s.branch==='001');s.points=s.points.filter(p=>p.FTPntRefDoc!=='COPY-REF-C');refresh(current);const r=await apply(current);assert.equal(r.retiredEvents,1);assert.equal((await cache(A)).state,'review');assert.equal((await c.query("SELECT count(*)::int n FROM ada_points.native_events WHERE doc_no='COPY-REF-C' AND state='retired'")).rows[0].n,1);assert.equal((await apply(current)).eventChanges,0);checks.push('removal_retained_and_held');
  });
  await t.test('partial inputs, source tampering and forged projections are refused without any persistence',async()=>{
   const before=await persisted(c);await assert.rejects(store.applySnapshots(c,current.slice(1),project(current),POLICY),/POINT_STORE_ALL_SOURCES_REQUIRED/);
   const altered=clone(current);altered[0].customers[0].FCCstRetPoint='999';await assert.rejects(store.applySnapshots(c,altered,project(current),POLICY),/POINT_STORE_SOURCE_HASH_REFUSED/);
   const forged=clone(project(current));forged.sccrmLedgerIncluded=true;await assert.rejects(store.applySnapshots(c,current,forged,POLICY),/POINT_STORE_PROJECTION_IDENTITY_REFUSED/);assert.deepEqual(await persisted(c),before);checks.push('input_scope_and_identity_guards');
  });
  await t.test('older observations cannot replace a more recently verified source',async()=>{
   const stale=refresh(clone(current),-1000);const before=await persisted(c);await assert.rejects(apply(stale),/POINT_STORE_SOURCE_OBSERVATION_REGRESSION/);assert.deepEqual(await persisted(c),before);checks.push('stale_observation_refused');
  });
  await t.test('global unavailable status preserves observation age and hides usable cache values',async()=>{
   const before=(await c.query('SELECT observed_at,revision FROM ada_points.global_state')).rows[0];await store.markUnavailable(c);const after=(await c.query('SELECT observed_at,revision,state FROM ada_points.global_state')).rows[0];assert.equal(after.state,'review');assert.equal(after.observed_at.toISOString(),before.observed_at.toISOString());assert.equal(after.revision,before.revision);const value=await cache('AR000-000006');assert.equal(value.state,'review');assert.equal(value.balance,null);await apply(current);checks.push('unavailable_preserves_source_age');
  });
  await t.test('approved alias families accept long canonical labels and share durable removal holds',async()=>{
   const C='LAB-COPY-FAMILY-C',D='LAB-COPY-FAMILY-D',member='00000000-0000-4000-8000-000000000003';
   const ownerMap=[{member_id:member,ada_code:C,canonical_code:'ADA-'+C},{member_id:member,ada_code:D,canonical_code:'ADA-'+C}],policy={...POLICY,ownerMap};
   assert.ok(ownerMap[0].canonical_code.length>20);
   current=clone(current);
   for(const s of current)for(const [code,opening]of[[C,'5'],[D,'0']]){s.customers.push({FTCstCode:code,FCCstRetPoint:opening,FCCstRetAmt:'0',FCCstWhsPoint:'0',FCCstDailyPoint:'0',FTBchCode:'001',FDCstLastPoint:null,FDDateUpd:null,FTTimeUpd:null});s.balances.push({FTCstCode:code,FNPntPoint:opening,FCPntAmtRcv:'0'});}
   const home=current.find(s=>s.branch==='001');home.points.push(nativePoint('COPY-FAMILY-EVENT','2',C));home.balances.find(b=>b.FTCstCode===C).FNPntPoint='7';refresh(current);
   const applyFamily=()=>store.applySnapshots(c,current,projectNativePoints(current,policy),policy);
   await applyFamily();assert.equal((await cache(C)).balance,'7.00000000000000000');assert.equal((await cache(D)).balance,'7.00000000000000000');
   home.points=home.points.filter(p=>p.FTPntRefDoc!=='COPY-FAMILY-EVENT');home.balances.find(b=>b.FTCstCode===C).FNPntPoint='5';refresh(current);await applyFamily();assert.equal((await cache(C)).state,'review');assert.equal((await cache(D)).state,'review');assert.equal((await cache(C)).balance,null);assert.equal((await cache(D)).balance,null);assert.equal((await applyFamily()).journalChanges,0);checks.push('approved_alias_identity_and_removal_hold');
  });
  await t.test('proved owned native corrections never feed back as earnings or consume a generation',async()=>{
   const E='LAB-COPY-OWNED-E',I='LAB-COPY-OWNED-I',member='00000000-0000-4000-8000-000000000005',marker=require('../points/compensation.cjs').MARKER,who=require('../points/compensation.cjs').WHO;
   const policy={...POLICY,ownerMap:[{member_id:member,ada_code:E,canonical_code:E},{member_id:member,ada_code:I,canonical_code:E}]},applyOwned=(s=current)=>store.applySnapshots(c,s,projectNativePoints(s,policy),policy);
   current=clone(current);for(const s of current)for(const[code,opening]of[[E,'10'],[I,'0']]){s.customers.push({FTCstCode:code,FCCstRetPoint:opening,FCCstRetAmt:'0',FCCstWhsPoint:'0',FCCstDailyPoint:'0',FTBchCode:'001',FDCstLastPoint:null,FDDateUpd:null,FTTimeUpd:null});s.balances.push({FTCstCode:code,FNPntPoint:opening,FCPntAmtRcv:'0'});}
   const home=current.find(s=>s.branch==='001'),branch=current.find(s=>s.branch==='005');home.points.push(nativePoint('COPY-OWNED-EARNING','2',E));home.balances.find(b=>b.FTCstCode===E).FNPntPoint='12';refresh(current);await applyOwned();assert.equal((await cache(I)).balance,'12.00000000000000000');
   const baseline=(await c.query('SELECT generation::text,version FROM ada_points.balance_values WHERE ada_code=$1',[E])).rows[0];
   const receipt=(operation,generation,previous,target,delta)=>({operation_id:operation,ada_code:E,branch_code:'005',ref_doc:'SP'+operation.replaceAll('-','').slice(0,28),revision:baseline.version,generation,expected_intrinsic:'10',previous_balance:previous,target_balance:target,delta_points:delta,created_at:'2026-11-02T02:00:00.000'});
   const correction=r=>({...nativePoint(r.ref_doc,(BigInt(r.delta_points)<0n?-BigInt(r.delta_points):BigInt(r.delta_points)).toString(),E),FTBchCode:r.branch_code,FTPntCardType:BigInt(r.delta_points)>0n?'1':'2',FCPntPointbyOne:'0',FCPntAmtRcv:'0',FNPntPointOld:r.previous_balance,FTWhoIns:who});
   const first=receipt('20000000-0000-4000-8000-000000000001',baseline.generation,'10','12','2');
   branch.ownedCompensation={present:true,meta:[{singleton:1,marker,target_identity:model.databaseId(branch),branch_code:'005'}],receipts:[first]};branch.points.push(correction(first));branch.balances.find(b=>b.FTCstCode===E).FNPntPoint='12';refresh(current);
   const ack=await applyOwned();assert.equal(ack.balanceChanges,0);assert.equal(ack.eventChanges,0);assert.equal((await c.query('SELECT generation::text FROM ada_points.balance_values WHERE ada_code=$1',[E])).rows[0].generation,baseline.generation);assert.equal((await c.query('SELECT count(*)::int n FROM ada_points.native_events WHERE doc_no=$1',[first.ref_doc])).rows[0].n,0);assert.equal((await cache(E)).balance,'12.00000000000000000');
   const bad=clone(current),badBranch=bad.find(s=>s.branch==='005');badBranch.points.find(p=>p.FTPntRefDoc===first.ref_doc).FTWhoIns='altered';refresh(bad);const before=await persisted(c);await assert.rejects(async()=>applyOwned(bad),/POINT_OWNED_ROW_CHANGED/);assert.deepEqual(await persisted(c),before);
   home.points.push(nativePoint('COPY-OWNED-LATE-EARNING','3',E));home.balances.find(b=>b.FTCstCode===E).FNPntPoint='15';refresh(current);await applyOwned();
   const newer=(await c.query('SELECT generation::text FROM ada_points.balance_values WHERE ada_code=$1',[E])).rows[0].generation;assert.ok(BigInt(newer)>BigInt(baseline.generation));
   const second=receipt('30000000-0000-4000-8000-000000000001',newer,'12','15','3');branch.ownedCompensation.receipts.push(second);branch.points.push(correction(second));branch.balances.find(b=>b.FTCstCode===E).FNPntPoint='15';refresh(current);assert.equal((await applyOwned()).balanceChanges,0);assert.equal((await cache(E)).balance,'15.00000000000000000');assert.equal((await c.query('SELECT generation::text FROM ada_points.balance_values WHERE ada_code=$1',[E])).rows[0].generation,newer);
   const replica=current.find(s=>s.branch==='003');replica.points.push(clone(branch.points.find(p=>p.FTPntRefDoc===first.ref_doc)));replica.balances.find(b=>b.FTCstCode===E).FNPntPoint='12';refresh(current);const replicated=await applyOwned();assert.equal(replicated.eventChanges,0);assert.equal(projectNativePoints(current,policy).balances.find(b=>b.adaCode===E).balanceExact,'15','pure global math remains available for analysis');
   for(const code of[E,I]){assert.equal((await cache(code)).state,'review');assert.equal((await cache(code)).balance,null);}const held=(await c.query('SELECT generation::text FROM ada_points.balance_values WHERE ada_code=$1',[E])).rows[0].generation;assert.ok(BigInt(held)>BigInt(newer));assert.equal((await applyOwned()).balanceChanges,0);
   const changedReplica=clone(current),changedBranch=changedReplica.find(s=>s.branch==='003');changedBranch.points.find(p=>p.FTPntRefDoc===first.ref_doc).FNPntPoint='6';changedBranch.balances.find(b=>b.FTCstCode===E).FNPntPoint='16';refresh(changedReplica);await assert.rejects(async()=>applyOwned(changedReplica),/POINT_OWNED_REPLICA_CHANGED/);
   const counter={...receipt('40000000-0000-4000-8000-000000000001',held,'12','10','-2'),branch_code:'003',expected_intrinsic:'12'};replica.ownedCompensation={present:true,meta:[{singleton:1,marker,target_identity:model.databaseId(replica),branch_code:'003'}],receipts:[counter]};replica.points.push(correction(counter));replica.balances.find(b=>b.FTCstCode===E).FNPntPoint='10';branch.points.push(correction(counter));branch.balances.find(b=>b.FTCstCode===E).FNPntPoint='13';refresh(current);assert.equal((await applyOwned()).balanceChanges,0);assert.equal((await c.query('SELECT generation::text FROM ada_points.balance_values WHERE ada_code=$1',[E])).rows[0].generation,held);assert.equal((await applyOwned()).balanceChanges,0);for(const code of[E,I])assert.equal((await cache(code)).state,'review');checks.push('owned_compensation_no_feedback_and_sticky_foreign_family_hold');
  });
  await t.test('a later non-home opening change durably holds its approved family without rewriting the initial baseline',async()=>{
   const F='LAB-COPY-OPENING-F',G='LAB-COPY-OPENING-G',member='00000000-0000-4000-8000-000000000004',policy={...POLICY,ownerMap:[{member_id:member,ada_code:F,canonical_code:F},{member_id:member,ada_code:G,canonical_code:F}]};
   current=clone(current);for(const s of current)for(const [code,opening]of[[F,'10'],[G,'0']]){s.customers.push({FTCstCode:code,FCCstRetPoint:opening,FCCstRetAmt:'0',FCCstWhsPoint:'0',FCCstDailyPoint:'0',FTBchCode:'001',FDCstLastPoint:null,FDDateUpd:null,FTTimeUpd:null});s.balances.push({FTCstCode:code,FNPntPoint:opening,FCPntAmtRcv:'0'});}
   const run=()=>store.applySnapshots(c,current,projectNativePoints(current,policy),policy);refresh(current);await run();assert.equal((await cache(F)).state,'ready');assert.equal((await cache(G)).balance,'10.00000000000000000');const baseline=await hashTable(c,'ada_points.source_openings','branch_code,ada_code');
   const nonhome=current.find(s=>s.branch==='003');nonhome.customers.find(row=>row.FTCstCode===F).FCCstRetPoint='13';nonhome.balances.find(row=>row.FTCstCode===F).FNPntPoint='13';refresh(current);await run();for(const code of[F,G]){assert.equal((await cache(code)).state,'review');assert.equal((await cache(code)).balance,null);}assert.deepEqual(await hashTable(c,'ada_points.source_openings','branch_code,ada_code'),baseline);assert.equal((await run()).balanceChanges,0);
   nonhome.customers.find(row=>row.FTCstCode===F).FCCstRetPoint='10';nonhome.balances.find(row=>row.FTCstCode===F).FNPntPoint='10';refresh(current);await run();assert.equal((await cache(F)).state,'review','historical opening change remains held until an explicit approval workflow');assert.equal((await cache(G)).state,'review');checks.push('immutable_opening_baseline_and_sticky_family_review');
  });
  await t.test('native processed-flag changes hold durably instead of dropping a carried award',async()=>{
   const H='LAB-COPY-PROCESSED-H';current=clone(current);for(const s of current){s.customers.push({FTCstCode:H,FCCstRetPoint:'10',FCCstRetAmt:'0',FCCstWhsPoint:'0',FCCstDailyPoint:'0',FTBchCode:'001',FDCstLastPoint:null,FDDateUpd:null,FTTimeUpd:null});s.balances.push({FTCstCode:H,FNPntPoint:'10',FCPntAmtRcv:'0'});}
   const native=current.find(s=>s.branch==='005'),event=nativePoint('COPY-PROCESSING-H','5',H);event.FTBchCode='005';native.points.push(event);native.balances.find(b=>b.FTCstCode===H).FNPntPoint='15';refresh(current);await apply(current);assert.equal((await cache(H)).balance,'15.00000000000000000');
   event.FTPntStaPrcDoc='Y';native.balances.find(b=>b.FTCstCode===H).FNPntPoint='10';refresh(current);await apply(current);assert.equal((await cache(H)).state,'review');assert.equal((await cache(H)).balance,null);assert.equal((await apply(current)).balanceChanges,0);
   event.FTPntStaPrcDoc='N';native.balances.find(b=>b.FTCstCode===H).FNPntPoint='15';refresh(current);await apply(current);assert.equal((await cache(H)).state,'review');const persisted=(await c.query('SELECT review_reasons FROM ada_points.native_events WHERE doc_no=$1',[event.FTPntRefDoc])).rows[0];assert.ok(persisted.review_reasons.includes('NATIVE_PROCESSING_CHANGED_REVIEW'));checks.push('processed_flag_rollup_sticky_review');
  });
  await t.test('RLS and security-invoker view deny anonymous access and expose only explicitly granted reader tables',async()=>{
   const reader='points_copy_reader_'+crypto.randomBytes(4).toString('hex');await c.query(`CREATE ROLE "${reader}" NOLOGIN;GRANT USAGE ON SCHEMA ada_points TO "${reader}";GRANT SELECT ON ada_points.balance_cache TO "${reader}"`);
   const roles=(await c.query("SELECT relname,relrowsecurity FROM pg_class WHERE relnamespace='ada_points'::regnamespace AND relkind='r'")).rows;assert.equal(roles.length,9);assert.ok(roles.every(r=>r.relrowsecurity));assert.ok((await c.query("SELECT reloptions FROM pg_class WHERE oid='ada_points.balance_cache'::regclass")).rows[0].reloptions.includes('security_invoker=true'));
   await c.query('SET ROLE anon');try{await assert.rejects(c.query('SELECT * FROM ada_points.balance_cache'),e=>e.code==='42501');}finally{await c.query('RESET ROLE');}
   await c.query(`SET ROLE "${reader}"`);try{await assert.rejects(c.query('SELECT * FROM ada_points.balance_cache'),e=>e.code==='42501');}finally{await c.query('RESET ROLE');}
   await c.query(`GRANT SELECT ON ada_points.balance_values,ada_points.global_state TO "${reader}"`);await c.query(`SET ROLE "${reader}"`);try{assert.equal((await c.query('SELECT count(*)::int n FROM ada_points.balance_cache')).rows[0].n,0);}finally{await c.query('RESET ROLE');}
   await c.query(`CREATE POLICY copy_reader_values ON ada_points.balance_values FOR SELECT TO "${reader}" USING(true);CREATE POLICY copy_reader_global ON ada_points.global_state FOR SELECT TO "${reader}" USING(true)`);
   await c.query(`SET ROLE "${reader}"`);try{assert.ok((await c.query('SELECT count(*)::int n FROM ada_points.balance_cache')).rows[0].n>=1474);await assert.rejects(c.query('SELECT * FROM ada_points.source_snapshots'),e=>e.code==='42501');await assert.rejects(c.query("UPDATE ada_points.balance_values SET balance=0 WHERE ada_code='0'"),e=>e.code==='42501');}finally{await c.query('RESET ROLE');}checks.push('rls_and_readonly_view_permissions');
  });
  await t.test('all original fake users, SCCRM ledger and five archived source fixtures remain byte-equivalent',async()=>{
   assert.deepEqual(await hashTable(c,'public.users','id'),originalFixture.users);assert.deepEqual(await hashTable(c,'public.point_ledger','id'),originalFixture.ledger);assert.deepEqual(await hashTable(c,'test_source.snapshots','branch'),originalFixture.source);checks.push('original_fixture_immutability');
  });
  assert.equal(checks.length,22,'write successful result only when every focused subcheck passed');
  const result={ok:true,scope:'LOCAL-POSTGRES-POINTS-STORE-COPY-ONLY',database,host:'127.0.0.1',port:55502,at:new Date().toISOString(),checks,passed:checks.length,sourceFixtures:original.map(s=>({branch:s.branch,customers:s.customers.length,points:s.points.length})),productionWrites:0,sqlServerWrites:0,pinRead:false};
  fs.writeFileSync(path.join(source.RUNTIME,'store-copy-result.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify({ok:true,scope:result.scope,database,passed:checks.length,productionWrites:0,sqlServerWrites:0,pinRead:false}));
 }finally{if(c)await c.end().catch(()=>{});await control.end();}
});
