'use strict';
const crypto=require('node:crypto');
const source=require('./export.cjs');
const model=require('./model.cjs');
const {deriveIntrinsicSnapshot,deriveIntrinsicSnapshots}=require('./compensation.cjs');
const {projectNativePoints}=require('./projection.cjs');
const SCOPE='SCCRM-ADA-PRIMARY-POINTS-V1',MARKER='541be1f2-1b99-4d73-9d6a-5ef0a1ef2417';
const MACHINES={'000':'SERVER','001':'SC_001','003':'POSSRV','004':'SERVER004','005':'POSSRV'};
const fail=code=>{throw Object.assign(Error(code),{code});};
const sha=text=>crypto.createHash('sha256').update(text).digest('hex');
function canonical(value){if(Array.isArray(value))return value.map(canonical);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]));return value;}
const hash=value=>sha(JSON.stringify(canonical(value)));
function openingValue(value){if(value===null||value===undefined)return null;try{return model.decimal(value);}catch{return 'invalid:'+hash(value);}}
async function acquire(db){
 if(!db||typeof db.query!=='function')fail('POINT_STORE_CONNECTION_REQUIRED');
 if(typeof db.connect==='function'&&!db.connectionParameters&&typeof db.release!=='function'){
  const c=await db.connect();if(!c||typeof c.query!=='function'||typeof c.release!=='function')fail('POINT_STORE_DEDICATED_CONNECTION_REQUIRED');return {c,release:()=>c.release()};
 }
 return {c:db,release:()=>{}};
}
async function guard(db){
 const rows=(await db.query('SELECT singleton,schema_version,scope,marker FROM ada_points.meta')).rows;
 if(rows.length!==1||rows[0].singleton!==true||rows[0].schema_version!==1||rows[0].scope!==SCOPE||rows[0].marker!==MARKER)fail('POINT_STORE_SCHEMA_NOT_OWNED');
}
function policyOptions(options){
 if(typeof options.allowNativeHomeBranch!=='undefined'&&typeof options.allowNativeHomeBranch!=='boolean')fail('POINT_STORE_POLICY_REFUSED');
 const p=options.openingSourceByCode??{};
 if(!p||typeof p!=='object'||Array.isArray(p)||Object.entries(p).some(([code,b])=>!code||code.length>20||!source.BRANCHES.includes(b)))fail('POINT_STORE_POLICY_REFUSED');
 const ownerMap=options.ownerMap??[];
 if(!Array.isArray(ownerMap)||ownerMap.length>20000||ownerMap.some(r=>!r||Object.keys(r).sort().join(',')!=='ada_code,canonical_code,member_id'||typeof r.member_id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(r.member_id)||typeof r.ada_code!=='string'||!r.ada_code||r.ada_code.length>20||typeof r.canonical_code!=='string'||!r.canonical_code||r.canonical_code.length>50))fail('POINT_STORE_OWNER_MAP_REFUSED');
 const normalized=ownerMap.map(row=>({...row,member_id:row.member_id.toLowerCase()})).sort((a,b)=>a.ada_code.localeCompare(b.ada_code)||a.member_id.localeCompare(b.member_id));
 return {allowNativeHomeBranch:options.allowNativeHomeBranch??false,openingSourceByCode:p,ownerMap:normalized};
}
function validateSnapshots(snapshots,projection,options={}){
 const policy=policyOptions(options);
 if(!Array.isArray(snapshots)||snapshots.length!==source.BRANCHES.length||snapshots.map(s=>s?.branch).sort().join(',')!==source.BRANCHES.join(','))fail('POINT_STORE_ALL_SOURCES_REQUIRED');
 for(const s of snapshots){
  if(s.scope!==source.SCOPE||s.mode!=='Live'||s.identity?.machine!==MACHINES[s.branch]||s.identity?.db!=='AdaAcc'||s.productionWrites!==0||s.pinRead!==false)fail('POINT_STORE_SOURCE_IDENTITY_REFUSED');
  if(source.validateSchema(s.schema)!==s.schemaHash)fail('POINT_STORE_SOURCE_SCHEMA_REFUSED');
  if(!s.sourceConsistency?.stable||s.sourceConsistency.firstHash!==s.sourceConsistency.secondHash||!/^[a-f0-9]{64}$/.test(s.sourceConsistency.firstHash))fail('POINT_STORE_UNSTABLE_SOURCE_REFUSED');
  const start=Date.parse(s.captureStartedAt),end=Date.parse(s.captureCompletedAt);
  if(!Number.isFinite(start)||!Number.isFinite(end)||end<start)fail('POINT_STORE_SOURCE_TIME_REFUSED');
  if(!Array.isArray(s.customers)||s.customers.length>20000||!Array.isArray(s.points)||s.points.length>100000||!Array.isArray(s.balances)||s.balances.length>20000)fail('POINT_STORE_SOURCE_ROWS_REFUSED');
  const expected=source.sha(source.payloadContent(s));
  if(s.payloadHash!==expected)fail('POINT_STORE_SOURCE_HASH_REFUSED');
 }
 const expected=projectNativePoints(snapshots,policy);
 if(hash(expected)!==hash(projection)||projection.scope!=='SCCRM-ADA-POINTS-PROJECTION-20261102'||projection.sccrmLedgerIncluded!==false||projection.aliasesMerged!==false||projection.pinRead!==false)fail('POINT_STORE_PROJECTION_IDENTITY_REFUSED');
 return {policy,projection:expected};
}
function eventRecord(event,reviewReasons=[]){
 const p=event.businessPayload;
 return {event_key:sha(event.key),owner_key_hash:sha(event.ownerKey),origin_branch:p.FTBchCode,ada_code:p.FTCstCode,doc_no:p.FTPntRefDoc,supplier_code:p.FTSplCode,business_hash:event.businessHash,card_type:event.cardType,points:event.amount,contribution:event.contribution,expired:p.FTPntExpired,processed:p.FTPntStaPrcDoc,active:event.active,state:reviewReasons.length||event.unknownNonzero?'review':'ready',sources:[...event.sources].sort(),business_payload:p,review_reasons:[...new Set([...reviewReasons,...(event.unknownNonzero?['POINT_UNKNOWN_NONZERO_TYPE']:[])])].sort()};
}
function collectIntrinsicEvents(snapshots,projection){
 const merged=model.mergeReplicas(snapshots);if(merged.invalid.length)fail('POINT_STORE_INVALID_EVENT_REFUSED');
 const reviewed=new Map(projection.balances.filter(b=>b.state==='review').map(b=>[b.adaCode,b.reasons]));
 for(const orphan of projection.orphanEvents||[])reviewed.set(orphan.adaCode,[...new Set([...(reviewed.get(orphan.adaCode)||[]),'POINT_EVENT_CUSTOMER_MISSING'])]);
 const records=merged.events.map(e=>eventRecord(e,reviewed.get(e.adaCode)||[]));
 for(const conflict of merged.conflicts){
  const groups=conflict.variants.slice().sort((a,b)=>a.businessHash.localeCompare(b.businessHash));const e=groups[0],r=eventRecord(e,[conflict.code,...(reviewed.get(e.adaCode)||[])]);
  r.business_hash=hash({conflict:conflict.code,hashes:groups.map(g=>g.businessHash)});r.points=null;r.contribution=null;r.active=false;r.card_type=null;r.expired=null;r.processed=null;r.state='review';r.sources=[...new Set(groups.flatMap(g=>g.sources))].sort();r.business_payload={conflict:conflict.code,variants:groups.map(g=>({businessHash:g.businessHash,businessPayload:g.businessPayload,sources:g.sources.slice().sort()}))};records.push(r);
 }
 return records.sort((a,b)=>a.event_key.localeCompare(b.event_key));
}
function collectEvents(snapshots,projection){return collectIntrinsicEvents(deriveIntrinsicSnapshots(snapshots),projection);}
function effectiveValues(projection,oldValues,storeReasons){
 const values=new Map();
 for(const row of projection.balances){
  const {observedAt,...content}=row;const reasons=[...(storeReasons.get(row.adaCode)||[])].sort();
  const details={...content,...(reasons.length?{storeReviewReasons:reasons,projectionBaseVersion:row.version}:{})};
  values.set(row.adaCode,{ada_code:row.adaCode,balance:reasons.length?null:row.balanceExact,state:reasons.length?'review':row.state,version:reasons.length?hash({projection:row.version,storeReviewReasons:reasons}):row.version,details});
 }
 for(const old of oldValues)if(!values.has(old.ada_code)){
  const reason='POINT_CUSTOMER_SOURCE_REMOVED',base=old.details?.projectionBaseVersion||old.version;
  const details={...old.details,storeReviewReasons:[reason],projectionBaseVersion:base};
  values.set(old.ada_code,{ada_code:old.ada_code,balance:null,state:'review',version:hash({projection:base,storeReviewReasons:[reason]}),details});
 }
 return [...values.values()].sort((a,b)=>a.ada_code.localeCompare(b.ada_code));
}
async function applySnapshots(db,snapshots,projection,options={}){
 const validated=validateSnapshots(snapshots,projection,options),intrinsic=deriveIntrinsicSnapshots(snapshots),foreignCodes=new Set();
 for(let i=0;i<snapshots.length;i++){
  const globalKeys=new Set(intrinsic[i].points.map(model.keyFor));
  // A vendor replicating our own correction is a separate operating mode:
  // counter-adjusting it repeatedly could oscillate forever. Keep mathematical
  // analysis intact but hold publication/delivery until that path is reviewed.
  for(const point of deriveIntrinsicSnapshot(snapshots[i]).points)if(!globalKeys.has(model.keyFor(point)))foreignCodes.add(point.FTCstCode);
 }
 const incomingEvents=collectIntrinsicEvents(intrinsic,projection),{c,release}=await acquire(db);
 const fault=typeof options.fault==='function'?options.fault:async()=>{};
 let committed=false;
 try{
  await c.query('BEGIN');await c.query("SET LOCAL lock_timeout='2s';SET LOCAL statement_timeout='30s'");
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended('SCCRM-ADA-PRIMARY-POINTS-V1',0))");await guard(c);
  const oldSources=(await c.query('SELECT s.*,p.payload_hash FROM ada_points.sources s LEFT JOIN ada_points.source_snapshots p USING(branch_code) FOR UPDATE OF s')).rows;
  const sourceByBranch=new Map(oldSources.map(s=>[s.branch_code,s]));
  for(const s of snapshots){const old=oldSources.find(o=>o.branch_code===s.branch);if(old){
   if(old.source_identity!==model.databaseId(s)||old.machine!==s.identity.machine||old.database_name!==s.identity.db||old.schema_hash!==s.schemaHash||old.view_hash!==s.schema.viewHash)fail('POINT_STORE_SOURCE_BINDING_CHANGED');
   if(Date.parse(s.captureCompletedAt)<new Date(old.observed_at).getTime())fail('POINT_STORE_SOURCE_OBSERVATION_REGRESSION');
  }}
  const oldOpenings=(await c.query('SELECT branch_code,ada_code,initial_opening FROM ada_points.source_openings')).rows;
  const openingByKey=new Map(oldOpenings.map(o=>[o.branch_code+'/'+o.ada_code,o.initial_opening]));
  const oldEvents=(await c.query('SELECT event_key,owner_key_hash,origin_branch,ada_code,doc_no,supplier_code,business_hash,processed,state,sources,review_reasons FROM ada_points.native_events FOR UPDATE')).rows;
  const oldValues=(await c.query('SELECT ada_code,balance::text AS balance,state,version,generation::text AS generation,details FROM ada_points.balance_values FOR UPDATE')).rows;
  const oldEventByKey=new Map(oldEvents.map(e=>[e.event_key,e])),oldValueByCode=new Map(oldValues.map(v=>[v.ada_code,v]));
  const currentKeys=new Set(incomingEvents.map(e=>e.event_key)),storeReasons=new Map(),hold=(code,reason)=>{const r=storeReasons.get(code)||new Set();r.add(reason);storeReasons.set(code,r);};
  for(const old of oldValues)for(const reason of old.details?.storeReviewReasons||[])if(['NATIVE_OPENING_CHANGED_REVIEW','NATIVE_PROCESSING_CHANGED_REVIEW','POINT_FOREIGN_PROJECTION_REPLICATION_REVIEW'].includes(reason))hold(old.ada_code,reason);
  for(const code of foreignCodes)hold(code,'POINT_FOREIGN_PROJECTION_REPLICATION_REVIEW');
  const newOpenings=[],openingKeys=new Set();
  for(const s of snapshots)for(const customer of s.customers){const key=s.branch+'/'+customer.FTCstCode,value=openingValue(customer.FCCstRetPoint);
   if(openingKeys.has(key))fail('POINT_STORE_OPENING_DUPLICATE');openingKeys.add(key);
   if(openingByKey.has(key)){if(openingByKey.get(key)!==value)hold(customer.FTCstCode,'NATIVE_OPENING_CHANGED_REVIEW');}
   else newOpenings.push({branch_code:s.branch,ada_code:customer.FTCstCode,initial_opening:value,first_payload_hash:s.payloadHash});
  }
  const owners=new Map();for(const e of oldEvents){const set=owners.get(e.owner_key_hash)||new Set();set.add(e.ada_code);owners.set(e.owner_key_hash,set);if(!currentKeys.has(e.event_key))hold(e.ada_code,'POINT_SOURCE_EVENT_REMOVED');}
  for(const e of incomingEvents){const priorOwners=owners.get(e.owner_key_hash)||new Set();if([...priorOwners].some(code=>code!==e.ada_code)){for(const code of priorOwners)hold(code,'POINT_HISTORICAL_OWNER_CONFLICT');hold(e.ada_code,'POINT_HISTORICAL_OWNER_CONFLICT');e.state='review';e.review_reasons=[...new Set([...e.review_reasons,'POINT_HISTORICAL_OWNER_CONFLICT'])].sort();}}
  for(const e of incomingEvents){const old=oldEventByKey.get(e.event_key);if(old&&(old.processed==='N'&&e.processed==='Y'||old.review_reasons?.includes('NATIVE_PROCESSING_CHANGED_REVIEW'))){hold(e.ada_code,'NATIVE_PROCESSING_CHANGED_REVIEW');e.state='review';e.review_reasons=[...new Set([...e.review_reasons,'NATIVE_PROCESSING_CHANGED_REVIEW'])].sort();}}
  const families=new Map();for(const row of validated.policy.ownerMap){const family=families.get(row.member_id)||new Set();family.add(row.ada_code);families.set(row.member_id,family);}
  for(const family of families.values()){const reasons=new Set([...family].flatMap(code=>[...(storeReasons.get(code)||[])]));for(const code of family)for(const reason of reasons)hold(code,reason);}
  const values=effectiveValues(projection,oldValues,storeReasons),revision=hash({sources:snapshots.map(s=>[s.branch,s.payloadHash]).sort(),policy:validated.policy,values:values.map(v=>[v.ada_code,v.version])});
  for(const e of incomingEvents){const old=oldEventByKey.get(e.event_key);if(old&&(old.origin_branch!==e.origin_branch||old.ada_code!==e.ada_code||old.doc_no!==e.doc_no||old.supplier_code!==e.supplier_code||old.owner_key_hash!==e.owner_key_hash))fail('POINT_STORE_EVENT_IDENTITY_CHANGED');}
  const changedEvents=incomingEvents.filter(e=>{const old=oldEventByKey.get(e.event_key);return !old||old.business_hash!==e.business_hash||old.state!==e.state||hash(old.sources)!==hash(e.sources)||hash(old.review_reasons)!==hash(e.review_reasons);});
  const retireKeys=oldEvents.filter(e=>!currentKeys.has(e.event_key)&&e.state!=='retired').map(e=>e.event_key);
  const changedValues=values.filter(v=>{const old=oldValueByCode.get(v.ada_code);return !old||old.version!==v.version||old.state!==v.state||(old.balance===null?null:model.decimal(old.balance))!==v.balance||hash(old.details)!==hash(v.details);});
  if(changedValues.some(v=>{const old=oldValueByCode.get(v.ada_code);return old?.version===v.version&&(old.state!==v.state||(old.balance===null?null:model.decimal(old.balance))!==v.balance);}))fail('POINT_STORE_VERSION_CONTENT_CHANGED');
  // Authority/provenance details can change without changing a family's monetary
  // version. Retain that audit update but do not allocate another generation.
  for(const v of changedValues){const old=oldValueByCode.get(v.ada_code);v.generation=old?.version===v.version?old.generation:null;}
  let sourcePayloadChanges=0,sourceObservationChanges=0;
  for(const s of snapshots){
   sourceObservationChanges+=(await c.query(`INSERT INTO ada_points.sources(branch_code,source_identity,machine,database_name,schema_hash,view_hash,observed_at)
    VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(branch_code) DO UPDATE SET observed_at=EXCLUDED.observed_at
    WHERE sources.observed_at IS DISTINCT FROM EXCLUDED.observed_at RETURNING branch_code`,[s.branch,model.databaseId(s),s.identity.machine,s.identity.db,s.schemaHash,s.schema.viewHash,s.captureCompletedAt])).rowCount;
   if(sourceByBranch.get(s.branch)?.payload_hash!==s.payloadHash){
    await c.query(`INSERT INTO ada_points.source_snapshots(branch_code,payload_hash,payload,observed_at) VALUES($1,$2,$3::jsonb,$4)
     ON CONFLICT(branch_code) DO UPDATE SET payload_hash=EXCLUDED.payload_hash,payload=EXCLUDED.payload,observed_at=EXCLUDED.observed_at`,[s.branch,s.payloadHash,JSON.stringify(s),s.captureCompletedAt]);
    sourcePayloadChanges++;await c.query('INSERT INTO ada_points.source_audit(branch_code,payload_hash,source_identity,schema_hash,observed_at,customer_count,point_count,balance_count) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[s.branch,s.payloadHash,model.databaseId(s),s.schemaHash,s.captureCompletedAt,s.customers.length,s.points.length,s.balances.length]);
   }
  }
  const baselineWrites=newOpenings.length?await c.query(`INSERT INTO ada_points.source_openings(branch_code,ada_code,initial_opening,first_payload_hash)
   SELECT branch_code,ada_code,initial_opening,first_payload_hash FROM jsonb_to_recordset($1::jsonb) AS b(branch_code text,ada_code text,initial_opening text,first_payload_hash text)
   ON CONFLICT(branch_code,ada_code) DO NOTHING RETURNING ada_code`,[JSON.stringify(newOpenings)]):{rowCount:0};
  await fault('afterSources');
  const savedEvents=changedEvents.length?await c.query(`INSERT INTO ada_points.native_events(event_key,owner_key_hash,origin_branch,ada_code,doc_no,supplier_code,business_hash,card_type,points,contribution,expired,processed,active,state,sources,business_payload,review_reasons)
   SELECT event_key,owner_key_hash,origin_branch,ada_code,doc_no,supplier_code,business_hash,card_type,points::bigint,contribution::bigint,expired,processed,active,state,sources,business_payload,review_reasons
   FROM jsonb_to_recordset($1::jsonb) AS e(event_key text,owner_key_hash text,origin_branch text,ada_code text,doc_no text,supplier_code text,business_hash text,card_type text,points text,contribution text,expired text,processed text,active boolean,state text,sources text[],business_payload jsonb,review_reasons text[])
   ON CONFLICT(event_key) DO UPDATE SET business_hash=EXCLUDED.business_hash,card_type=EXCLUDED.card_type,points=EXCLUDED.points,contribution=EXCLUDED.contribution,expired=EXCLUDED.expired,processed=EXCLUDED.processed,active=EXCLUDED.active,state=EXCLUDED.state,sources=EXCLUDED.sources,business_payload=EXCLUDED.business_payload,review_reasons=EXCLUDED.review_reasons,last_changed_at=clock_timestamp()
   WHERE native_events.business_hash IS DISTINCT FROM EXCLUDED.business_hash OR native_events.state IS DISTINCT FROM EXCLUDED.state OR native_events.sources IS DISTINCT FROM EXCLUDED.sources OR native_events.review_reasons IS DISTINCT FROM EXCLUDED.review_reasons
   RETURNING event_key`,[JSON.stringify(changedEvents)]):{rowCount:0,rows:[]};
  const retired=retireKeys.length?await c.query(`UPDATE ada_points.native_events SET state='retired',active=false,review_reasons=ARRAY['POINT_SOURCE_EVENT_REMOVED'],last_changed_at=clock_timestamp()
   WHERE event_key=ANY($1::text[]) AND state<>'retired' RETURNING event_key`,[retireKeys]):{rowCount:0,rows:[]};
  await fault('afterEvents');
  const savedValues=changedValues.length?await c.query(`INSERT INTO ada_points.balance_values(ada_code,balance,state,version,generation,details)
   SELECT ada_code,balance::numeric(38,17),state,version,COALESCE(generation::bigint,nextval('ada_points.balance_generation_seq')),details FROM jsonb_to_recordset($1::jsonb) AS v(ada_code text,balance text,state text,version text,generation text,details jsonb)
   ON CONFLICT(ada_code) DO UPDATE SET balance=EXCLUDED.balance,state=EXCLUDED.state,version=EXCLUDED.version,generation=EXCLUDED.generation,details=EXCLUDED.details
   WHERE balance_values.version IS DISTINCT FROM EXCLUDED.version OR balance_values.balance IS DISTINCT FROM EXCLUDED.balance OR balance_values.state IS DISTINCT FROM EXCLUDED.state OR balance_values.details IS DISTINCT FROM EXCLUDED.details
   RETURNING ada_code,balance::text AS balance,state,version,generation::text AS generation,details`,[JSON.stringify(changedValues)]):{rowCount:0,rows:[]};
  if(savedValues.rowCount){const entries=savedValues.rows.map(value=>({ada_code:value.ada_code,old_value:oldValueByCode.get(value.ada_code)||null,new_value:value,generation:value.generation,revision}));
   await c.query(`INSERT INTO ada_points.projection_journal(ada_code,old_value,new_value,generation,revision)
    SELECT ada_code,old_value,new_value,generation::bigint,revision FROM jsonb_to_recordset($1::jsonb) AS j(ada_code text,old_value jsonb,new_value jsonb,generation text,revision text)`,[JSON.stringify(entries)]);
  }
  await c.query("UPDATE ada_points.global_state SET observed_at=$1,state='ready',revision=$2,updated_at=clock_timestamp() WHERE singleton",[projection.observedAt,revision]);
  await fault('beforeCommit');
  const result={ok:true,scope:SCOPE,observedAt:projection.observedAt,revision,sourcePayloadChanges,sourceObservationChanges,openingBaselineChanges:baselineWrites.rowCount,eventChanges:savedEvents.rowCount,retiredEvents:retired.rowCount,balanceChanges:savedValues.rowCount,journalChanges:savedValues.rowCount,globalHeartbeatChanges:1,ready:values.filter(v=>v.state==='ready').length,review:values.filter(v=>v.state==='review').length};
  await c.query('COMMIT');committed=true;await fault('afterCommit',result);return result;
 }catch(e){if(!committed)await c.query('ROLLBACK').catch(()=>{});throw e;}finally{release();}
}
async function markUnavailable(db){const {c,release}=await acquire(db);try{await c.query('BEGIN');await c.query("SELECT pg_advisory_xact_lock(hashtextextended('SCCRM-ADA-PRIMARY-POINTS-V1',0))");await guard(c);await c.query("UPDATE ada_points.global_state SET state='review',updated_at=clock_timestamp() WHERE singleton");await c.query('COMMIT');return {ok:true,state:'review',observedAtPreserved:true};}catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{release();}}
module.exports={SCOPE,MARKER,canonical,hash,guard,validateSnapshots,collectEvents,effectiveValues,applySnapshots,markUnavailable};
