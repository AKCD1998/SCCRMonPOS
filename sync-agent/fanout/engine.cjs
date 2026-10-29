'use strict';
const crypto=require('node:crypto');
const MARKER='936590f2-023e-46a0-b4c8-e64c1fe8cf7d',SCOPE='SCCRM-HQ-BRANCH-FANOUT-V1';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
class ReviewError extends Error{constructor(code){super(code);this.code=code;}}
function requireValue(ok,code){if(!ok)throw new ReviewError(code);}
function normalizeProfile(raw){
 requireValue(raw&&typeof raw==='object'&&!Array.isArray(raw)&&Object.keys(raw).sort().join(',')==='email,name,phone','PROFILE_FIELDS_REFUSED');
 requireValue(Object.values(raw).every(x=>typeof x==='string'),'PROFILE_FIELDS_REFUSED');
 const profile={name:raw.name.normalize('NFC').trim(),phone:raw.phone.trim(),email:raw.email.trim().toLowerCase()};
 requireValue(profile.name.length>0&&profile.name.length<=200&&/^0\d{9}$/.test(profile.phone)&&profile.email.length<=100,'PROFILE_NOT_REPRESENTABLE');return profile;
}
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
function profileHash(raw){const p=normalizeProfile(raw);return digest(JSON.stringify({email:p.email,name:p.name,phone:p.phone}));}
function hqCodeFor(memberId){requireValue(typeof memberId==='string'&&UUID.test(memberId),'MEMBER_ID_REFUSED');return 'SC-'+memberId.replaceAll('-','').slice(0,16).toUpperCase();}
function confirmation(raw){
 requireValue(raw&&typeof raw==='object','HQ_CONFIRMATION_REQUIRED');const memberId=String(raw.memberId||'').toLowerCase();
 requireValue(raw.hqCode===hqCodeFor(memberId),'HQ_NATIVE_CODE_REFUSED');const profile=normalizeProfile(raw.profile);
 requireValue(raw.hqConfirmedAt instanceof Date||(typeof raw.hqConfirmedAt==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?(?:Z|[+-]\d{2}:\d{2})$/.test(raw.hqConfirmedAt)),'HQ_COMMIT_TIME_REQUIRED');
 const hqCreatedAt=new Date(raw.hqConfirmedAt);requireValue(Number.isFinite(hqCreatedAt.getTime()),'HQ_COMMIT_TIME_REQUIRED');
 return {memberId,hqCode:raw.hqCode,profile,profileHash:profileHash(profile),hqCreatedAt:hqCreatedAt.toISOString()};
}
function safeCode(error){const code=error?.code||error?.message;return typeof code==='string'&&/^[A-Z][A-Z0-9_]{2,79}$/.test(code)?code:'UNCLASSIFIED_TARGET_ERROR';}
function isRetryable(code){return /^(?:ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EPIPE|ETIMEOUT|ESOCKET|SQL_TIMEOUT|SQL_LOCK_TIMEOUT|TARGET_OFFLINE|TARGET_BUSY|MEMBER_CREATE_BUSY|CONNECTION_FAILED|CONNECTION_CLOSED|RPC_TIMEOUT|RPC_PROCESS_ENDED|SOURCE_TIMEOUT|SOURCE_PROCESS_ENDED|DELIVERY_TIMEOUT|SERVICE_STOPPING)$/.test(code);}
function retryDelayMs(attempt){return Math.min(300000,1000*2**Math.min(8,Math.max(0,Number(attempt)-1)));}
function validateAck(job,ack){
 requireValue(ack&&typeof ack==='object','ACK_REQUIRED');
 requireValue(String(ack.memberId||'').toLowerCase()===job.member_id&&ack.hqCode===job.hq_code&&ack.adaCode===job.hq_code&&ack.targetIdentity===job.database_identity,'ACK_IDENTITY_MISMATCH');
 requireValue(['created','already_delivered','existing_mapped'].includes(ack.outcome),'ACK_OUTCOME_REFUSED');
 requireValue(ack.profileHash===job.profile_hash&&profileHash(ack.profile)===job.profile_hash,'ACK_PROFILE_MISMATCH');
 return {memberId:job.member_id,hqCode:job.hq_code,adaCode:ack.adaCode,targetIdentity:job.database_identity,profileHash:job.profile_hash,outcome:ack.outcome};
}
function validateJob(job){requireValue(job&&job.hq_code===hqCodeFor(job.member_id)&&typeof job.database_identity==='string'&&job.database_identity.length>0&&job.database_identity.length<=512&&profileHash(job.profile)===job.profile_hash,'JOB_PAYLOAD_MISMATCH');return job;}
class PgQueue{
 constructor(pool){requireValue(pool&&typeof pool.connect==='function'&&typeof pool.query==='function','PG_POOL_REQUIRED');this.pool=pool;}
 async tx(fn){const c=await this.pool.connect();requireValue(c&&typeof c.release==='function','DEDICATED_PG_POOL_REQUIRED');try{await c.query('BEGIN');const answer=await fn(c);await c.query('COMMIT');return answer;}catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}}
 async guard(){const r=await this.pool.query('SELECT marker,scope,schema_version FROM sccrm_fanout.meta');requireValue(r.rows.length===1&&r.rows[0].marker===MARKER&&r.rows[0].scope===SCOPE&&r.rows[0].schema_version===1,'FANOUT_SCHEMA_NOT_OWNED');}
 async targets(){return (await this.pool.query('SELECT target_id,database_identity,branch_code FROM sccrm_fanout.targets WHERE enabled=true ORDER BY target_id')).rows;}
 async _enqueueJob(c,target,m){
  const key=digest(JSON.stringify([SCOPE,target.database_identity,m.memberId]));
  const inserted=await c.query(`INSERT INTO sccrm_fanout.jobs(target_id,member_id,hq_code,profile,profile_hash,idempotency_key,hq_created_at) VALUES($1,$2,$3,$4::jsonb,$5,$6,$7) ON CONFLICT(target_id,member_id) DO NOTHING RETURNING *`,[target.target_id,m.memberId,m.hqCode,JSON.stringify(m.profile),m.profileHash,key,m.hqCreatedAt]);
  if(inserted.rowCount){const job=inserted.rows[0];await c.query("INSERT INTO sccrm_fanout.events(job_id,attempt,state,code) VALUES($1,0,'pending','HQ_CREATE_CONFIRMED')",[job.id]);return job;}
  const job=(await c.query('SELECT * FROM sccrm_fanout.jobs WHERE target_id=$1 AND member_id=$2 FOR UPDATE',[target.target_id,m.memberId])).rows[0];
  if(job.hq_code!==m.hqCode||job.profile_hash!==m.profileHash||job.idempotency_key!==key||new Date(job.hq_created_at).getTime()!==new Date(m.hqCreatedAt).getTime()){
   if(job.observed_conflict_hash!==m.profileHash){await c.query("UPDATE sccrm_fanout.jobs SET state='review',last_code='SOURCE_PROFILE_CHANGED',observed_conflict_hash=$2,lease_token=NULL,lease_owner=NULL,lease_until=NULL,updated_at=now() WHERE id=$1",[job.id,m.profileHash]);await c.query("INSERT INTO sccrm_fanout.events(job_id,attempt,state,code) VALUES($1,$2,'review','SOURCE_PROFILE_CHANGED')",[job.id,job.attempt_count]);}
   job.state='review';job.last_code='SOURCE_PROFILE_CHANGED';
  }
  return job;
 }
 async holdConfirmed(raw,reason){requireValue(typeof reason==='string'&&/^[A-Z][A-Z0-9_]{2,79}$/.test(reason),'HOLD_REASON_REFUSED');return this.enqueueConfirmed(raw,[],{holdReason:reason});}
 async enqueueConfirmed(raw,targetIds,{holdReason}={}){
  const m=confirmation(raw);if(targetIds!==undefined)requireValue(Array.isArray(targetIds)&&targetIds.length<=100&&targetIds.every(x=>typeof x==='string'&&x.length<=100),'TARGET_SCOPE_REFUSED');
  if(holdReason!==undefined)requireValue(typeof holdReason==='string'&&/^[A-Z][A-Z0-9_]{2,79}$/.test(holdReason),'HOLD_REASON_REFUSED');
  return this.tx(async c=>{
   await c.query('INSERT INTO sccrm_fanout.sources(member_id,hq_code,profile,profile_hash,hq_created_at) VALUES($1,$2,$3::jsonb,$4,$5) ON CONFLICT(member_id) DO NOTHING',[m.memberId,m.hqCode,JSON.stringify(m.profile),m.profileHash,m.hqCreatedAt]);
   const source=(await c.query('SELECT * FROM sccrm_fanout.sources WHERE member_id=$1 FOR UPDATE',[m.memberId])).rows[0];
   if(holdReason){await c.query("UPDATE sccrm_fanout.sources SET state='review',last_code=$2 WHERE member_id=$1",[m.memberId,holdReason]);await c.query("UPDATE sccrm_fanout.jobs SET state='review',last_code=$2,lease_token=NULL,lease_owner=NULL,lease_until=NULL,updated_at=now() WHERE member_id=$1 AND (state<>'review' OR last_code IS DISTINCT FROM $2)",[m.memberId,holdReason]);return (await c.query('SELECT * FROM sccrm_fanout.jobs WHERE member_id=$1 ORDER BY target_id',[m.memberId])).rows;}
   if(source.hq_code!==m.hqCode||source.profile_hash!==m.profileHash||new Date(source.hq_created_at).getTime()!==new Date(m.hqCreatedAt).getTime()){
    await c.query("UPDATE sccrm_fanout.sources SET state='review',last_code='SOURCE_PROFILE_CHANGED',observed_conflict_hash=$2 WHERE member_id=$1",[m.memberId,m.profileHash]);
    await c.query("UPDATE sccrm_fanout.jobs SET state='review',last_code='SOURCE_PROFILE_CHANGED',observed_conflict_hash=$2,lease_token=NULL,lease_owner=NULL,lease_until=NULL,updated_at=now() WHERE member_id=$1 AND (state<>'review' OR last_code IS DISTINCT FROM 'SOURCE_PROFILE_CHANGED')",[m.memberId,m.profileHash]);
    return (await c.query('SELECT * FROM sccrm_fanout.jobs WHERE member_id=$1 ORDER BY target_id',[m.memberId])).rows;
   }
   if(source.state!=='confirmed')return (await c.query('SELECT * FROM sccrm_fanout.jobs WHERE member_id=$1 ORDER BY target_id',[m.memberId])).rows;
   const targets=(await c.query('SELECT target_id,database_identity FROM sccrm_fanout.targets WHERE enabled=true AND ($1::text[] IS NULL OR target_id=ANY($1::text[])) ORDER BY target_id',[targetIds??null])).rows;const jobs=[];
   for(const target of targets)jobs.push(await this._enqueueJob(c,target,m));
   return jobs;
  });
 }
 async getSourceCheckpoint(){const r=(await this.pool.query('SELECT created_at,member_id FROM sccrm_fanout.source_checkpoint WHERE singleton=true')).rows[0];return r?.member_id?{createdAt:new Date(r.created_at).toISOString(),memberId:r.member_id}:null;}
 async advanceSourceCheckpoint({createdAt,memberId}){
  requireValue(UUID.test(memberId)&&Number.isFinite(new Date(createdAt).getTime()),'SOURCE_CURSOR_REFUSED');
  return this.tx(async c=>{
   const source=(await c.query('SELECT 1 FROM sccrm_fanout.sources WHERE member_id=$1 AND hq_created_at=$2',[memberId,createdAt])).rows[0];requireValue(source,'SOURCE_CURSOR_NOT_ENQUEUED');
   return (await c.query('UPDATE sccrm_fanout.source_checkpoint SET created_at=$1,member_id=$2,updated_at=now() WHERE singleton=true AND (created_at IS NULL OR (created_at,member_id)<($1::timestamptz,$2::uuid)) RETURNING member_id',[createdAt,memberId])).rowCount>0;
  });
 }
 async enqueueExistingForTarget(targetId,{limit=100}={}){
  requireValue(Number.isInteger(limit)&&limit>=1&&limit<=100,'CATCHUP_LIMIT_REFUSED');return this.tx(async c=>{
   const target=(await c.query('SELECT target_id,database_identity FROM sccrm_fanout.targets WHERE target_id=$1 AND enabled=true',[targetId])).rows[0];if(!target)return [];
   const sources=(await c.query("SELECT s.* FROM sccrm_fanout.sources s WHERE s.state='confirmed' AND NOT EXISTS(SELECT 1 FROM sccrm_fanout.jobs j WHERE j.target_id=$1 AND j.member_id=s.member_id) ORDER BY s.hq_created_at,s.member_id LIMIT $2 FOR KEY SHARE OF s SKIP LOCKED",[targetId,limit])).rows;const jobs=[];
   for(const s of sources)jobs.push(await this._enqueueJob(c,target,{memberId:s.member_id,hqCode:s.hq_code,profile:s.profile,profileHash:s.profile_hash,hqCreatedAt:new Date(s.hq_created_at).toISOString()}));return jobs;
  });
 }
 async sourceStatus(){return (await this.pool.query("SELECT state,last_code,count(*)::int count FROM sccrm_fanout.sources GROUP BY state,last_code ORDER BY state,last_code")).rows;}
 async lease(targetId,owner,leaseMs=15000){
  requireValue(UUID.test(owner)&&Number.isInteger(leaseMs)&&leaseMs>=2000&&leaseMs<=300000,'LEASE_SCOPE_REFUSED');
  return this.tx(async c=>{
   const target=(await c.query(`SELECT * FROM sccrm_fanout.targets WHERE target_id=$1 AND enabled=true AND (lease_until IS NULL OR lease_until<=now()) FOR UPDATE SKIP LOCKED`,[targetId])).rows[0];if(!target)return null;
   const job=(await c.query(`SELECT j.* FROM sccrm_fanout.jobs j JOIN sccrm_fanout.sources s ON s.member_id=j.member_id AND s.state='confirmed' WHERE j.target_id=$1 AND ((j.state IN('pending','retry') AND j.next_attempt_at<=now()) OR (j.state='running' AND j.lease_until<=now())) ORDER BY j.next_attempt_at,j.id LIMIT 1 FOR UPDATE OF j SKIP LOCKED`,[targetId])).rows[0];if(!job)return null;
   const token=crypto.randomUUID();await c.query("UPDATE sccrm_fanout.targets SET lease_token=$2,lease_owner=$3,lease_until=now()+$4::integer*interval '1 millisecond' WHERE target_id=$1",[targetId,token,owner,leaseMs]);
   const leased=(await c.query("UPDATE sccrm_fanout.jobs SET state='running',attempt_count=attempt_count+1,lease_token=$2,lease_owner=$3,lease_until=now()+$4::integer*interval '1 millisecond',updated_at=now() WHERE id=$1 RETURNING *",[job.id,token,owner,leaseMs])).rows[0];
   await c.query("INSERT INTO sccrm_fanout.events(job_id,attempt,state,code) VALUES($1,$2,'running','DELIVERY_STARTED')",[job.id,leased.attempt_count]);return {...leased,database_identity:target.database_identity,branch_code:target.branch_code};
  });
 }
 async settle(job,fn){return this.tx(async c=>{
  const target=(await c.query('SELECT target_id FROM sccrm_fanout.targets WHERE target_id=$1 AND lease_token=$2 FOR UPDATE',[job.target_id,job.lease_token])).rows[0];if(!target)return false;
  const owned=(await c.query("SELECT * FROM sccrm_fanout.jobs WHERE id=$1 AND state='running' AND lease_token=$2 FOR UPDATE",[job.id,job.lease_token])).rows[0];if(!owned)return false;
  await fn(c,owned);await c.query('UPDATE sccrm_fanout.targets SET lease_token=NULL,lease_owner=NULL,lease_until=NULL WHERE target_id=$1 AND lease_token=$2',[job.target_id,job.lease_token]);return true;
 });}
 async succeeded(job,ack){const receipt=validateAck(job,ack);return this.settle(job,async(c,owned)=>{
  // The target row is already locked by settle(). Mapping rows stay append-only
  // and therefore require no UPDATE privilege just to inspect them.
  const old=(await c.query('SELECT * FROM sccrm_fanout.mappings WHERE target_id=$1 AND (member_id=$2 OR ada_code=$3)',[job.target_id,job.member_id,receipt.adaCode])).rows;
  requireValue(old.every(x=>x.member_id===job.member_id&&x.hq_code===job.hq_code&&x.ada_code===receipt.adaCode&&x.database_identity===job.database_identity&&x.profile_hash===job.profile_hash),'MAPPING_IDENTITY_COLLISION');
  if(!old.length)await c.query('INSERT INTO sccrm_fanout.mappings(target_id,member_id,ada_code,hq_code,database_identity,profile_hash,native_receipt) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)',[job.target_id,job.member_id,receipt.adaCode,job.hq_code,job.database_identity,job.profile_hash,JSON.stringify(receipt)]);
  await c.query("UPDATE sccrm_fanout.jobs SET state='succeeded',lease_token=NULL,lease_owner=NULL,lease_until=NULL,last_code=NULL,completed_at=COALESCE(completed_at,now()),updated_at=now() WHERE id=$1",[owned.id]);
  await c.query("INSERT INTO sccrm_fanout.events(job_id,attempt,state,code) VALUES($1,$2,'succeeded','DELIVERY_ACK_VERIFIED')",[owned.id,owned.attempt_count]);
 });}
 async failed(job,error){const code=safeCode(error),retry=isRetryable(code),state=retry?'retry':'review';return this.settle(job,async(c,owned)=>{
  await c.query("UPDATE sccrm_fanout.jobs SET state=$2,last_code=$3,next_attempt_at=now()+$4::integer*interval '1 millisecond',lease_token=NULL,lease_owner=NULL,lease_until=NULL,updated_at=now() WHERE id=$1",[owned.id,state,code,retry?retryDelayMs(owned.attempt_count):0]);
  await c.query('INSERT INTO sccrm_fanout.events(job_id,attempt,state,code) VALUES($1,$2,$3,$4)',[owned.id,owned.attempt_count,state,code]);
 });}
 async status(){return (await this.pool.query(`SELECT t.target_id,t.branch_code,t.database_identity,t.enabled,count(j.id)::int total,count(j.id) FILTER(WHERE j.state='succeeded')::int succeeded,count(j.id) FILTER(WHERE j.state='review')::int review,count(j.id) FILTER(WHERE j.state IN('pending','retry','running'))::int waiting,max(j.completed_at) last_completed_at,min(j.queued_at) FILTER(WHERE j.state IN('pending','retry','running')) oldest_waiting_at FROM sccrm_fanout.targets t LEFT JOIN sccrm_fanout.jobs j USING(target_id) GROUP BY t.target_id ORDER BY t.target_id`)).rows;}
}
class FanoutEngine{
 constructor({queue,adapters,pollMs=1000,leaseMs=15000,timeoutMs=7500,onError=()=>{}}){requireValue(queue&&adapters&&pollMs>=100&&leaseMs>timeoutMs+1000,'ENGINE_CONFIG_REFUSED');this.queue=queue;this.adapters=adapters;this.pollMs=pollMs;this.leaseMs=leaseMs;this.timeoutMs=timeoutMs;this.onError=onError;this.owner=crypto.randomUUID();this.inFlight=new Map();this.controllers=new Set();this.stopped=true;this.stopping=false;this.ticking=false;}
 async tick(){if(this.ticking||this.stopping)return;this.ticking=true;try{for(const target of await this.queue.targets()){
  if(this.stopping)break;
  if(this.inFlight.has(target.target_id))continue;const adapter=this.adapters[target.target_id];if(!adapter)continue;
  const promise=this.deliver(target,adapter).catch(e=>this.onError({targetId:target.target_id,code:safeCode(e)}));this.inFlight.set(target.target_id,promise);promise.finally(()=>{if(this.inFlight.get(target.target_id)===promise)this.inFlight.delete(target.target_id);});
 }}finally{this.ticking=false;}}
 async deliver(target,adapter){
  const job=await this.queue.lease(target.target_id,this.owner,this.leaseMs);if(!job)return;
  if(this.stopping)return;
  const abort=new AbortController();this.controllers.add(abort);let timer,request;
  try{
   validateJob(job);request=Promise.resolve().then(()=>adapter.receive(job,{signal:abort.signal}));request.catch(()=>{});
   const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{abort.abort();reject(new ReviewError('DELIVERY_TIMEOUT'));},this.timeoutMs);});
   const ack=await Promise.race([request,deadline]);validateAck(job,ack);await this.queue.succeeded(job,ack);
  }catch(error){await this.queue.failed(job,this.stopping?new ReviewError('SERVICE_STOPPING'):error);
   // A receiver must honor cancellation. If it does not settle, reserve only
   // this target's local slot, never block healthy targets or start overlapping
   // calls. Persistent lease/idempotency handles restart after a stuck adapter.
   if(abort.signal.aborted&&request)await request.catch(()=>{});
  }finally{clearTimeout(timer);this.controllers.delete(abort);}
 }
 start(){requireValue(this.stopped,'ENGINE_ALREADY_STARTED');this.stopped=false;this.stopping=false;const pulse=()=>this.tick().catch(e=>this.onError({code:safeCode(e)}));void pulse();this.timer=setInterval(pulse,this.pollMs);return this;}
 async stop({waitMs=10000}={}){this.stopped=true;this.stopping=true;clearInterval(this.timer);for(const controller of this.controllers)controller.abort();let timer;await Promise.race([Promise.allSettled([...this.inFlight.values()]),new Promise(resolve=>{timer=setTimeout(resolve,waitMs);})]);clearTimeout(timer);}
}
module.exports={MARKER,SCOPE,ReviewError,normalizeProfile,profileHash,hqCodeFor,confirmation,safeCode,isRetryable,retryDelayMs,validateJob,validateAck,PgQueue,FanoutEngine};
