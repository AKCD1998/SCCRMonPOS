'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {normalizeProfile,profileHash,hqCodeFor,confirmation,validateAck,isRetryable,retryDelayMs,safeCode,FanoutEngine}=require('./engine.cjs');
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
const profile={name:'สมาชิกจำลอง isolated fixture',phone:'0990000001',email:'fixture@example.invalid'};
function envelope(id=A){return {memberId:id,hqCode:hqCodeFor(id),profile:{...profile},hqConfirmedAt:'2026-10-29T03:00:00.000Z'};}
function job(id=A,target='branch005'){const e=confirmation(envelope(id));return {id:crypto.randomUUID(),target_id:target,database_identity:target+'/TEST-SQL/AdaAcc/owned-guid',member_id:e.memberId,hq_code:e.hqCode,profile:e.profile,profile_hash:e.profileHash,hq_created_at:e.hqCreatedAt,state:'pending',attempt_count:0};}
function ack(j,extra={}){return {memberId:j.member_id,hqCode:j.hq_code,adaCode:j.hq_code,targetIdentity:j.database_identity,profile:{...j.profile},profileHash:j.profile_hash,outcome:'created',...extra};}
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate){for(let n=0;n<100;n++){if(predicate())return;await pause(5);}throw Error('TEST_WAIT_EXCEEDED');}
// A stateful fake exercises scheduling, validation and receiver ack-loss. The
// PostgreSQL integration suite separately proves actual persistence and fencing.
class MemoryQueue{
 constructor(jobs){this.jobs=jobs;this.mappings=new Map();this.events=[];this.clock=0;this.nativeCalls=0;}
 async targets(){return [...new Set(this.jobs.map(x=>x.target_id))].map(target_id=>({target_id}));}
 async lease(target,owner,leaseMs){const j=this.jobs.find(x=>x.target_id===target&&(x.state==='pending'||(x.state==='retry'&&x.nextAttempt<=this.clock)||(x.state==='running'&&x.expires<=this.clock)));if(!j)return null;if(this.jobs.some(x=>x.target_id===target&&x.state==='running'&&x.expires>this.clock))return null;j.state='running';j.lease_token=crypto.randomUUID();j.lease_owner=owner;j.expires=this.clock+leaseMs;j.attempt_count++;return structuredClone(j);}
 owns(j){const stored=this.jobs.find(x=>x.id===j.id);return stored?.state==='running'&&stored.lease_token===j.lease_token?stored:null;}
 async succeeded(j,a){const stored=this.owns(j);if(!stored)return false;const receipt=validateAck(j,a);this.mappings.set(j.target_id+':'+j.member_id,receipt);stored.state='succeeded';this.events.push({member:j.member_id,state:'succeeded'});return true;}
 async failed(j,e){const stored=this.owns(j);if(!stored)return false;const code=safeCode(e);stored.state=isRetryable(code)?'retry':'review';stored.last_code=code;stored.nextAttempt=this.clock+retryDelayMs(stored.attempt_count);this.events.push({member:j.member_id,state:stored.state,code});return true;}
}
test('canonical fingerprint accepts only explicit non-secret profile fields',()=>{
 assert.deepEqual(normalizeProfile({...profile,name:'  '+profile.name+'  ',email:' FIXTURE@EXAMPLE.INVALID '}),profile);
 assert.equal(profileHash(profile),profileHash({phone:profile.phone,email:profile.email,name:profile.name}));
 assert.equal(profileHash(profile),profileHash({...profile,email:' FIXTURE@EXAMPLE.INVALID '}));
 for(const changed of [{...profile,phone:'0990000002'},{...profile,name:'Another person'},{...profile,email:'other@example.invalid'}])assert.notEqual(profileHash(changed),profileHash(profile));
 for(const value of [{...profile,pin:'forbidden'},{...profile,password:'forbidden'},{...profile,phone:997},{...profile,name:''},{...profile,phone:'+66990000001'},null])assert.throws(()=>normalizeProfile(value));
});
test('only a full UUID and its owned HQ SC code can create a queue envelope',()=>{
 assert.equal(hqCodeFor(A),'SC-1111111111114111');assert.equal(confirmation(envelope(A)).memberId,A);
 assert.throws(()=>confirmation({...envelope(A),hqCode:'AR005-000031'}),/HQ_NATIVE_CODE_REFUSED/);
 assert.throws(()=>confirmation({...envelope(A),hqCode:hqCodeFor(B)}),/HQ_NATIVE_CODE_REFUSED/);
 assert.throws(()=>hqCodeFor('11111111'),/MEMBER_ID_REFUSED/);
});
test('source commit times must be explicit, timezone-aware and preserved',()=>{
 assert.equal(confirmation({...envelope(),hqConfirmedAt:'2026-10-29T10:00:00+07:00'}).hqCreatedAt,'2026-10-29T03:00:00.000Z');
 for(const value of ['',null,0,'2026-10-29T10:00:00','yesterday'])assert.throws(()=>confirmation({...envelope(),hqConfirmedAt:value}),/HQ_COMMIT_TIME_REQUIRED/);
});
test('ack requires the exact member, HQ code, target database, native code and actual profile',()=>{
 const j=job();assert.equal(validateAck(j,ack(j)).memberId,A);
 for(const change of [{memberId:B},{hqCode:hqCodeFor(B)},{adaCode:'AR001-000090'},{targetIdentity:'another/SQL/AdaAcc'},{profileHash:'f'.repeat(64)},{profile:{...profile,name:'Different person'}},{outcome:'matched_by_phone'}])assert.throws(()=>validateAck(j,ack(j,change)));
});
test('transport errors retry with bounded backoff; collisions and unknown failures do not loop',()=>{
 for(const code of ['ECONNRESET','TARGET_OFFLINE','MEMBER_CREATE_BUSY','SQL_LOCK_TIMEOUT','DELIVERY_TIMEOUT','SERVICE_STOPPING'])assert.equal(isRetryable(code),true);
 for(const code of ['PHONE_DUPLICATE_REVIEW','CUSTOMER_CODE_COLLISION_REVIEW','NAME_MISMATCH','ACK_IDENTITY_MISMATCH','SCHEMA_MISMATCH','UNCLASSIFIED_TARGET_ERROR'])assert.equal(isRetryable(code),false);
 assert.equal(retryDelayMs(1),1000);assert.ok(retryDelayMs(500)<=300000);
 assert.equal(safeCode(Error('secret: user@example.invalid')),'UNCLASSIFIED_TARGET_ERROR');
});
test('one valid receipt completes exactly one mapping without modifying unrelated originals',async()=>{
 const j=job(),q=new MemoryQueue([j]);const originals=[{code:'AR005-000031',name:'Existing customer',points:12}];const before=JSON.stringify(originals);
 const e=new FanoutEngine({queue:q,adapters:{branch005:{async receive(x){q.nativeCalls++;return ack(x);}}}});
 await e.tick();await until(()=>j.state==='succeeded');await e.tick();await until(()=>e.inFlight.size===0);
 assert.equal(q.nativeCalls,1);assert.equal(q.mappings.size,1);assert.equal(JSON.stringify(originals),before);await e.stop();
});
test('lost acknowledgement is replayed after restart against the same identity without a second native row',async()=>{
 const j=job(),q=new MemoryQueue([j]),native=new Map();let count=0;
 const receiver={async receive(x){count++;if(!native.has(x.member_id)){native.set(x.member_id,ack(x));throw Object.assign(Error('ECONNRESET'),{code:'ECONNRESET'});}return {...native.get(x.member_id),outcome:'already_delivered'};}};
 const first=new FanoutEngine({queue:q,adapters:{branch005:receiver}});await first.tick();await until(()=>j.state==='retry');await first.stop();
 q.clock=1001;const second=new FanoutEngine({queue:q,adapters:{branch005:receiver}});await second.tick();await until(()=>j.state==='succeeded');
 assert.equal(count,2);assert.equal(native.size,1);assert.equal(q.mappings.size,1);assert.equal(q.mappings.get('branch005:'+A).adaCode,hqCodeFor(A));await second.stop();
});
test('offline target never blocks another target, and online recovery keeps its member',async()=>{
 const offline=job(A,'branch001'),healthy=job(B,'branch005'),q=new MemoryQueue([offline,healthy]);let online=false;
 const receiver={async receive(x){if(!online)throw Object.assign(Error('TARGET_OFFLINE'),{code:'TARGET_OFFLINE'});return ack(x);}};
 const e=new FanoutEngine({queue:q,adapters:{branch001:receiver,branch005:{async receive(x){return ack(x);}}}});
 await e.tick();await until(()=>offline.state==='retry'&&healthy.state==='succeeded');assert.equal(q.mappings.size,1);
 online=true;q.clock=1001;await e.tick();await until(()=>offline.state==='succeeded');assert.equal(q.mappings.size,2);await e.stop();
});
test('code, phone and profile collision responses each stop for review with no mapping',async()=>{
 for(const code of ['CUSTOMER_CODE_COLLISION_REVIEW','EXISTING_CUSTOMER_REVIEW_REQUIRED','NATIVE_PROFILE_MISMATCH']){
  const j=job(),q=new MemoryQueue([j]);let calls=0;const e=new FanoutEngine({queue:q,adapters:{branch005:{async receive(){calls++;throw Object.assign(Error(code),{code});}}}});
  await e.tick();await until(()=>j.state==='review');for(let i=0;i<3;i++){q.clock+=1000000;await e.tick();await pause(1);}assert.equal(calls,1);assert.equal(q.mappings.size,0);assert.equal(j.last_code,code);await e.stop();
 }
});
test('tampered target ack is held, never mapped to another member',async()=>{
 const j=job(),q=new MemoryQueue([j]);const e=new FanoutEngine({queue:q,adapters:{branch005:{async receive(x){return ack(x,{memberId:B});}}}});
 await e.tick();await until(()=>j.state==='review');assert.equal(j.last_code,'ACK_IDENTITY_MISMATCH');assert.equal(q.mappings.size,0);await e.stop();
});
test('expired running lease can resume in a new service instance and stale completion cannot win',async()=>{
 const j=job(),q=new MemoryQueue([j]);const old=await q.lease('branch005',crypto.randomUUID(),2000);q.clock=2001;
 const e=new FanoutEngine({queue:q,adapters:{branch005:{async receive(x){return ack(x);}}}});await e.tick();await until(()=>j.state==='succeeded');
 assert.equal(await q.succeeded(old,ack(old)),false);assert.equal(j.attempt_count,2);assert.equal(q.mappings.size,1);await e.stop();
});
test('a receiver ignoring cancellation reserves only its own slot; healthy targets continue',async()=>{
 const a=job(A,'branch001'),b=job(B,'branch005'),q=new MemoryQueue([a,b]);let finish,calls=0;
 const e=new FanoutEngine({queue:q,timeoutMs:20,leaseMs:2000,adapters:{branch001:{async receive(x){calls++;return new Promise(resolve=>{finish=()=>resolve(ack(x));});}},branch005:{async receive(x){return ack(x);}}}});
 await e.tick();await until(()=>a.state==='retry'&&b.state==='succeeded');await e.tick();assert.equal(calls,1);assert.ok(e.inFlight.has('branch001'));finish();await until(()=>!e.inFlight.has('branch001'));await e.stop();
});
test('service stop aborts transport and preserves retry rather than leaving a review',async()=>{
 const j=job(),q=new MemoryQueue([j]);const e=new FanoutEngine({queue:q,adapters:{branch005:{async receive(x,{signal}){return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true}));}}}});
 await e.tick();await until(()=>j.state==='running');await pause(1);await e.stop({waitMs:100});assert.equal(j.state,'retry');assert.equal(j.last_code,'SERVICE_STOPPING');
});
