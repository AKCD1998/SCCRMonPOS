'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{Client}=require('pg');
const {credentials,ROOT,RUNTIME}=require('./provision.cjs'),{Source,guard,profile}=require('./worker.cjs');
const {loadSnapshot}=require('../history/source.cjs'),{record}=require('../history/model.cjs');
async function main(){
 const secret=credentials(),source=new Source(path.join(ROOT,'config.json'),secret.sqlPassword);
 const pg=new Client({connectionString:secret.pgUrl,ssl:{rejectUnauthorized:true,ca:fs.readFileSync(path.join(ROOT,'supabase-ca.crt'),'utf8')},connectionTimeoutMillis:8000});
 const baseline=loadSnapshot(path.join(ROOT,'../runtime/history/source-20261024-full-v1')),checks=[];
 const check=(name,value)=>{assert.ok(value,name);checks.push(name);};
 try{
  await pg.connect();await guard(pg);
  const current=new Map();let after=null;
  for(;;){const rows=await source.query('customers',{after});if(!rows.length)break;for(const p of rows)current.set(p.FTCstCode,record('customers',p));after=rows.at(-1).FTCstCode;}
  check('all_1438_original_Ada_customers_unchanged_in_all_101_non_PIN_columns',baseline.records.customers.every(r=>current.get(r.key)?.payloadHash===r.payloadHash));
  const mirrored=new Map((await pg.query('SELECT ada_code,payload_hash FROM ada_history.customers')).rows.map(r=>[r.ada_code,r.payload_hash]));
  check('every_native_customer_matches_mirror',current.size===mirrored.size&&[...current].every(([key,r])=>mirrored.get(key)===r.payloadHash));
  for(const kind of ['receipts','lines']){
   const keys=kind==='receipts'?'receipt_key':'line_key';
   const rows=new Map((await pg.query(`SELECT ${keys} k,payload_hash FROM ada_history.${kind}`)).rows.map(r=>[r.k,r.payload_hash]));
   check('original_'+kind+'_unchanged_and_complete',rows.size===baseline.records[kind].length&&baseline.records[kind].every(r=>rows.get(r.key)===r.payloadHash));
  }
  const totals=(await pg.query("SELECT (SELECT count(*)::int FROM ada_history.customers) customers,(SELECT count(*)::int FROM ada_history.receipts WHERE doc_type='1') sales,(SELECT count(*)::int FROM ada_history.receipts WHERE doc_type='9') returns,(SELECT count(*)::int FROM ada_history.lines) lines")).rows[0];
  const created=(await pg.query("SELECT o.member_id,o.ada_code,u.id,u.full_name,u.phone_number,u.email FROM ada_history.outbound_state o JOIN public.users u ON u.id=o.member_id WHERE o.state='created'")).rows;
  for(const m of created){
   const before=current.get(m.ada_code).payloadHash,answer=(await source.query('createMember',{memberId:m.member_id,...profile(m)}))[0];
   const afterRow=(await source.query('customer',{code:m.ada_code}))[0];
   check('native_retry_returns_same_code_without_overwriting_'+m.ada_code,answer.outcome==='existing'&&answer.ada_code===m.ada_code&&record('customers',afterRow).payloadHash===before);
   check('native_ack_links_back_to_same_SCCRM_member_'+m.ada_code,(await pg.query('SELECT member_id FROM ada_history.member_links WHERE source_id=$1 AND ada_code=$2',['hq000/AdaAcc',m.ada_code])).rows[0]?.member_id===m.member_id);
  }
  const reviews=(await pg.query("SELECT last_code,count(*)::int n FROM ada_history.outbound_state WHERE state='review' GROUP BY last_code")).rows;
  check('conflicting_phones_are_held_for_review',reviews.every(r=>r.last_code==='EXISTING_CUSTOMER_REVIEW_REQUIRED'));
  check('existing_online_account_count_unchanged',(await pg.query('SELECT count(*)::int n FROM public.users')).rows[0].n===7);
  const status=JSON.parse(fs.readFileSync('\\\\100.90.166.72\\D\\SCCRM-HQ-LiveSync-20261024\\live\\status\\status.json'));
  check('restarted_HQ_service_healthy_and_replay_makes_zero_data_changes',status.state==='healthy'&&status.lastCycle.written===0);
  const result={ok:true,at:new Date().toISOString(),passed:checks.length,checks,totals,nativeNewMembers:created.length,reviews,originalAdaCustomersChanged:0,pinRead:false,service:status};
  fs.writeFileSync(path.join(RUNTIME,'verification-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 }finally{source.close();await pg.end();}
}
main().catch(e=>{console.error(JSON.stringify({ok:false,code:e.code||'VERIFICATION_FAILED',check:e.name==='AssertionError'?e.message:undefined}));process.exitCode=1;});
