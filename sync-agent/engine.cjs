'use strict';
const crypto=require('node:crypto');const {Bridge,receiptId,same}=require('./bridge.cjs');const {MARKER}=require('./config.cjs');
const hash=x=>crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
const business=(ref,fallback)=>/^S\d{10}-\d{7}$/.test(ref||'')?'receipt:'+ref:fallback;
const integer=n=>{n=Number(n);if(!Number.isSafeInteger(n)||Math.abs(n)>2147483647)throw Error('POINT_RANGE_REFUSED');return n;};
class Engine{
 constructor(pg,ada){this.pg=pg;this.ada=ada;this.bridge=new Bridge(pg,ada);this.blockedMembers=new Set();}
 async guard(){const m=(await this.pg.query('SELECT marker FROM sync_worker_meta')).rows;if(m.length!==1||m[0].marker!==MARKER)throw Error('PG_COPY_MARKER_REQUIRED');await this.ada.query('SELECT DB_NAME() n');}
 async review(key,error){const code=/^[A-Z_]{3,80}$/.test(error.code||error.message)?(error.code||error.message):'OPERATION_REQUIRES_REVIEW';await this.pg.query('INSERT INTO sync_reviews(key,code) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET code=EXCLUDED.code,last_seen=now(),attempts=sync_reviews.attempts+1',[key,code]);}
 async members(){
  const p=(await this.pg.query("SELECT u.id,u.full_name name,COALESCE(u.phone_number,'') phone,COALESCE(u.email,'') email FROM users u JOIN member_profiles m ON m.user_id=u.id WHERE m.is_active=true ORDER BY u.id LIMIT 1001")).rows;if(p.length>1000)throw Error('MEMBER_SCOPE_LIMIT');
  for(const m of p)try{await this.bridge.createAdaForPg(m.id);}catch(e){await this.review('member:pg:'+m.id,e);}
  const a=await this.ada.query("SELECT TOP(1001) FTCstCode code,ISNULL(FTCstName,'') name,ISNULL(FTCstTel,'') phone,ISNULL(FTCstEmail,'') email FROM dbo.TCNMCst ORDER BY FTCstCode");if(a.length>1000)throw Error('MEMBER_SCOPE_LIMIT');
  for(const m of a)try{await this.bridge.createPgForAda(m.code);}catch(e){if(e.message!=='EXISTING_MEMBER_REVIEW_REQUIRED')await this.review('member:ada:'+m.code,e);}
  for(const m of (await this.pg.query('SELECT * FROM sync_member_state ORDER BY user_id')).rows)try{const pp=p.find(v=>v.id===m.user_id),aa=a.find(v=>v.code===m.ada_code);if(pp&&aa&&same(pp,m.pg_base)&&same(aa,m.ada_base))continue;await this.bridge.syncProfile(m.user_id);}catch(e){await this.review('profile:'+m.user_id,e);}
 }
 async observePg(row,baseline){
  const raw='pg:'+row.id,key=row.user_id+'|'+business(row.reference_id,raw),amount=integer(row.amount),digest=hash(row);
  await this.pg.query('BEGIN');try{
   const old=(await this.pg.query('SELECT payload_hash FROM sync_native_observed WHERE raw_key=$1 FOR UPDATE',[raw])).rows[0];
   if(old){if(old.payload_hash!==digest)throw Error('NATIVE_EVENT_MUTATION_REVIEW');await this.pg.query('COMMIT');return;}
   await this.pg.query('INSERT INTO sync_native_observed VALUES($1,$2,$3,$4,$5,$6)',[raw,key,row.user_id,amount,digest,baseline]);
   if(!baseline)await this.pg.query('INSERT INTO sync_point_state(event_key,user_id,applied_amount) VALUES($1,$2,$3) ON CONFLICT(event_key) DO UPDATE SET applied_amount=sync_point_state.applied_amount+EXCLUDED.applied_amount WHERE sync_point_state.user_id=EXCLUDED.user_id',[key,row.user_id,amount]);
   await this.pg.query('COMMIT');
  }catch(e){await this.pg.query('ROLLBACK');throw e;}
 }
 async capture(baseline=false){
  const mappings=(await this.pg.query('SELECT user_id,ada_code FROM sync_member_state')).rows,map=new Map(mappings.map(m=>[m.ada_code,m.user_id]));
  const pgRows=(await this.pg.query("SELECT id,user_id,amount,type,reference_id FROM point_ledger WHERE created_by NOT IN ('SCCRM_SYNC','SCCRM_BASELINE') ORDER BY id LIMIT 1001")).rows;if(pgRows.length>1000)throw Error('POINT_SCOPE_LIMIT');
  for(const p of pgRows){if(!mappings.some(m=>m.user_id===p.user_id))continue;try{await this.observePg(p,baseline);}catch(e){this.blockedMembers.add(p.user_id);await this.review('point:pg:'+p.id,e);}}
  const observed=new Map((await this.ada.query('SELECT raw_key,payload_hash FROM dbo.SCCRM_ObservedNative')).map(r=>[r.raw_key,r.payload_hash]));
  const rows=await this.ada.query("SELECT TOP(1001) FTBchCode branch,FTCstCode code,FTPntRefDoc doc,FTSplCode supplier,FNPntPoint points,FTPntCardType type,FTPntExpired expired,FTPntStaPrcDoc processed FROM dbo.TCNTCstPoint WHERE ISNULL(FTWhoIns,'')<>'SCCRM_SYNC' ORDER BY FTBchCode,FTCstCode,FTPntRefDoc,FTSplCode");if(rows.length>1000)throw Error('POINT_SCOPE_LIMIT');
  for(const r of rows){
   const id=map.get(r.code);if(!id)continue;const raw=hash([r.branch,r.code,r.doc,r.supplier]);
   try{
    if(!['1','2'].includes(r.type)||r.expired!=='N'||r.processed!=='N')throw Error('POINT_SEMANTICS_REVIEW_REQUIRED');
    if(Number(r.points)<0)throw Error('POINT_RANGE_REFUSED');const amount=integer(r.points)*(r.type==='1'?1:-1),key=id+'|'+business(r.doc,'ada:'+raw);
    const digest=hash(r);if(observed.has(raw)){if(observed.get(raw)!==digest)throw Error('NATIVE_EVENT_MUTATION_REVIEW');continue;}
    await this.ada.query('EXEC dbo.SCCRM_ObservePoint @RawKey=@raw,@EventKey=@key,@MemberId=@id,@Code=@code,@Amount=@amount,@Hash=@hash,@Baseline=@baseline',{raw,key,id,code:r.code,amount,hash:digest,baseline:baseline?1:0});
   }catch(e){this.blockedMembers.add(id);await this.review('point:ada:'+raw,e);}
  }
  for(const side of ['pg','ada']){
   const observations=side==='pg'?(await this.pg.query('SELECT user_id,event_key,SUM(amount)::integer amount,COUNT(*)::integer version FROM sync_native_observed WHERE baseline=false GROUP BY user_id,event_key')).rows:await this.ada.query('SELECT member_id user_id,event_key,SUM(amount) amount,COUNT(*) version FROM dbo.SCCRM_ObservedNative WHERE baseline=0 GROUP BY member_id,event_key');
   for(const o of observations){const amount=integer(o.amount);await this.pg.query("INSERT INTO sync_point_sources(user_id,event_key,origin,source_version,amount,origin_event_id) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(user_id,event_key,origin) DO UPDATE SET source_version=EXCLUDED.source_version,amount=EXCLUDED.amount,origin_event_id=EXCLUDED.origin_event_id WHERE sync_point_sources.source_version<EXCLUDED.source_version",[o.user_id,o.event_key,side,Number(o.version),amount,receiptId(side+'|'+o.event_key+'|'+o.version+'|'+amount)]);}
  }
 }
 async reconcile(){
  const rows=(await this.pg.query('SELECT * FROM sync_point_sources ORDER BY event_key,origin')).rows,canonical=new Map();for(const e of rows){if(!canonical.has(e.event_key)||e.origin==='pg')canonical.set(e.event_key,e);}
  const pgReceipts=new Map((await this.pg.query('SELECT receipt_id,event_key,user_id,target_amount FROM sync_point_receipt')).rows.map(r=>[r.receipt_id,r]));
  const adaReceipts=new Map((await this.ada.query('SELECT receipt_id,event_key,ada_code,target_amount FROM dbo.SCCRM_BidiPointReceipt')).map(r=>[r.receipt_id.toLowerCase(),r]));const codes=new Map((await this.pg.query('SELECT user_id,ada_code FROM sync_member_state')).rows.map(r=>[r.user_id,r.ada_code]));
  for(const e of canonical.values()){
   if(this.blockedMembers.has(e.user_id))continue;
   try{for(const side of ['pg','ada']){const receipt=receiptId(`${side}|${e.origin_event_id}|${e.event_key}|${e.amount}`),old=(side==='pg'?pgReceipts:adaReceipts).get(receipt);if(old&&old.event_key===e.event_key&&Number(old.target_amount)===Number(e.amount)&&(side==='pg'?old.user_id===e.user_id:old.ada_code===codes.get(e.user_id)))continue;await this.bridge.applyPoint(side,e.user_id,e.event_key,e.amount,receipt);}}
   catch(error){this.blockedMembers.add(e.user_id);await this.review('delivery:'+e.event_key,error);}
  }
 }
 async cycle(){this.blockedMembers.clear();await this.guard();await this.members();await this.capture();await this.reconcile();return {mapped:Number((await this.pg.query('SELECT COUNT(*) n FROM sync_member_state')).rows[0].n),reviews:Number((await this.pg.query('SELECT COUNT(*) n FROM sync_reviews')).rows[0].n)};}
}
module.exports={Engine,business,integer,hash};
