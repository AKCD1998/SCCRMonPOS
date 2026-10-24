'use strict';
// Sandbox adapter and reconciliation prototype; no production entry point.
const fs=require('node:fs');const path=require('node:path');const crypto=require('node:crypto');const readline=require('node:readline');const{spawn}=require('node:child_process');const{createRequire}=require('node:module');
const load=require;
const uuid=()=>crypto.randomUUID();const fields=['name','phone','email'];
const same=(a,b)=>fields.every(k=>(a[k]||'')===(b[k]||''));
const digits=s=>(s||'').replace(/\D/g,'').replace(/^66(?=\d{9}$)/,'0');
const receiptId=(s)=>{const h=crypto.createHash('sha256').update(s).digest('hex').slice(0,32);return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;};
function refuse(code){const e=new Error(code);e.code=code;throw e;}
class SqlCopy{
 constructor(configFile=process.env.SCCRM_SYNC_CONFIG,setup=false){
  this.pending=new Map();this.sequence=0;
  const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>k.toLowerCase()!=='psmodulepath'));env.PSModulePath='C:\\Windows\\SysWOW64\\WindowsPowerShell\\v1.0\\Modules;C:\\Program Files\\WindowsPowerShell\\Modules';
  this.child=spawn('C:/Windows/SysWOW64/WindowsPowerShell/v1.0/powershell.exe',['-NoProfile','-File',path.join(__dirname,'SqlRpc.ps1'),'-ConfigFile',configFile,...(setup?['-Setup']:[])],{env,windowsHide:true,stdio:['pipe','pipe','pipe']});
  readline.createInterface({input:this.child.stdout}).on('line',line=>{let r;try{r=JSON.parse(line.replace(/^\uFEFF/,''));}catch{return;}const job=this.pending.get(r.id);if(!job)return;this.pending.delete(r.id);clearTimeout(job.timer);if(r.ok)job.resolve(r.rows);else{const e=new Error(r.code);e.code=r.code;job.reject(e);}});
  this.child.on('exit',()=>{for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(Error('COPY_RPC_ENDED'));}this.pending.clear();});
  this.child.on('error',()=>{for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(Error('COPY_RPC_START_FAILED'));}this.pending.clear();});
  this.child.stderr.on('data',()=>{});
 }
 query(sql,parameters={}){return new Promise((resolve,reject)=>{const id=++this.sequence;const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('COPY_RPC_TIMEOUT'));},10000);this.pending.set(id,{resolve,reject,timer});this.child.stdin.write(JSON.stringify({id,sql,parameters})+'\n');});}
 close(){this.child.stdin.end(JSON.stringify({action:'close'})+'\n');}
}
class Bridge{
 constructor(pg,ada){this.pg=pg;this.ada=ada;}
 async pgProfile(id){const r=(await this.pg.query('SELECT full_name AS name,phone_number AS phone,email FROM users WHERE id=$1',[id])).rows[0];if(!r)refuse('PG_MEMBER_MISSING');return Object.fromEntries(fields.map(k=>[k,r[k]||'']));}
 async adaProfile(code){const r=(await this.ada.query('SELECT FTCstName AS name,FTCstTel AS phone,FTCstEmail AS email FROM dbo.TCNMCst WHERE FTCstCode=@code',{code}))[0];if(!r)refuse('ADA_MEMBER_MISSING');return Object.fromEntries(fields.map(k=>[k,r[k]||'']));}
 async map(id,code,baseline=true){
  const p=await this.pgProfile(id),a=await this.adaProfile(code);
  await this.pg.query('INSERT INTO sync_member_state(user_id,ada_code,pg_base,ada_base) VALUES($1,$2,$3,$4) ON CONFLICT(user_id) DO NOTHING',[id,code,baseline?p:{},baseline?a:{}]);
  const actual=(await this.pg.query('SELECT ada_code FROM sync_member_state WHERE user_id=$1',[id])).rows[0];if(actual.ada_code!==code)refuse('MAPPING_CHANGE_REFUSED');
  const adaLinks=await this.ada.query('SELECT member_id,ada_code FROM dbo.SCCRM_MemberLink WHERE member_id=@id OR ada_code=@code',{id,code});
  if(adaLinks.some(r=>r.member_id!==id||r.ada_code!==code))refuse('MAPPING_CHANGE_REFUSED');
  if(!adaLinks.length)await this.ada.query('INSERT dbo.SCCRM_MemberLink(member_id,ada_code,source_version,payload_hash) VALUES(@id,@code,1,@hash)',{id,code,hash:'0'.repeat(64)});
 }
 async validatePhone(id,code,desired,baselineP,baselineA){
  const allAda=await this.ada.query('SELECT FTCstCode AS code,FTCstTel AS phone FROM dbo.TCNMCst');
  const reviewed=(await this.pg.query('SELECT ada_code,phone FROM sync_reviewed_ada_aliases WHERE user_id=$1',[id])).rows;
  if(allAda.some(r=>r.code!==code&&digits(r.phone)===digits(desired.phone)&&!reviewed.some(a=>a.ada_code===r.code&&digits(a.phone)===digits(desired.phone))))refuse('PHONE_MATCH_REQUIRES_REVIEW');
  const allPg=(await this.pg.query('SELECT id,phone_number AS phone FROM users WHERE id<>$1',[id])).rows;
  if(allPg.some(r=>digits(r.phone)===digits(desired.phone)))refuse('PHONE_MATCH_REQUIRES_REVIEW');
 }
 async writePgProfile(id,next,expected){
  const r=await this.pg.query(`UPDATE users SET full_name=$2,phone_number=$3,email=NULLIF($4,''),updated_at=now()
   WHERE id=$1 AND full_name=$5 AND COALESCE(phone_number,'')=$6 AND COALESCE(email,'')=$7 RETURNING id`,[id,next.name,next.phone,next.email,expected.name,expected.phone,expected.email]);
  if(r.rowCount!==1)refuse('PROFILE_CHANGED_DURING_SYNC');
 }
 async writeAdaProfile(code,next,expected){await this.ada.query(`EXEC dbo.SCCRM_BidiApplyProfile @Code=@code,@Name=@name,@Phone=@phone,@Email=@email,
  @ExpectedName=@oldName,@ExpectedPhone=@oldPhone,@ExpectedEmail=@oldEmail`,{code,...next,oldName:expected.name,oldPhone:expected.phone,oldEmail:expected.email});}
 async syncProfile(id){
  const state=(await this.pg.query('SELECT * FROM sync_member_state WHERE user_id=$1',[id])).rows[0];if(!state)refuse('MAPPING_REQUIRED');
  const p=await this.pgProfile(id),a=await this.adaProfile(state.ada_code),next={},decisions=[];
  for(const key of fields){
   const pChanged=p[key]!==state.pg_base[key],aChanged=a[key]!==state.ada_base[key];
   let value;if(pChanged&&aChanged&&p[key]!==a[key]){value=p[key];decisions.push({field:key,decision:'supabase_wins_conflict'});}
   else if(pChanged)value=p[key];else if(aChanged)value=a[key];else value=p[key]||a[key];
   if(!value){value=p[key]||a[key]||state.pg_base[key]||state.ada_base[key]||'';if(value)decisions.push({field:key,decision:'blank_cannot_erase_existing'});}
   next[key]=value;
  }
  if(!next.name||!/^\+?[\d -]{9,30}$/.test(next.phone)||next.email.length>100||next.name.length>200)refuse('PROFILE_NOT_REPRESENTABLE');
  if(next.phone!==p.phone||next.phone!==a.phone)await this.validatePhone(id,state.ada_code,next,state.pg_base,state.ada_base);
  // Validate and write the narrower Thai-varchar destination first.
  if(!same(next,a))await this.writeAdaProfile(state.ada_code,next,a);
  if(!same(next,p))await this.writePgProfile(id,next,p);
  await this.pg.query('UPDATE sync_member_state SET pg_base=$2,ada_base=$2 WHERE user_id=$1',[id,next]);
  if(decisions.length)await this.pg.query('INSERT INTO sync_profile_audit(user_id,decisions) VALUES($1,$2)',[id,JSON.stringify(decisions)]);
  return {profile:next,decisions,writes:Number(!same(next,p))+Number(!same(next,a))};
 }
 async createAdaForPg(id){
  const existing=(await this.pg.query('SELECT ada_code FROM sync_member_state WHERE user_id=$1',[id])).rows[0];if(existing)return existing.ada_code;
  const p=await this.pgProfile(id),code='SCM-'+id.replace(/-/g,'').slice(0,8).toUpperCase();
  const all=await this.ada.query('SELECT FTCstCode AS code,FTCstTel AS phone FROM dbo.TCNMCst');
  if(all.some(r=>r.code===code)){
   const own=(await this.ada.query("SELECT FTCstName AS name,FTCstTel AS phone,ISNULL(FTCstEmail,'') AS email,FTWhoIns AS owner FROM dbo.TCNMCst WHERE FTCstCode=@code",{code}))[0];
   if(own.owner==='SCCRM_SYNC_CREATE'&&same(own,p)){await this.map(id,code);return code;}
   refuse('EXISTING_CUSTOMER_REVIEW_REQUIRED');
  }
  if(all.some(r=>digits(r.phone)===digits(p.phone)))refuse('EXISTING_CUSTOMER_REVIEW_REQUIRED');
  const valid=(await this.ada.query(`SELECT CASE WHEN LEN(@name) BETWEEN 1 AND 200 AND LEN(@phone) BETWEEN 9 AND 30 AND LEN(@email)<=100
   AND CONVERT(varbinary(max),CONVERT(nvarchar(max),CONVERT(varchar(200),@name COLLATE Thai_CI_AS)))=CONVERT(varbinary(max),@name)
   AND CONVERT(varbinary(max),CONVERT(nvarchar(max),CONVERT(varchar(100),@email COLLATE Thai_CI_AS)))=CONVERT(varbinary(max),@email)
   THEN 1 ELSE 0 END AS valid`,p))[0];if(!valid.valid)refuse('PROFILE_NOT_REPRESENTABLE');
  await this.ada.query(`INSERT dbo.TCNMCst(FTCstCode,FTCstName,FTCstTel,FTCstEmail,FTBchCode,FTCstStaActive,FCCstRetPoint,FCCstRetAmt,FCCstWhsPoint,FCCstDailyPoint,FTWhoIns)
   VALUES(@code,@name,@phone,@email,'000','1',0,0,0,0,'SCCRM_SYNC_CREATE')`,{code,...p});
  await this.map(id,code);return code;
 }
 async createPgForAda(code){
  const existing=(await this.pg.query('SELECT user_id FROM sync_member_state WHERE ada_code=$1',[code])).rows[0];if(existing)return existing.user_id;
  if((await this.pg.query('SELECT 1 FROM sync_legacy_ada_codes WHERE ada_code=$1',[code])).rowCount)refuse('EXISTING_MEMBER_REVIEW_REQUIRED');
  const a=await this.adaProfile(code),recoveredId=receiptId('ada-member:'+code);
  const recovered=(await this.pg.query('SELECT full_name name,phone_number phone,COALESCE(email,\'\') email FROM users WHERE id=$1',[recoveredId])).rows[0];
  if(recovered&&same(recovered,a)){await this.map(recoveredId,code);return recoveredId;}
  const others=(await this.pg.query('SELECT phone_number FROM users')).rows;
  if(others.some(r=>digits(r.phone_number)===digits(a.phone)))refuse('EXISTING_MEMBER_REVIEW_REQUIRED');
  const id=receiptId('ada-member:'+code);await this.pg.query('BEGIN');try{
   await this.pg.query('INSERT INTO users(id,full_name,phone_number,email,is_verified) VALUES($1,$2,$3,NULLIF($4,\'\'),false) ON CONFLICT(id) DO NOTHING',[id,a.name,a.phone,a.email]);
   await this.pg.query('INSERT INTO member_profiles(user_id,member_code) VALUES($1,$2) ON CONFLICT(user_id) DO NOTHING',[id,'SCM-'+id.replace(/-/g,'').slice(0,8).toUpperCase()]);
   await this.pg.query('COMMIT');
  }catch(e){await this.pg.query('ROLLBACK');throw e;}
  await this.map(id,code);return id;
 }
 async pgApplyPoint(id,key,amount,receipt){
  if(!Number.isInteger(amount)||Math.abs(amount)>2147483647)refuse('POINT_RANGE_REFUSED');
  await this.pg.query('BEGIN');try{
   await this.pg.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[id]);
   const prior=(await this.pg.query('SELECT * FROM sync_point_receipt WHERE receipt_id=$1',[receipt])).rows[0];
   if(prior){if(prior.event_key!==key||prior.user_id!==id||prior.target_amount!==amount)refuse('RECEIPT_REUSE_REFUSED');await this.pg.query('COMMIT');return {outcome:'duplicate',delta:0};}
   const state=(await this.pg.query('SELECT * FROM sync_point_state WHERE event_key=$1 FOR UPDATE',[key])).rows[0];
   if(state&&state.user_id!==id)refuse('POINT_MEMBER_CHANGE_REFUSED');const delta=amount-(state?.applied_amount||0);
   if(Math.abs(delta)>2147483647)refuse('POINT_RANGE_REFUSED');
   const balance=Number((await this.pg.query('SELECT COALESCE(SUM(amount),0) AS n FROM point_ledger WHERE user_id=$1',[id])).rows[0].n);
   if(balance+delta<0)refuse('INSUFFICIENT_POINTS_REVIEW_REQUIRED');
  if(delta)await this.pg.query("INSERT INTO point_ledger(id,user_id,amount,type,reference_id,note,created_by) VALUES($1,$2,$3,'adjustment',$4,'sandbox sync','SCCRM_SYNC')",[receipt,id,delta,key]);
   await this.pg.query('INSERT INTO sync_point_state(event_key,user_id,applied_amount) VALUES($1,$2,$3) ON CONFLICT(event_key) DO UPDATE SET applied_amount=EXCLUDED.applied_amount',[key,id,amount]);
   await this.pg.query('INSERT INTO sync_point_receipt(receipt_id,event_key,user_id,target_amount,applied_delta) VALUES($1,$2,$3,$4,$5)',[receipt,key,id,amount,delta]);
   await this.pg.query('COMMIT');return {outcome:'applied',delta};
  }catch(e){await this.pg.query('ROLLBACK');throw e;}
 }
 async applyPoint(side,id,key,amount,receipt){
  if(side==='pg')return this.pgApplyPoint(id,key,amount,receipt);
  const s=(await this.pg.query('SELECT ada_code FROM sync_member_state WHERE user_id=$1',[id])).rows[0];if(!s)refuse('MAPPING_REQUIRED');
  return (await this.ada.query('EXEC dbo.SCCRM_BidiApplyPoint @ReceiptId=@receipt,@EventKey=@key,@Code=@code,@TargetAmount=@amount',{receipt,key,code:s.ada_code,amount}))[0];
 }
 async publishNative(side,id,businessKey,amount,version=1,eventId=uuid()){
  const key=id+'|'+businessKey;if(key.length>200)refuse('EVENT_KEY_TOO_LONG');
  const old=(await this.pg.query('SELECT * FROM sync_point_sources WHERE user_id=$1 AND event_key=$2 AND origin=$3',[id,key,side])).rows[0];
  if(old&&version<old.source_version)return 'stale_ignored';
  if(old&&version===old.source_version){if(old.amount!==amount)refuse('SOURCE_VERSION_CONFLICT');return 'unchanged';}
  await this.applyPoint(side,id,key,amount,eventId);
  await this.pg.query('INSERT INTO sync_point_sources(user_id,event_key,origin,source_version,amount,origin_event_id) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(user_id,event_key,origin) DO UPDATE SET source_version=EXCLUDED.source_version,amount=EXCLUDED.amount,origin_event_id=EXCLUDED.origin_event_id',[id,key,side,version,amount,eventId]);
  return 'recorded';
 }
 async syncPoints({failAfterFirst=false}={}){
  const all=(await this.pg.query('SELECT * FROM sync_point_sources ORDER BY event_key,origin')).rows;const canonical=new Map();
  for(const e of all){const prior=canonical.get(e.event_key);if(!prior||e.origin==='pg')canonical.set(e.event_key,e);}
  let count=0;
  for(const e of canonical.values()){
   for(const side of ['pg','ada']){
    await this.applyPoint(side,e.user_id,e.event_key,e.amount,receiptId(`${side}|${e.origin_event_id}|${e.event_key}|${e.amount}`));
    count++;if(failAfterFirst)refuse('SIMULATED_ACK_LOSS');
   }
  }return count;
 }
 async balances(id){const p=Number((await this.pg.query('SELECT COALESCE(SUM(amount),0) AS n FROM point_ledger WHERE user_id=$1',[id])).rows[0].n);const code=(await this.pg.query('SELECT ada_code FROM sync_member_state WHERE user_id=$1',[id])).rows[0].ada_code;const a=(await this.ada.query('SELECT FNPntPoint AS n FROM dbo.VCN_TCNMPdtCstPointAmt WHERE FTCstCode=@code',{code}))[0].n;return {pg:p,ada:Number(a)};}
}
module.exports={SqlCopy,Bridge,uuid,same,receiptId};
