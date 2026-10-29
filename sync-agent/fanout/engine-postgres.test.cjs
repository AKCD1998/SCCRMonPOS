'use strict';
// Opt-in, fresh LOCAL PostgreSQL database only. The destination table here is a
// receiver simulator; actual Ada SQL-copy acceptance is a separate integration.
const {test,describe,before,after}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {Pool,Client}=require('pg');
const {PgQueue,FanoutEngine,hqCodeFor,profileHash}=require('./engine.cjs');
const raw=process.env.SCCRM_FANOUT_TEST_DATABASE_URL;
describe('fanout durable queue with real isolated PostgreSQL',{skip:!raw},()=>{
 let admin,pool,q,role,rolePassword,beforeHash;let index=0;
 const prefix='fanout_test_'+crypto.randomBytes(5).toString('hex');
 function fixture(){const n=++index,id=n.toString(16).padStart(8,'0')+'-0000-4000-8000-000000000000';return {memberId:id,hqCode:hqCodeFor(id),profile:{name:'Synthetic member fixture '+n,phone:'099'+String(n).padStart(7,'0'),email:'fixture'+n+'@example.invalid'},hqConfirmedAt:new Date(Date.now()+n).toISOString()};}
 async function row(id){return (await admin.query('SELECT * FROM sccrm_fanout.jobs WHERE member_id=$1 ORDER BY target_id',[id])).rows;}
 async function ready(predicate){for(let n=0;n<200;n++){if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('QUEUE_TEST_WAIT_EXCEEDED');}
 function poolForRole(){const u=new URL(raw);u.username=role;u.password=rolePassword;return new Pool({connectionString:u.href,ssl:false,max:4,connectionTimeoutMillis:3000,query_timeout:5000,application_name:'SCCRM-Fanout-Queue-Copy-Tests'});}
 async function target(id,branch,enabled=true){await admin.query('INSERT INTO sccrm_fanout.targets(target_id,database_identity,branch_code,enabled) VALUES($1,$2,$3,$4)',[id,id+'/COPY-SQL/AdaAcc/'+crypto.randomUUID(),branch,enabled]);}
 function receiver({ackLoss=false,offline=false}={}){let lose=ackLoss;return {async receive(j){
  if(offline)throw Object.assign(Error('TARGET_OFFLINE'),{code:'TARGET_OFFLINE'});
  const existing=(await admin.query('SELECT * FROM public.test_native_members WHERE target_id=$1 AND member_id=$2',[j.target_id,j.member_id])).rows[0];
  if(existing){assert.equal(existing.ada_code,j.hq_code);if(profileHash(existing.profile)!==j.profile_hash)throw Error('NATIVE_PROFILE_MISMATCH');return {memberId:j.member_id,hqCode:j.hq_code,adaCode:existing.ada_code,targetIdentity:j.database_identity,profile:existing.profile,profileHash:profileHash(existing.profile),outcome:'already_delivered'};}
  if((await admin.query('SELECT 1 FROM public.test_native_members WHERE target_id=$1 AND ada_code=$2',[j.target_id,j.hq_code])).rowCount)throw Error('CUSTOMER_CODE_COLLISION_REVIEW');
  if((await admin.query("SELECT 1 FROM public.test_native_members WHERE target_id=$1 AND profile->>'phone'=$2",[j.target_id,j.profile.phone])).rowCount)throw Error('EXISTING_CUSTOMER_REVIEW_REQUIRED');
  await admin.query('INSERT INTO public.test_native_members(target_id,member_id,ada_code,profile) VALUES($1,$2,$3,$4::jsonb)',[j.target_id,j.member_id,j.hq_code,JSON.stringify(j.profile)]);
  if(lose){lose=false;throw Object.assign(Error('ECONNRESET'),{code:'ECONNRESET'});}
  return {memberId:j.member_id,hqCode:j.hq_code,adaCode:j.hq_code,targetIdentity:j.database_identity,profile:j.profile,profileHash:profileHash(j.profile),outcome:'created'};
 }};}
 before(async()=>{
  const u=new URL(raw);assert.ok(['127.0.0.1','localhost','[::1]'].includes(u.hostname),'Local DB required');assert.match(u.pathname,/^\/sccrm_fanout_test_[a-z0-9_]+$/);assert.ok(u.port&&u.port!=='5432','Explicit private test port required');
  admin=new Client({connectionString:raw,ssl:false,connectionTimeoutMillis:3000,query_timeout:10000});await admin.connect();
  assert.equal((await admin.query("SELECT to_regnamespace('sccrm_fanout') n")).rows[0].n,null,'Fresh empty fanout schema required');
  await admin.query(fs.readFileSync(path.join(__dirname,'schema.sql'),'utf8'));await admin.query(fs.readFileSync(path.join(__dirname,'schema.sql'),'utf8'));
  await admin.query('CREATE TABLE public.original_customers(code text PRIMARY KEY,name text,phone text,points integer); CREATE TABLE public.test_native_members(target_id text,member_id uuid,ada_code text,profile jsonb,PRIMARY KEY(target_id,member_id),UNIQUE(target_id,ada_code))');
  await admin.query("INSERT INTO public.original_customers SELECT 'AR-COPY-'||i,'Original fixture '||i,'099999'||lpad(i::text,4,'0'),i FROM generate_series(1,11) i");
  beforeHash=crypto.createHash('sha256').update(JSON.stringify((await admin.query('SELECT * FROM public.original_customers ORDER BY code')).rows)).digest('hex');
  role=prefix;rolePassword=crypto.randomBytes(24).toString('hex');assert.match(rolePassword,/^[a-f0-9]{48}$/);await admin.query('CREATE ROLE '+role+" LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE CONNECTION LIMIT 6 PASSWORD '"+rolePassword+"'");
  await admin.query('GRANT USAGE ON SCHEMA sccrm_fanout TO '+role+'; GRANT SELECT ON ALL TABLES IN SCHEMA sccrm_fanout TO '+role+'; GRANT USAGE ON ALL SEQUENCES IN SCHEMA sccrm_fanout TO '+role);
  await admin.query('GRANT INSERT ON sccrm_fanout.sources,sccrm_fanout.jobs,sccrm_fanout.mappings,sccrm_fanout.events TO '+role);
  await admin.query('GRANT UPDATE(state,last_code,observed_conflict_hash) ON sccrm_fanout.sources TO '+role+'; GRANT UPDATE(created_at,member_id,updated_at) ON sccrm_fanout.source_checkpoint TO '+role+'; GRANT UPDATE(lease_token,lease_owner,lease_until) ON sccrm_fanout.targets TO '+role);
  await admin.query('GRANT UPDATE(state,attempt_count,next_attempt_at,lease_token,lease_owner,lease_until,last_code,observed_conflict_hash,updated_at,completed_at) ON sccrm_fanout.jobs TO '+role);
  for(const t of ['meta','targets','sources','source_checkpoint','jobs','mappings','events'])await admin.query('CREATE POLICY '+prefix+' ON sccrm_fanout.'+t+' TO '+role+' USING(true) WITH CHECK(true)');
  pool=poolForRole();q=new PgQueue(pool);await q.guard();
 });
 after(async()=>{if(pool)await pool.end();if(admin)await admin.end();});
 let initial;
 test('disabled target stores the source, cursor cannot advance past unpersisted source',async()=>{
  await target('branch005','005',false);initial=fixture();assert.equal(await q.getSourceCheckpoint(),null);
  await assert.rejects(q.advanceSourceCheckpoint({createdAt:initial.hqConfirmedAt,memberId:initial.memberId}),/SOURCE_CURSOR_NOT_ENQUEUED/);
  assert.deepEqual(await q.enqueueConfirmed(initial),[]);assert.equal((await admin.query('SELECT count(*)::int n FROM sccrm_fanout.sources')).rows[0].n,1);
  assert.equal(await q.advanceSourceCheckpoint({createdAt:initial.hqConfirmedAt,memberId:initial.memberId}),true);
  assert.deepEqual(await q.getSourceCheckpoint(),{createdAt:initial.hqConfirmedAt,memberId:initial.memberId});
 });
 test('enabling a new branch catches up persisted sources once without a cursor reset',async()=>{
  await admin.query("UPDATE sccrm_fanout.targets SET enabled=true WHERE target_id='branch005'");assert.equal((await q.enqueueExistingForTarget('branch005')).length,1);assert.equal((await q.enqueueExistingForTarget('branch005')).length,0);
  const e=new FanoutEngine({queue:q,adapters:{branch005:receiver()}});await e.tick();await ready(async()=>(await row(initial.memberId))[0].state==='succeeded');await e.stop();
  const receipts=await Promise.all(Array.from({length:12},()=>q.enqueueConfirmed(initial)));assert.ok(receipts.every(x=>x[0].id===receipts[0][0].id));
  assert.equal((await row(initial.memberId)).length,1);assert.equal((await admin.query('SELECT count(*)::int n FROM sccrm_fanout.mappings')).rows[0].n,1);
  assert.equal((await q.getSourceCheckpoint()).memberId,initial.memberId);
 });
 test('known synthetic source is held, survives cursor advancement, and is never in branch catchup',async()=>{
  const synthetic=fixture();assert.deepEqual(await q.holdConfirmed(synthetic,'SYNTHETIC_SOURCE_FIXTURE_HELD'),[]);
  assert.equal(await q.advanceSourceCheckpoint({createdAt:synthetic.hqConfirmedAt,memberId:synthetic.memberId}),true);assert.equal((await q.enqueueExistingForTarget('branch005')).length,0);
  assert.equal((await row(synthetic.memberId)).length,0);assert.ok((await q.sourceStatus()).some(x=>x.last_code==='SYNTHETIC_SOURCE_FIXTURE_HELD'));
  assert.equal(await q.advanceSourceCheckpoint({createdAt:initial.hqConfirmedAt,memberId:initial.memberId}),false,'Cursor never moves backward');
 });
 test('two competing service instances cannot concurrently lease a database or acknowledge an old lease',async()=>{
  const m=fixture();await q.enqueueConfirmed(m,['branch005']);const owner=crypto.randomUUID();const leased=await q.lease('branch005',owner,2000);assert.equal(leased.member_id,m.memberId);
  assert.equal(await q.lease('branch005',crypto.randomUUID(),2000),null);
  await admin.query("UPDATE sccrm_fanout.targets SET lease_until=now()-interval '1 second' WHERE target_id='branch005'; UPDATE sccrm_fanout.jobs SET lease_until=now()-interval '1 second' WHERE state='running'");
  const next=await q.lease('branch005',crypto.randomUUID(),2000);assert.equal(next.id,leased.id);assert.notEqual(next.lease_token,leased.lease_token);assert.equal(next.attempt_count,2);
  const r=receiver();assert.equal(await q.succeeded(leased,await r.receive(leased)),false);assert.equal(await q.succeeded(next,await r.receive(next)),true);
  assert.equal((await admin.query('SELECT count(*)::int n FROM public.test_native_members WHERE member_id=$1',[m.memberId])).rows[0].n,1);
 });
 test('native commit with lost acknowledgement survives fresh queue connections and service restart without duplicate',async()=>{
  const m=fixture(),r=receiver({ackLoss:true});await q.enqueueConfirmed(m,['branch005']);const one=new FanoutEngine({queue:q,adapters:{branch005:r}});await one.tick();await ready(async()=>(await row(m.memberId))[0].state==='retry');await one.stop();
  assert.equal((await admin.query('SELECT count(*)::int n FROM public.test_native_members WHERE member_id=$1',[m.memberId])).rows[0].n,1);
  await pool.end();pool=poolForRole();q=new PgQueue(pool);await q.guard();await admin.query("UPDATE sccrm_fanout.jobs SET next_attempt_at=now() WHERE member_id=$1",[m.memberId]);
  const two=new FanoutEngine({queue:q,adapters:{branch005:r}});await two.tick();await ready(async()=>(await row(m.memberId))[0].state==='succeeded');await two.stop();
  assert.equal((await row(m.memberId))[0].attempt_count,2);assert.equal((await admin.query('SELECT count(*)::int n FROM public.test_native_members WHERE member_id=$1',[m.memberId])).rows[0].n,1);assert.equal((await admin.query('SELECT count(*)::int n FROM sccrm_fanout.mappings WHERE member_id=$1',[m.memberId])).rows[0].n,1);
 });
 test('offline branch retains durable retry, healthy branch succeeds, and reconnect maps the correct member',async()=>{
  await target('branch001','001');const m=fixture();await q.enqueueConfirmed(m);let online=false;const live=receiver();const one=new FanoutEngine({queue:q,adapters:{branch005:live,branch001:{async receive(j){return (online?live:receiver({offline:true})).receive(j);}}}});
  await one.tick();await ready(async()=>{const r=await row(m.memberId);return r.some(x=>x.target_id==='branch001'&&x.state==='retry')&&r.some(x=>x.target_id==='branch005'&&x.state==='succeeded');});
  online=true;await admin.query("UPDATE sccrm_fanout.jobs SET next_attempt_at=now() WHERE member_id=$1 AND target_id='branch001'",[m.memberId]);await one.tick();await ready(async()=>(await row(m.memberId)).every(x=>x.state==='succeeded'));await one.stop();
  const r=(await admin.query('SELECT member_id,ada_code FROM sccrm_fanout.mappings WHERE member_id=$1',[m.memberId])).rows;assert.equal(r.length,2);assert.ok(r.every(x=>x.member_id===m.memberId&&x.ada_code===m.hqCode));
 });
 test('code and telephone conflicts are held with no overwrite, no auto merge and no repeated attempts',async()=>{
  for(const kind of ['code','phone']){
   const m=fixture(),original=fixture();const originalProfile=kind==='phone'?{...original.profile,phone:m.profile.phone}:original.profile;
   await admin.query('INSERT INTO public.test_native_members(target_id,member_id,ada_code,profile) VALUES($1,$2,$3,$4::jsonb)',['branch005',original.memberId,kind==='code'?m.hqCode:original.hqCode,JSON.stringify(originalProfile)]);
   const before=(await admin.query('SELECT * FROM public.test_native_members WHERE member_id=$1',[original.memberId])).rows;await q.enqueueConfirmed(m,['branch005']);const e=new FanoutEngine({queue:q,adapters:{branch005:receiver()}});await e.tick();await ready(async()=>(await row(m.memberId))[0].state==='review');await e.tick();await e.stop();
   assert.equal((await row(m.memberId))[0].attempt_count,1);assert.equal((await admin.query('SELECT count(*)::int n FROM sccrm_fanout.mappings WHERE member_id=$1',[m.memberId])).rows[0].n,0);assert.deepEqual((await admin.query('SELECT * FROM public.test_native_members WHERE member_id=$1',[original.memberId])).rows,before);
  }
 });
 test('immutable source profile changes hold future delivery while keeping the original envelope and mapping',async()=>{
  const original=(await admin.query('SELECT * FROM sccrm_fanout.mappings WHERE member_id=$1',[initial.memberId])).rows;
  await q.enqueueConfirmed({...initial,profile:{...initial.profile,name:'Changed source person'}});assert.equal((await row(initial.memberId))[0].state,'review');
  assert.equal((await admin.query('SELECT profile FROM sccrm_fanout.sources WHERE member_id=$1',[initial.memberId])).rows[0].profile.name,initial.profile.name);
  assert.deepEqual((await admin.query('SELECT * FROM sccrm_fanout.mappings WHERE member_id=$1',[initial.memberId])).rows,original);
  await target('laterBranch','003');await q.enqueueExistingForTarget('laterBranch');assert.equal((await admin.query("SELECT count(*)::int n FROM sccrm_fanout.jobs WHERE member_id=$1 AND target_id='laterBranch'",[initial.memberId])).rows[0].n,0);
 });
 test('runtime cannot edit target identity, payload, native originals, protected marker or delete queue history',async()=>{
  const forbidden=["UPDATE sccrm_fanout.targets SET enabled=false", "UPDATE sccrm_fanout.targets SET database_identity='elsewhere'", "UPDATE sccrm_fanout.jobs SET profile='{}'", "UPDATE sccrm_fanout.sources SET profile='{}'",'DELETE FROM sccrm_fanout.jobs','DELETE FROM sccrm_fanout.mappings','UPDATE public.original_customers SET points=0','SELECT * FROM public.original_customers','UPDATE sccrm_fanout.meta SET schema_version=2'];
  for(const sql of forbidden)await assert.rejects(pool.query(sql),e=>e.code==='42501');
  const afterHash=crypto.createHash('sha256').update(JSON.stringify((await admin.query('SELECT * FROM public.original_customers ORDER BY code')).rows)).digest('hex');assert.equal(afterHash,beforeHash);
  assert.ok((await q.status()).some(x=>x.review>0));
 });
});
