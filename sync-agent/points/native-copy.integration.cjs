'use strict';
// Explicit fixed SQL copies only. This file never passes mode Live to a writer.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {invokeNative}=require('./native-adapter.cjs');
const {readAdmin}=require('../fanout/admin-source.cjs');
const {BRANCHES,RUNTIME,privateRuntime,safeCode}=require('./export.cjs');
const {projectNativePoints}=require('./projection.cjs');
async function run(){
 privateRuntime();const state=JSON.parse(fs.readFileSync(path.join(RUNTIME,'native-copy.secrets.json')));let passed=0;
 const check=(yes,message)=>{assert.ok(yes,message);passed++;};
 const admin=readAdmin('000'),targets=BRANCHES.map(branch=>({branch,server:admin.server,machine:admin.machine,database:'SCCRM_PointCopy_20261102_'+branch,identity:'copy'+branch+'/SERVER/SCCRM_PointCopy_20261102_'+branch}));
 const credentials=t=>({user:'sccrm_point_copy_'+t.branch,password:state.copies[t.branch].password});
 const call=(t,action,job,privileged=false)=>invokeNative({mode:'Copy',target:t,credentials:privileged?{user:admin.user,password:admin.password}:credentials(t),action,job,adaCode:'AR000-000017'});
 const report={scope:'SCCRM-ADA-POINT-NATIVE-COPY-20261102',at:new Date().toISOString(),ok:false,productionWrites:0,pinRead:false};
 try{
  // 005 was provisioned before the generation protocol landed; upgrade only
  // its still-empty marked receipt/head tables. Never reseed an advanced copy.
  await call(targets.find(t=>t.branch==='005'),'upgrade-copy',null,true);
  const before=await Promise.all(targets.map(t=>call(t,'baseline',null,true)));
  const rights=await Promise.all(targets.map(t=>call(t,'rights')));
  for(const r of rights)check(r.sysadmin===0&&r.live_access===0&&r.customer_update===0&&r.point_insert===0&&r.receiver_execute===1,'least privilege and AdaAcc denied');
  const snapshots=BRANCHES.map(b=>JSON.parse(fs.readFileSync(path.join(RUNTIME,'native-live-'+b+'.json'))));
  const ownerMap=JSON.parse(fs.readFileSync(path.join(RUNTIME,'approved-owner-map.json'))).rows;
  const projection=projectNativePoints(snapshots,{allowNativeHomeBranch:true,ownerMap});
  const b=projection.balances.find(b=>b.adaCode==='AR000-000017');check(b.state==='ready'&&b.balanceExact==='7','verified native seven-point member');
  const jobs=targets.map(t=>({operationId:crypto.randomUUID(),adaCode:b.adaCode,targetBalance:b.balanceExact,expectedIntrinsic:snapshots.find(s=>s.branch===t.branch).balances.find(v=>v.FTCstCode===b.adaCode).FNPntPoint,generation:'1',projectionVersion:b.version}));
  const first=await Promise.all(targets.map((t,i)=>call(t,'apply',jobs[i])));
  for(const r of first)check(r.outcome==='applied'&&r.target_balance==='7','all target native views readback seven');
  const replay=await Promise.all(targets.map((t,i)=>call(t,'apply',jobs[i])));
  for(const r of replay)check(r.outcome==='replayed','lost ACK and process restart replay');
  const t=targets.find(t=>t.branch==='005'),old=jobs.find((_,i)=>targets[i]===t);
  await call(t,'copy-race-event',null,true);
  let moved;try{await call(t,'apply',{...old,operationId:crypto.randomUUID(),generation:'2',targetBalance:'10',projectionVersion:crypto.createHash('sha256').update('copy-race10').digest('hex')});}catch(e){moved=e.code;}
  check(moved==='POINT_RECEIVER_SOURCE_MOVED_RETRY','native award concurrent with snapshot refuses stale expected balance');
  const next={...old,operationId:crypto.randomUUID(),generation:'2',expectedIntrinsic:String(Number(old.expectedIntrinsic)+3),targetBalance:'10',projectionVersion:crypto.createHash('sha256').update('copy-race10').digest('hex')};
  const updated=await call(t,'apply',next);check(updated.outcome==='applied'&&updated.delta_points==='0','native new award reconciled without duplicate point credit');
  const stale=await call(t,'apply',{...old,operationId:crypto.randomUUID()});check(stale.outcome==='superseded','older delivery cannot replace newer generation');
  let reused;try{await call(t,'apply',{...next,targetBalance:'11'});}catch(e){reused=e.code;}
  check(reused==='POINT_RECEIVER_OPERATION_REUSED','operation payload collision refused');
  const after=await Promise.all(targets.map(t=>call(t,'baseline',null,true)));
  report.preservation=Object.fromEntries(targets.map((t,i)=>{const a=after[i],b=before[i];check(a.customerColumns===101&&a.customerCount===b.customerCount&&a.customerHash===b.customerHash,'all original customer columns unchanged');check(a.originalEvents===b.originalEvents&&a.originalEventHash===b.originalEventHash,'original native events unchanged');return [t.branch,{...a,unchanged:true}];}));
  report.ok=true;report.passed=passed;report.memberCode=b.adaCode;report.initialPointBalance=b.balanceExact;report.nativeRaceFinalBalance='10';report.rights=Object.fromEntries(targets.map((t,i)=>[t.branch,rights[i]]));
 }catch(e){report.code=safeCode(e);report.stage=e.stage;report.sqlNumber=e.sqlNumber;report.passed=passed;throw Object.assign(e,{report});}
 finally{admin.password='';fs.writeFileSync(path.join(RUNTIME,'native-copy-result.json'),JSON.stringify(report,null,2));}
 return report;
}
if(require.main===module)run().then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(JSON.stringify(e.report||{ok:false,code:safeCode(e),productionWrites:0}));process.exitCode=1;});
module.exports={run};
