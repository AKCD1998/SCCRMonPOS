'use strict';
// Isolated PostgreSQL copy; injected native receiver models durable correction
// receipts. Never connects to Ada SQL Server, Supabase or a Windows service.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const test=require('node:test'),assert=require('node:assert/strict'),{Client,Pool}=require('pg');
const delivery=require('../points/delivery.cjs');
const RUN=process.env.SCCRM_POINTS_COPY_TEST==='1';
const BASE='postgresql://postgres@127.0.0.1:55502/postgres';
const sha=x=>crypto.createHash('sha256').update(String(x)).digest('hex');
const targetId=b=>'copy-'+b,identity=b=>'COPY-NATIVE-POINTS-'+b;
function receiver(branch){
 const balances=new Map(),intrinsics=new Map(),receipts=new Map(),heads=new Map(),corrections=[];
 const adapter={targetId:targetId(branch),databaseIdentity:identity(branch),calls:0,
  async apply(job){adapter.calls++;
   const old=receipts.get(job.operation_id);if(old){assert.equal(old.ada_code,job.ada_code);assert.equal(old.generation,job.generation);assert.equal(old.target_balance,job.target_balance);return {...old,outcome:'replayed'};}
   if(BigInt(heads.get(job.ada_code)||'0')>BigInt(job.generation))return ack(job,'superseded');
   if(String(intrinsics.get(job.ada_code)??10)!==job.expected_intrinsic)throw Object.assign(Error('SOURCE_MOVED_RETRY'),{code:'SOURCE_MOVED_RETRY'});
   const before=BigInt(balances.get(job.ada_code)??10),after=BigInt(job.target_balance);
   corrections.push({operation_id:job.operation_id,ada_code:job.ada_code,delta:(after-before).toString()});balances.set(job.ada_code,after.toString());heads.set(job.ada_code,job.generation);
   const result=ack(job,'applied');receipts.set(job.operation_id,result);return result;
  }};
 return {adapter,balances,intrinsics,receipts,heads,corrections};
}
function ack(job,outcome='applied'){return {operation_id:job.operation_id,ada_code:job.ada_code,generation:job.generation,target_balance:job.target_balance,projection_version:job.projection_version,database_identity:job.database_identity,outcome};}
test('durable point delivery on a fresh private PostgreSQL copy',{skip:!RUN,timeout:180000},async t=>{
 const control=new Client({connectionString:BASE,connectionTimeoutMillis:3000});let c,pool,database;const checks=[];
 await control.connect();
 try{
  const server=(await control.query('SELECT host(inet_server_addr()) host,inet_server_port() port,current_database() db')).rows[0];assert.deepEqual(server,{host:'127.0.0.1',port:55502,db:'postgres'});
  database='sccrm_points_delivery_copy_'+crypto.randomBytes(6).toString('hex');await control.query(`CREATE DATABASE "${database}"`);
  const url=new URL(BASE);url.pathname='/'+database;c=new Client({connectionString:url.href});await c.connect();pool=new Pool({connectionString:url.href,max:3});
  await c.query(fs.readFileSync(path.join(__dirname,'../points/schema.sql'),'utf8'));
  await c.query(fs.readFileSync(path.join(__dirname,'../points/delivery-schema.sql'),'utf8'));
  let observedAt=new Date(Date.now()-2000).toISOString();
  async function freshen(advance=1){observedAt=new Date(Math.max(Date.now(),Date.parse(observedAt)+advance)).toISOString();
   await c.query('UPDATE ada_points.sources SET observed_at=$1',[observedAt]);await c.query("UPDATE ada_points.global_state SET state='ready',observed_at=$1,revision=$2 WHERE singleton",[observedAt,sha('global-'+observedAt)]);return freshness();}
  const freshness=()=>({sources:delivery.BRANCHES.map(branchCode=>({branchCode,databaseIdentity:identity(branchCode),observedAt})),maxAgeMs:120000});
  for(const branch of delivery.BRANCHES)await c.query('INSERT INTO ada_points.sources(branch_code,source_identity,machine,database_name,schema_hash,view_hash,observed_at) VALUES($1,$2,$3,$4,$5,$5,$6)',[branch,identity(branch),'COPY-'+branch,'PRIVATE_ADA_COPY',sha('schema'),observedAt]);
  await c.query("UPDATE ada_points.global_state SET state='ready',observed_at=$1,revision=$2 WHERE singleton",[observedAt,sha('global')]);
  await c.query('CREATE SCHEMA test_native;CREATE TABLE test_native.customers(code text PRIMARY KEY,opening bigint NOT NULL);CREATE TABLE test_native.native_points(doc text PRIMARY KEY,points bigint NOT NULL)');
  await c.query("INSERT INTO test_native.customers VALUES('EXISTING-A',12),('EXISTING-B',1),('EXISTING-C',0);INSERT INTO test_native.native_points VALUES('OLD-BILL',7)");
  const originals=async()=>(await c.query("SELECT (SELECT md5(string_agg(to_jsonb(t)::text,'' ORDER BY code)) FROM test_native.customers t) customers,(SELECT md5(string_agg(to_jsonb(t)::text,'' ORDER BY doc)) FROM test_native.native_points t) points")).rows[0];
  const beforeOriginals=await originals();
  const targets=delivery.BRANCHES.map(branchCode=>({targetId:targetId(branchCode),branchCode,databaseIdentity:identity(branchCode),enabled:true}));
  const one=async(sql,values=[])=>(await c.query(sql,values)).rows[0];
  async function project(code,balance='20',state='ready'){
   return one(`INSERT INTO ada_points.balance_values(ada_code,balance,state,version,details,generation)
    VALUES($1,$2,$3,$4,$5,nextval('ada_points.balance_generation_seq'))
    ON CONFLICT(ada_code) DO UPDATE SET balance=EXCLUDED.balance,state=EXCLUDED.state,version=EXCLUDED.version,
     details=EXCLUDED.details,generation=EXCLUDED.generation RETURNING generation::text,version,balance::text,state`,[code,state==='ready'?balance:null,state,sha(code+'-'+balance+'-'+state),JSON.stringify({copy:true})]);
  }
  function candidate(branch,code,p,extra={}){return {targetId:targetId(branch),adaCode:code,generation:p.generation,projectionVersion:p.version,targetBalance:String(p.balance??20),expectedIntrinsic:'10',rawViewBalance:'10',nativeExists:true,...extra};}
  async function add(branch,code,extra={}){const p=await project(code,extra.balance??'20');const row=candidate(branch,code,p,extra);await delivery.enqueue(c,{freshness:freshness(),candidates:[row]});return {p,row};}
  const state=code=>one('SELECT * FROM ada_points.delivery_jobs WHERE ada_code=$1 ORDER BY generation DESC LIMIT 1',[code]);
  const due=code=>c.query("UPDATE ada_points.delivery_jobs SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE ada_code=$1 AND state='retry'",[code]);
  await t.test('owned schema is repeatable and target identities bind to the reviewed source registry',async()=>{
   await c.query(fs.readFileSync(path.join(__dirname,'../points/delivery-schema.sql'),'utf8'));assert.equal((await delivery.registerTargets(c,targets)).registered,5);
   await assert.rejects(delivery.registerTargets(c,[{...targets[0],databaseIdentity:'WRONG-COPY'}]),/TARGET_IDENTITY_CHANGED/);
   assert.equal((await one('SELECT count(*)::int n FROM ada_points.delivery_targets')).n,5);checks.push('owned_schema_and_target_bindings');
  });
  await t.test('1474 candidates enqueue in a bounded number of SQL roundtrips and replay without extra jobs or audit',async()=>{
   const codes=Array.from({length:1474},(_,i)=>'BULK-'+String(i).padStart(4,'0'));
   await c.query(`INSERT INTO ada_points.balance_values(ada_code,balance,state,version,details,generation)
    SELECT code,20,'ready',$2,'{}',nextval('ada_points.balance_generation_seq') FROM jsonb_array_elements_text($1::jsonb) x(code)`,[JSON.stringify(codes),sha('bulk')]);
   const rows=(await c.query("SELECT ada_code,generation::text,version,balance::text FROM ada_points.balance_values WHERE ada_code LIKE 'BULK-%' ORDER BY ada_code")).rows;
   const candidates=rows.map(p=>candidate('000',p.ada_code,p));let queries=0;
   const counted={connectionParameters:{},query(...args){queries++;return c.query(...args);}};
   const first=await delivery.enqueue(counted,{freshness:freshness(),candidates});assert.equal(first.inserted,1474);assert.ok(queries<=8,`bulk enqueue used ${queries} roundtrips`);
   const audit=await one('SELECT count(*)::int n FROM ada_points.delivery_audit');const again=await delivery.enqueue(counted,{freshness:freshness(),candidates});assert.equal(again.inserted,0);assert.deepEqual(await one('SELECT count(*)::int n FROM ada_points.delivery_audit'),audit);checks.push('1474_bulk_roundtrips_and_replay');
  });
  await t.test('concurrent consumers obtain disjoint leases and skip a deliberately locked oldest row',async()=>{
   const locker=await pool.connect();let locked;
   try{await locker.query('BEGIN');locked=(await locker.query("SELECT id FROM ada_points.delivery_jobs WHERE target_id=$1 ORDER BY id LIMIT 1 FOR UPDATE",[targetId('000')])).rows[0].id;
    const batches=await Promise.all(Array.from({length:4},()=>delivery.lease(pool,{targetId:targetId('000'),freshness:freshness(),limit:100})));
    const all=batches.flat();assert.equal(all.length,400);assert.equal(new Set(all.map(j=>j.id)).size,400);assert.ok(all.every(j=>j.id!==locked));assert.equal(new Set(batches.map(b=>b[0].lease_token)).size,4);
   }finally{await locker.query('ROLLBACK');locker.release();}checks.push('concurrent_fenced_skip_locked_leases');
  });
  await t.test('only ready, current, native-existing, unaligned candidates enter delivery',async()=>{
   const missing=await project('ABSENT-COPY'),aligned=await project('ALIGNED-COPY'),held=await project('HELD-COPY','20','review'),current=await project('STALE-COPY');
   const result=await delivery.enqueue(c,{freshness:freshness(),candidates:[candidate('001','ABSENT-COPY',missing,{nativeExists:false}),candidate('001','ALIGNED-COPY',aligned,{rawViewBalance:'20'}),candidate('001','HELD-COPY',held,{targetBalance:'20'}),candidate('001','STALE-COPY',current,{projectionVersion:sha('forged-old')})]});
   assert.equal(result.inserted,0);assert.equal(result.absent,1);assert.equal(result.aligned,1);assert.equal(result.eligible,2);checks.push('ready_existing_current_unaligned_only');
  });
  await t.test('an online target succeeds while another target is offline and retries with bounded backoff',async()=>{
   await add('001','ONLINE-COPY');await add('005','OFFLINE-COPY');const online=receiver('001'),offline={targetId:targetId('005'),databaseIdentity:identity('005'),apply:async()=>{throw Object.assign(Error('offline'),{code:'ECONNREFUSED'});}};
   const result=await Promise.all([delivery.drainTarget(pool,online.adapter,{freshness:freshness(),limit:1}),delivery.drainTarget(pool,offline,{freshness:freshness(),limit:1,retry:{baseMs:100,maxMs:300000}})]);
   assert.equal(result[0].results[0].state,'succeeded');const waiting=await state('OFFLINE-COPY');assert.equal(waiting.state,'retry');assert.ok(waiting.next_attempt_at);assert.equal(waiting.attempt_count,1);
   await due('OFFLINE-COPY');const restored=receiver('005');await delivery.drainTarget(c,restored.adapter,{freshness:freshness(),limit:1});assert.equal((await state('OFFLINE-COPY')).state,'succeeded');assert.equal(restored.corrections.length,1);checks.push('offline_independent_reconnect');
  });
  await t.test('an expired lease cannot acknowledge; restart reclaims the same operation with a new fence',async()=>{
   await add('003','RESTART-COPY');const [old]=await delivery.lease(c,{targetId:targetId('003'),freshness:freshness(),limit:1});
   await c.query("UPDATE ada_points.delivery_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[old.id]);
   assert.equal((await delivery.acknowledge(c,old,ack(old),identity('003'))).accepted,false);
   const reconnect=new Client({connectionString:url.href});await reconnect.connect();try{
    const [resumed]=await delivery.lease(reconnect,{targetId:targetId('003'),freshness:freshness(),limit:1});assert.equal(resumed.operation_id,old.operation_id);assert.notEqual(resumed.lease_token,old.lease_token);assert.equal(resumed.attempt_count,2);
    assert.equal((await delivery.acknowledge(c,old,ack(old),identity('003'))).accepted,false);assert.equal((await delivery.acknowledge(reconnect,resumed,ack(resumed),identity('003'))).state,'succeeded');
   }finally{await reconnect.end();}checks.push('restart_and_stale_ack_fences');
  });
  await t.test('native commit followed by lost acknowledgement replays one immutable correction',async()=>{
   await add('003','ACK-LOSS-COPY');const native=receiver('003');const [first]=await delivery.lease(c,{targetId:targetId('003'),freshness:freshness(),limit:1});await native.adapter.apply(first);
   await c.query("UPDATE ada_points.delivery_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[first.id]);
   const [retry]=await delivery.lease(c,{targetId:targetId('003'),freshness:freshness(),limit:1});const result=await native.adapter.apply(retry);assert.equal(result.outcome,'replayed');await delivery.acknowledge(c,retry,result,identity('003'));
   assert.equal((await state('ACK-LOSS-COPY')).state,'succeeded');assert.equal(native.corrections.length,1);assert.equal(native.balances.get(first.ada_code),'20');checks.push('native_ack_loss_exact_replay');
  });
  await t.test('SOURCE_MOVED waits for newer verified snapshots and never forces its old intrinsic expectation',async()=>{
   const {row}=await add('004','SOURCE-MOVE-COPY'),native=receiver('004');native.intrinsics.set(row.adaCode,11);
   await delivery.drainTarget(c,native.adapter,{freshness:freshness(),limit:1});let job=await state(row.adaCode);assert.equal(job.last_code,'SOURCE_MOVED_RETRY');assert.equal(job.next_attempt_at,null);assert.equal(native.corrections.length,0);
   await due(row.adaCode);assert.equal((await delivery.lease(c,{targetId:targetId('004'),freshness:freshness(),limit:1})).length,0);
   const same=await delivery.enqueue(c,{freshness:freshness(),candidates:[{...row,expectedIntrinsic:'11',rawViewBalance:'11'}]});assert.equal(same.refreshed,0);
   await freshen();const fresh=await delivery.enqueue(c,{freshness:freshness(),candidates:[{...row,expectedIntrinsic:'11',rawViewBalance:'11'}]});assert.equal(fresh.refreshed,1);
   await delivery.drainTarget(c,native.adapter,{freshness:freshness(),limit:1});job=await state(row.adaCode);assert.equal(job.state,'succeeded');assert.equal(job.expected_intrinsic,'11');assert.equal(native.corrections.length,1);checks.push('source_movement_fresh_snapshot_gate');
  });
  await t.test('new generations supersede in-flight jobs and fence their late acknowledgements',async()=>{
   await add('004','NEW-GEN-COPY');const [old]=await delivery.lease(c,{targetId:targetId('004'),freshness:freshness(),limit:1});const p=await project(old.ada_code,'30');
   const added=await delivery.enqueue(c,{freshness:freshness(),candidates:[candidate('004',old.ada_code,p)]});assert.equal(added.superseded,1);assert.equal(added.inserted,1);
   assert.equal((await delivery.acknowledge(c,old,ack(old),identity('004'))).accepted,false);const native=receiver('004');await delivery.drainTarget(c,native.adapter,{freshness:freshness(),limit:1});assert.equal(native.balances.get(old.ada_code),'30');assert.equal((await state(old.ada_code)).state,'succeeded');checks.push('new_generation_supersession_late_ack');
  });
  await t.test('new already-aligned generation still supersedes the older pending job',async()=>{
   await add('004','ALIGNED-NEW-COPY');const p=await project('ALIGNED-NEW-COPY','30');const r=await delivery.enqueue(c,{freshness:freshness(),candidates:[candidate('004','ALIGNED-NEW-COPY',p,{rawViewBalance:'30'})]});
   assert.equal(r.inserted,0);assert.equal(r.superseded,1);assert.equal((await state('ALIGNED-NEW-COPY')).state,'superseded');assert.equal((await delivery.lease(c,{targetId:targetId('004'),freshness:freshness(),limit:1})).length,0);checks.push('aligned_new_generation_retires_old_pending');
  });
  await t.test('each native ACK identity mismatch is held rather than declared successful',async()=>{
   for(const [field,value] of [['operation_id',crypto.randomUUID()],['ada_code','OTHER-COPY'],['generation','999999'],['target_balance','999'],['database_identity','WRONG-COPY'],['projection_version',sha('wrong')],['outcome','unknown']]){
    const code='BADACK-'+field.slice(0,12);await add('001',code);const [job]=await delivery.lease(c,{targetId:targetId('001'),freshness:freshness(),limit:1});const result=await delivery.acknowledge(c,job,{...ack(job),[field]:value},identity('001'));
    assert.equal(result.state,'review');assert.equal((await state(code)).last_code,'NATIVE_ACK_IDENTITY_MISMATCH');
   }checks.push('all_native_ack_identity_fences');
  });
  await t.test('wrong adapter identity and immutable native-row/operation failures never call or repeat writes',async()=>{
   await add('001','WRONG-TARGET-COPY');let calls=0;await delivery.drainTarget(c,{targetId:targetId('001'),databaseIdentity:'UNRELATED-COPY',async apply(){calls++;}},{freshness:freshness(),limit:1});assert.equal(calls,0);assert.equal((await state('WRONG-TARGET-COPY')).state,'review');
   for(const code of ['POINT_RECEIVER_OWNED_ROW_CHANGED','POINT_RECEIVER_OPERATION_REUSED']){const fixture='HOLD-'+code.slice(-10);await add('001',fixture);const [job]=await delivery.lease(c,{targetId:targetId('001'),freshness:freshness(),limit:1});await delivery.failJob(c,job,{code});assert.equal((await state(fixture)).state,'review');}
   assert.equal((await delivery.lease(c,{targetId:targetId('001'),freshness:freshness(),limit:1})).length,0);checks.push('identity_owned_row_operation_review');
  });
  await t.test('source freshness and global review block both enqueue and native calls',async()=>{
   const {row}=await add('005','FRESHNESS-COPY'),native=receiver('005'),old=freshness();old.sources[0].observedAt=new Date(Date.now()-180000).toISOString();
   await assert.rejects(delivery.enqueue(c,{freshness:old,candidates:[row]}),/SOURCES_NOT_FRESH/);await assert.rejects(delivery.drainTarget(c,native.adapter,{freshness:old,limit:1}),/SOURCES_NOT_FRESH/);assert.equal(native.adapter.calls,0);
   await c.query("UPDATE ada_points.global_state SET state='review' WHERE singleton");await assert.rejects(delivery.drainTarget(c,native.adapter,{freshness:freshness(),limit:1}),/SOURCES_NOT_FRESH/);assert.equal(native.adapter.calls,0);
   await freshen();await delivery.drainTarget(c,native.adapter,{freshness:freshness(),limit:1});assert.equal((await state(row.adaCode)).state,'succeeded');checks.push('five_source_and_global_freshness');
  });
  await t.test('disabling one delivery target pauses only that target and preserves its job',async()=>{
   await add('005','PAUSE-COPY');await delivery.setTargetEnabled(c,targetId('005'),false);assert.equal((await delivery.lease(c,{targetId:targetId('005'),freshness:freshness(),limit:1})).length,0);assert.equal((await state('PAUSE-COPY')).state,'queued');
   await add('003','OTHER-ONLINE-COPY');await delivery.drainTarget(c,receiver('003').adapter,{freshness:freshness(),limit:1});assert.equal((await state('OTHER-ONLINE-COPY')).state,'succeeded');
   await delivery.setTargetEnabled(c,targetId('005'),true);await delivery.drainTarget(c,receiver('005').adapter,{freshness:freshness(),limit:1});assert.equal((await state('PAUSE-COPY')).state,'succeeded');checks.push('per_target_pause_resume');
  });
  await t.test('leased work becoming review is superseded before any native delivery',async()=>{
   await add('004','REVIEW-LATER-COPY');const [leased]=await delivery.lease(c,{targetId:targetId('004'),freshness:freshness(),limit:1});await project('REVIEW-LATER-COPY','20','review');const native=receiver('004');const r=await delivery.drainTarget(c,native.adapter,{freshness:freshness(),limit:1});assert.equal(r.leased,0);assert.equal(native.adapter.calls,0);assert.equal((await state('REVIEW-LATER-COPY')).state,'superseded');assert.equal((await delivery.acknowledge(c,leased,ack(leased),identity('004'))).accepted,false);checks.push('later_projection_review_cancels_delivery');
  });
  await t.test('narrowing the pilot also fences older pending jobs outside the lease allowlist',async()=>{
   await add('005','AR005-000031');await add('005','AR005-000032');const native=receiver('005');
   const first=await delivery.drainTarget(c,native.adapter,{freshness:freshness(),limit:10,codes:['AR005-000031']});assert.equal(first.leased,1);assert.equal((await state('AR005-000031')).state,'succeeded');assert.equal((await state('AR005-000032')).state,'queued');assert.equal(native.corrections.length,1);
   const next=await delivery.drainTarget(c,native.adapter,{freshness:freshness(),limit:10});assert.equal(next.leased,1);assert.equal((await state('AR005-000032')).state,'succeeded');checks.push('pilot_lease_allowlist_fences_existing_backlog');
  });
  await t.test('history, operation identity and target identity cannot be erased or rewritten',async()=>{
   await assert.rejects(c.query('DELETE FROM ada_points.delivery_jobs WHERE id=(SELECT min(id) FROM ada_points.delivery_jobs)'),/HISTORY_IS_APPEND_ONLY/);
   await assert.rejects(c.query("UPDATE ada_points.delivery_audit SET code='ERASED' WHERE id=(SELECT min(id) FROM ada_points.delivery_audit)"),/HISTORY_IS_APPEND_ONLY/);
   await assert.rejects(c.query("UPDATE ada_points.delivery_jobs SET target_balance=999 WHERE id=(SELECT min(id) FROM ada_points.delivery_jobs)"),/JOB_IDENTITY_IMMUTABLE/);
   await assert.rejects(c.query("UPDATE ada_points.delivery_targets SET database_identity='other' WHERE target_id=$1",[targetId('000')]),/TARGET_IDENTITY_IMMUTABLE/);checks.push('append_only_audit_and_immutable_identities');
  });
  await t.test('a runtime reader without policies sees no queue and anonymous clients have no access',async()=>{
   const role='point_delivery_copy_reader_'+crypto.randomBytes(4).toString('hex');await c.query(`CREATE ROLE "${role}" NOLOGIN;GRANT USAGE ON SCHEMA ada_points TO "${role}";GRANT SELECT ON ada_points.delivery_jobs TO "${role}"`);
   await c.query(`SET ROLE "${role}"`);try{assert.equal((await c.query('SELECT count(*)::int n FROM ada_points.delivery_jobs')).rows[0].n,0);await assert.rejects(c.query('SELECT * FROM ada_points.delivery_audit'),e=>e.code==='42501');}finally{await c.query('RESET ROLE');}
   const rls=(await c.query("SELECT relrowsecurity FROM pg_class WHERE relnamespace='ada_points'::regnamespace AND relname LIKE 'delivery_%' AND relkind='r'")).rows;assert.equal(rls.length,4);assert.ok(rls.every(r=>r.relrowsecurity));checks.push('private_queue_rls');
  });
  await t.test('original source customer and point fixtures remain unchanged, and status exposes only aggregate delivery metadata',async()=>{
   assert.deepEqual(await originals(),beforeOriginals);const result=await delivery.status(c);assert.ok(result.length>=5);for(const row of result)assert.deepEqual(Object.keys(row).sort(),['branch_code','enabled','jobs','next_attempt_at','oldest_queued_at','state','target_id','waiting_fresh_source'].sort());checks.push('source_immutability_and_aggregate_status');
  });
  assert.equal(checks.length,19,'do not emit a success report when any subtest failed');
  console.log(JSON.stringify({ok:true,scope:'LOCAL-POSTGRES-POINT-DELIVERY-COPY-ONLY',database,checks:checks.length,productionWrites:0,sqlServerWrites:0,pinRead:false}));
 }finally{if(pool)await pool.end().catch(()=>{});if(c)await c.end().catch(()=>{});await control.end();}
});
