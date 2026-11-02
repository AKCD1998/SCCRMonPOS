'use strict';
// Delivery contract: injected adapters own all native connections/identity checks.
// This module owns only a private PostgreSQL outbox and never reads old SCCRM
// points, native PINs, profiles or credentials. All point integers remain strings.
// Candidate expectations come from fresh verified *intrinsic* native snapshots,
// after removing independently proven owned compensation (not the raw view).
const crypto=require('node:crypto');
const BRANCHES=Object.freeze(['000','001','003','004','005']);
const MARKER='fcd9c461-328b-4519-8a61-cea0cb46fe22';
const STORE_MARKER='541be1f2-1b99-4d73-9d6a-5ef0a1ef2417';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const HASH=/^[a-f0-9]{64}$/;
const fail=code=>{throw Object.assign(Error(code),{code});};
function text(value,max,code){if(typeof value!=='string'||!value||value.length>max||/[\x00-\x1f\x7f]/.test(value))fail(code);return value;}
function targetId(value){if(typeof value!=='string'||!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(value))fail('POINT_DELIVERY_TARGET_INVALID');return value;}
function integer(value,code='POINT_DELIVERY_INTEGER_INVALID'){
 if(typeof value==='number'&&!Number.isSafeInteger(value))fail(code);
 if(!['string','number','bigint'].includes(typeof value)||!/^[-]?\d+(?:\.0+)?$/.test(String(value)))fail(code);
 const n=BigInt(String(value).split('.')[0]);if(n<-(1n<<63n)||n>(1n<<63n)-1n)fail(code);return n.toString();
}
function generation(value){const n=integer(value,'POINT_DELIVERY_GENERATION_INVALID');if(BigInt(n)<=0n)fail('POINT_DELIVERY_GENERATION_INVALID');return n;}
function deliveryCodes(codes){
 if(codes===null||codes===undefined)return null;
 if(!Array.isArray(codes)||codes.length<1||codes.length>20||new Set(codes).size!==codes.length||codes.some(code=>typeof code!=='string'||!/^AR\d{3}-\d{6}$/.test(code)))fail('POINT_DELIVERY_CODES_REFUSED');
 return codes.slice().sort();
}
function operationId(databaseIdentity,adaCode,gen,version){
 text(databaseIdentity,1024,'POINT_DELIVERY_IDENTITY_INVALID');text(adaCode,20,'POINT_DELIVERY_CODE_INVALID');
 const normalizedGeneration=generation(gen);if(!HASH.test(version))fail('POINT_DELIVERY_VERSION_INVALID');
 const bytes=crypto.createHash('sha256').update(JSON.stringify(['SCCRM-ADA-POINT-DELIVERY-V1',databaseIdentity,adaCode,normalizedGeneration,version])).digest().subarray(0,16);
 bytes[6]=(bytes[6]&15)|0x50;bytes[8]=(bytes[8]&63)|0x80;
 const h=bytes.toString('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
async function acquire(db){
 if(!db||typeof db.query!=='function')fail('POINT_DELIVERY_CONNECTION_REQUIRED');
 if(typeof db.connect==='function'&&!db.connectionParameters&&typeof db.release!=='function'){
  const c=await db.connect();if(!c||typeof c.query!=='function'||typeof c.release!=='function')fail('POINT_DELIVERY_DEDICATED_CONNECTION_REQUIRED');return {c,release:()=>c.release()};
 }
 return {c:db,release:()=>{}};
}
async function guard(db){
 const rows=(await db.query(`SELECT d.marker::text,d.schema_version,m.marker::text store_marker,m.scope
  FROM ada_points.delivery_meta d CROSS JOIN ada_points.meta m WHERE d.singleton AND m.singleton`)).rows;
 if(rows.length!==1||rows[0].schema_version!==1||rows[0].marker!==MARKER||rows[0].store_marker!==STORE_MARKER||rows[0].scope!=='SCCRM-ADA-PRIMARY-POINTS-V1')fail('POINT_DELIVERY_SCHEMA_NOT_OWNED');
}
async function transaction(db,action){
 const {c,release}=await acquire(db);try{await c.query('BEGIN');await guard(c);const result=await action(c);await c.query('COMMIT');return result;}
 catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{release();}
}
function normalizeFreshness(freshness){
 if(!freshness||!Array.isArray(freshness.sources)||freshness.sources.length!==5)fail('POINT_DELIVERY_ALL_FRESH_SOURCES_REQUIRED');
 const maxAgeMs=freshness.maxAgeMs??90000;
 if(!Number.isInteger(maxAgeMs)||maxAgeMs<1000||maxAgeMs>120000)fail('POINT_DELIVERY_FRESHNESS_BOUND_INVALID');
 const sources=freshness.sources.map(s=>{
  if(!s||!BRANCHES.includes(s.branchCode))fail('POINT_DELIVERY_SOURCE_INVALID');
  const observed=new Date(s.observedAt);if(!Number.isFinite(observed.getTime()))fail('POINT_DELIVERY_SOURCE_TIME_INVALID');
  return {branch_code:s.branchCode,database_identity:text(s.databaseIdentity,1024,'POINT_DELIVERY_IDENTITY_INVALID'),observed_at:observed.toISOString()};
 }).sort((a,b)=>a.branch_code.localeCompare(b.branch_code));
 if(sources.map(s=>s.branch_code).join(',')!==BRANCHES.join(','))fail('POINT_DELIVERY_ALL_FRESH_SOURCES_REQUIRED');
 return {sources,maxAgeMs};
}
async function requireFresh(c,input){
 const f=normalizeFreshness(input);
 const row=(await c.query(`WITH requested AS(SELECT * FROM jsonb_to_recordset($1::jsonb)
  AS x(branch_code text,database_identity text,observed_at timestamptz))
 SELECT count(*)::int n,bool_and(s.source_identity=r.database_identity AND s.observed_at=r.observed_at
  AND s.observed_at>=clock_timestamp()-($2::int*interval '1 millisecond')
  AND s.observed_at<=clock_timestamp()+interval '5 seconds') fresh,
  (SELECT g.state='ready' AND g.observed_at IS NOT NULL AND g.observed_at>=(SELECT min(observed_at) FROM requested)
    AND g.observed_at>=clock_timestamp()-($2::int*interval '1 millisecond') FROM ada_points.global_state g WHERE singleton) global_ready
 FROM requested r JOIN ada_points.sources s USING(branch_code)`,[JSON.stringify(f.sources),f.maxAgeMs])).rows[0];
 if(row.n!==5||row.fresh!==true||row.global_ready!==true)fail('POINT_DELIVERY_SOURCES_NOT_FRESH');
 return f;
}
async function registerTargets(db,targets){
 if(!Array.isArray(targets)||!targets.length||targets.length>5)fail('POINT_DELIVERY_TARGETS_INVALID');
 const rows=targets.map(t=>{
  if(!t||!BRANCHES.includes(t.branchCode)||typeof t.enabled!=='boolean')fail('POINT_DELIVERY_TARGET_INVALID');
  return {target_id:targetId(t.targetId),branch_code:t.branchCode,database_identity:text(t.databaseIdentity,1024,'POINT_DELIVERY_IDENTITY_INVALID'),enabled:t.enabled};
 });
 if(new Set(rows.map(t=>t.target_id)).size!==rows.length||new Set(rows.map(t=>t.branch_code)).size!==rows.length||new Set(rows.map(t=>t.database_identity)).size!==rows.length)fail('POINT_DELIVERY_DUPLICATE_TARGET');
 return transaction(db,async c=>{
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended('SCCRM_POINT_TARGET_REGISTRY_V1',0))");
  const existing=(await c.query('SELECT target_id,branch_code,database_identity FROM ada_points.delivery_targets')).rows;
  for(const row of rows)if(existing.some(t=>(t.target_id===row.target_id||t.branch_code===row.branch_code||t.database_identity===row.database_identity)&&(t.target_id!==row.target_id||t.branch_code!==row.branch_code||t.database_identity!==row.database_identity)))fail('POINT_DELIVERY_TARGET_IDENTITY_CHANGED');
  const bound=(await c.query(`WITH r AS(SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(target_id text,branch_code text,database_identity text,enabled boolean))
   SELECT count(*)::int n FROM r JOIN ada_points.sources s ON s.branch_code=r.branch_code AND s.source_identity=r.database_identity`,[JSON.stringify(rows)])).rows[0];
  if(bound.n!==rows.length)fail('POINT_DELIVERY_TARGET_SOURCE_IDENTITY_MISMATCH');
  await c.query(`INSERT INTO ada_points.delivery_targets(target_id,branch_code,database_identity,enabled)
   SELECT target_id,branch_code,database_identity,enabled FROM jsonb_to_recordset($1::jsonb) AS x(target_id text,branch_code text,database_identity text,enabled boolean)
   ON CONFLICT(target_id) DO UPDATE SET enabled=EXCLUDED.enabled,updated_at=clock_timestamp()
   WHERE ada_points.delivery_targets.enabled IS DISTINCT FROM EXCLUDED.enabled`,[JSON.stringify(rows)]);
  return {registered:rows.length};
 });
}
async function setTargetEnabled(db,id,enabled){
 targetId(id);if(typeof enabled!=='boolean')fail('POINT_DELIVERY_TARGET_INVALID');
 return transaction(db,async c=>{const r=await c.query('UPDATE ada_points.delivery_targets SET enabled=$2,updated_at=clock_timestamp() WHERE target_id=$1 RETURNING target_id,enabled',[id,enabled]);if(r.rowCount!==1)fail('POINT_DELIVERY_TARGET_UNKNOWN');return r.rows[0];});
}
async function enqueue(db,{freshness,candidates}={}){
 normalizeFreshness(freshness);
 if(!Array.isArray(candidates)||candidates.length>100000)fail('POINT_DELIVERY_CANDIDATES_INVALID');
 const seen=new Set(),input=candidates.map(r=>{
  if(!r||typeof r.nativeExists!=='boolean')fail('POINT_DELIVERY_CANDIDATE_INVALID');
  const row={target_id:targetId(r.targetId),ada_code:text(r.adaCode,20,'POINT_DELIVERY_CODE_INVALID'),generation:generation(r.generation),projection_version:r.projectionVersion,
   target_balance:integer(r.targetBalance),expected_intrinsic:integer(r.expectedIntrinsic),raw_view_balance:integer(r.rawViewBalance),native_exists:r.nativeExists};
  if(!HASH.test(row.projection_version))fail('POINT_DELIVERY_VERSION_INVALID');
  const key=JSON.stringify([row.target_id,row.ada_code]);if(seen.has(key))fail('POINT_DELIVERY_DUPLICATE_CANDIDATE');seen.add(key);return row;
 });
 return transaction(db,async c=>{
  const fresh=await requireFresh(c,freshness),targets=(await c.query('SELECT target_id,branch_code,database_identity FROM ada_points.delivery_targets')).rows;
  const byId=new Map(targets.map(t=>[t.target_id,t])),byBranch=new Map(fresh.sources.map(s=>[s.branch_code,s]));
  for(const r of input){const t=byId.get(r.target_id);if(!t)fail('POINT_DELIVERY_TARGET_UNKNOWN');
   r.database_identity=t.database_identity;r.source_observed_at=byBranch.get(t.branch_code).observed_at;
   r.operation_id=operationId(t.database_identity,r.ada_code,r.generation,r.projection_version);
  }
  // One JSON statement for the whole population, including supersession. These
  // data-modifying CTEs never update the same row twice: their predicates divide
  // older/aligned jobs from same-generation SOURCE_MOVED refreshes.
  const row=(await c.query(`WITH incoming AS(SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
    target_id text,ada_code text,generation bigint,projection_version text,target_balance bigint,expected_intrinsic bigint,
    raw_view_balance bigint,native_exists boolean,database_identity text,source_observed_at timestamptz,operation_id uuid)),
   eligible AS MATERIALIZED(SELECT i.* FROM incoming i
    JOIN ada_points.delivery_targets t ON t.target_id=i.target_id AND t.database_identity=i.database_identity AND t.enabled
    JOIN ada_points.balance_values b ON b.ada_code=i.ada_code AND b.state='ready' AND b.generation=i.generation
     AND b.version=i.projection_version AND b.balance=i.target_balance
    CROSS JOIN ada_points.global_state g WHERE g.singleton AND g.state='ready'),
   supersede AS(UPDATE ada_points.delivery_jobs j SET state='superseded',last_code=CASE WHEN j.generation=e.generation THEN 'TARGET_ALREADY_ALIGNED' ELSE 'NEWER_GENERATION' END,
    lease_token=NULL,lease_until=NULL,next_attempt_at=NULL,completed_at=clock_timestamp(),updated_at=clock_timestamp()
    FROM eligible e WHERE j.target_id=e.target_id AND j.ada_code=e.ada_code AND j.state IN('queued','leased','retry')
     AND (j.generation<e.generation OR(j.generation=e.generation AND e.native_exists AND e.raw_view_balance=e.target_balance)) RETURNING j.id),
   refreshed AS(UPDATE ada_points.delivery_jobs j SET expected_intrinsic=e.expected_intrinsic,source_observed_at=e.source_observed_at,
    state='queued',last_code='FRESH_SOURCE_REFRESHED',next_attempt_at=clock_timestamp(),updated_at=clock_timestamp()
    FROM eligible e WHERE j.target_id=e.target_id AND j.ada_code=e.ada_code AND j.generation=e.generation
     AND j.state='retry' AND j.last_code='SOURCE_MOVED_RETRY' AND e.native_exists AND e.raw_view_balance<>e.target_balance
     AND e.source_observed_at>j.source_observed_at RETURNING j.id),
   inserted AS(INSERT INTO ada_points.delivery_jobs(target_id,database_identity,ada_code,generation,projection_version,target_balance,
    expected_intrinsic,operation_id,source_observed_at)
    SELECT target_id,database_identity,ada_code,generation,projection_version,target_balance,expected_intrinsic,operation_id,source_observed_at
     FROM eligible WHERE native_exists AND raw_view_balance<>target_balance
    ON CONFLICT(target_id,ada_code,generation) DO NOTHING RETURNING id)
   SELECT (SELECT count(*)::int FROM incoming) candidates,(SELECT count(*)::int FROM eligible) eligible,
    (SELECT count(*)::int FROM inserted) inserted,(SELECT count(*)::int FROM supersede) superseded,
    (SELECT count(*)::int FROM refreshed) refreshed,
    (SELECT count(*)::int FROM eligible WHERE NOT native_exists) absent,
    (SELECT count(*)::int FROM eligible WHERE native_exists AND raw_view_balance=target_balance) aligned`,[JSON.stringify(input)])).rows[0];
  return row;
 });
}
async function lease(db,{targetId:id,freshness,limit=50,leaseMs=30000,codes=null}={}){
 targetId(id);normalizeFreshness(freshness);
 codes=deliveryCodes(codes);
 if(!Number.isInteger(limit)||limit<1||limit>500||!Number.isInteger(leaseMs)||leaseMs<1000||leaseMs>1800000)fail('POINT_DELIVERY_LEASE_OPTIONS_INVALID');
 return transaction(db,async c=>{
  await requireFresh(c,freshness);
  await c.query(`UPDATE ada_points.delivery_jobs j SET state='superseded',last_code='PROJECTION_NO_LONGER_CURRENT',
    lease_token=NULL,lease_until=NULL,next_attempt_at=NULL,completed_at=clock_timestamp(),updated_at=clock_timestamp()
   WHERE j.target_id=$1 AND j.state IN('queued','retry','leased') AND NOT EXISTS(
    SELECT 1 FROM ada_points.balance_values b WHERE b.ada_code=j.ada_code AND b.generation=j.generation
     AND b.version=j.projection_version AND b.balance=j.target_balance AND b.state='ready')`,[id]);
  const token=crypto.randomUUID();
  const r=await c.query(`WITH due AS(SELECT j.id FROM ada_points.delivery_jobs j
    JOIN ada_points.delivery_targets t ON t.target_id=j.target_id AND t.enabled AND t.database_identity=j.database_identity
    JOIN ada_points.sources s ON s.branch_code=t.branch_code AND s.source_identity=t.database_identity
    JOIN ada_points.balance_values b ON b.ada_code=j.ada_code AND b.generation=j.generation AND b.version=j.projection_version AND b.balance=j.target_balance AND b.state='ready'
    CROSS JOIN ada_points.global_state g WHERE j.target_id=$1 AND g.singleton AND g.state='ready'
     AND ($5::text[] IS NULL OR j.ada_code=ANY($5::text[]))
     AND ((j.state IN('queued','retry') AND j.next_attempt_at<=clock_timestamp() AND j.last_code<>'SOURCE_MOVED_RETRY')
      OR(j.state='leased' AND j.lease_until<=clock_timestamp()))
    ORDER BY j.id FOR UPDATE OF j SKIP LOCKED LIMIT $2),
   claimed AS(UPDATE ada_points.delivery_jobs j SET state='leased',attempt_count=attempt_count+1,lease_token=$3::uuid,
    lease_until=clock_timestamp()+($4::int*interval '1 millisecond'),next_attempt_at=NULL,last_code='LEASED',updated_at=clock_timestamp()
    FROM due WHERE due.id=j.id RETURNING j.*)
   SELECT c.*,t.branch_code FROM claimed c JOIN ada_points.delivery_targets t USING(target_id) ORDER BY c.id`,[id,limit,token,leaseMs,codes]);
  return r.rows;
 });
}
function validateLease(job){
 if(!job||!UUID.test(job.lease_token)||!UUID.test(job.operation_id)||!/^\d+$/.test(String(job.id)))fail('POINT_DELIVERY_LEASE_REQUIRED');
 targetId(job.target_id);text(job.database_identity,1024,'POINT_DELIVERY_IDENTITY_INVALID');text(job.ada_code,20,'POINT_DELIVERY_CODE_INVALID');generation(job.generation);integer(job.target_balance);integer(job.expected_intrinsic);
 if(!HASH.test(job.projection_version))fail('POINT_DELIVERY_VERSION_INVALID');return job;
}
function classifyFailure(error){
 const input=typeof error==='string'?error:error?.code;
 const code=typeof input==='string'&&/^[A-Z0-9_]{1,128}$/.test(input)?input:'NATIVE_FAILURE_REVIEW';
 if(/(?:^|_)SOURCE_MOVED_RETRY$/.test(code))return {state:'retry',code:'SOURCE_MOVED_RETRY',waitFresh:true};
 const number=error?.sqlNumber;
 if(['ECONNREFUSED','ECONNRESET','ETIMEDOUT','ETIMEOUT','EHOSTUNREACH','ENETUNREACH','ESOCKET','EAI_AGAIN','EBUSY','SQL_BUSY','SQL_OFFLINE','NATIVE_OFFLINE','NATIVE_BUSY','POINT_NATIVE_TIMEOUT','POINT_RECEIVER_BUSY'].includes(code)||[1205,1222,-2,2,53,64,233,258,10053,10054,10060].includes(number))return {state:'retry',code,waitFresh:false};
 return {state:'review',code,waitFresh:false};
}
async function settle(db,job,{state,code,waitFresh=false,baseMs=1000,maxMs=300000}={}){
 validateLease(job);
 if(!['retry','review','succeeded','superseded'].includes(state)||typeof code!=='string'||!/^[A-Z0-9_]{1,128}$/.test(code))fail('POINT_DELIVERY_SETTLEMENT_INVALID');
 if(!Number.isInteger(baseMs)||!Number.isInteger(maxMs)||baseMs<100||maxMs<baseMs||maxMs>300000)fail('POINT_DELIVERY_BACKOFF_INVALID');
 const attempts=Number(job.attempt_count);if(!Number.isSafeInteger(attempts)||attempts<1)fail('POINT_DELIVERY_LEASE_REQUIRED');
 const delay=Math.min(maxMs,baseMs*2**Math.min(attempts-1,20));
 return transaction(db,async c=>{
  const r=await c.query(`UPDATE ada_points.delivery_jobs j SET state=$4,last_code=$5,
    lease_token=NULL,lease_until=NULL,
    next_attempt_at=CASE WHEN $4='retry' AND NOT $6::boolean THEN clock_timestamp()+($7::int*interval '1 millisecond') ELSE NULL END,
    completed_at=CASE WHEN $4='retry' THEN NULL ELSE clock_timestamp() END,updated_at=clock_timestamp()
   WHERE j.id=$1::bigint AND j.lease_token=$2::uuid AND j.operation_id=$3::uuid AND j.state='leased'
    AND j.lease_until>clock_timestamp() AND j.target_id=$8 AND j.database_identity=$9
    AND j.ada_code=$10 AND j.generation=$11::bigint AND j.target_balance=$12::bigint
    AND j.projection_version=$13 AND j.expected_intrinsic=$14::bigint
    AND EXISTS(SELECT 1 FROM ada_points.delivery_targets t WHERE t.target_id=j.target_id AND t.database_identity=j.database_identity)
   RETURNING j.id,j.state,j.last_code,j.next_attempt_at`,[job.id,job.lease_token,job.operation_id,state,code,waitFresh,delay,job.target_id,job.database_identity,job.ada_code,job.generation,job.target_balance,job.projection_version,job.expected_intrinsic]);
  return r.rowCount?{accepted:true,...r.rows[0]}:{accepted:false,code:'LEASE_FENCE_LOST'};
 });
}
async function failJob(db,job,error,options={}){return settle(db,job,{...options,...classifyFailure(error)});}
async function acknowledge(db,job,result,databaseIdentity){
 validateLease(job);
 let matches=false;
 try{matches=databaseIdentity===job.database_identity&&result&&result.operation_id===job.operation_id&&result.ada_code===job.ada_code
  &&integer(result.target_balance)===integer(job.target_balance)&&generation(result.generation)===generation(job.generation)
  &&(result.database_identity===undefined||result.database_identity===job.database_identity)
  &&(result.projection_version===undefined||result.projection_version===job.projection_version)
  &&['applied','replayed','superseded'].includes(result.outcome);}catch{}
 if(!matches)return settle(db,job,{state:'review',code:'NATIVE_ACK_IDENTITY_MISMATCH'});
 return settle(db,job,{state:result.outcome==='superseded'?'superseded':'succeeded',code:'NATIVE_'+result.outcome.toUpperCase()});
}
async function drainTarget(db,target,{freshness,limit=50,leaseMs=30000,concurrency=1,retry={},codes=null}={}){
 if(!target||typeof target.apply!=='function')fail('POINT_DELIVERY_ADAPTER_REQUIRED');
 const id=targetId(target.targetId);text(target.databaseIdentity,1024,'POINT_DELIVERY_IDENTITY_INVALID');
 codes=deliveryCodes(codes);
 if(!Number.isInteger(concurrency)||concurrency<1||concurrency>8)fail('POINT_DELIVERY_CONCURRENCY_INVALID');
 // A Pool supplies dedicated PostgreSQL transactions; callers passing a single
 // Client must keep concurrency=1, as with every other transaction-owning API.
 if(concurrency>1&&!(typeof db.connect==='function'&&!db.connectionParameters&&typeof db.release!=='function'))fail('POINT_DELIVERY_POOL_REQUIRED_FOR_CONCURRENCY');
 if(!Number.isInteger(limit)||limit<1||limit>500)fail('POINT_DELIVERY_LEASE_OPTIONS_INVALID');
 const results=[];let reserved=0,leased=0,empty=false;
 // Claim only as workers become available. Pre-leasing fifty sequential calls
 // would let later leases expire before their RPC even started.
 async function run(){while(!empty&&reserved<limit){reserved++;
  const jobs=await lease(db,{targetId:id,freshness,limit:1,leaseMs,codes});
  if(!jobs.length){empty=true;return;}const job=jobs[0];leased++;
  if(target.databaseIdentity!==job.database_identity){results.push(await failJob(db,job,{code:'NATIVE_TARGET_IDENTITY_MISMATCH'}));continue;}
  let response;try{response=await target.apply(job);}catch(e){results.push(await failJob(db,job,e,retry));continue;}
  results.push(await acknowledge(db,job,response,target.databaseIdentity));
 }}
 await Promise.all(Array.from({length:Math.min(concurrency,limit)},run));
 return {targetId:id,leased,results};
}
async function status(db){
 await guard(db);return (await db.query(`SELECT t.target_id,t.branch_code,t.enabled,j.state,count(j.id)::int jobs,
  min(j.queued_at) oldest_queued_at,min(j.next_attempt_at) next_attempt_at,
  count(j.id) FILTER(WHERE j.last_code='SOURCE_MOVED_RETRY')::int waiting_fresh_source
 FROM ada_points.delivery_targets t LEFT JOIN ada_points.delivery_jobs j USING(target_id)
 GROUP BY t.target_id,t.branch_code,t.enabled,j.state ORDER BY t.branch_code,j.state`)).rows;
}
module.exports={BRANCHES,MARKER,integer,operationId,normalizeFreshness,classifyFailure,guard,registerTargets,setTargetEnabled,enqueue,lease,acknowledge,failJob,drainTarget,status};
