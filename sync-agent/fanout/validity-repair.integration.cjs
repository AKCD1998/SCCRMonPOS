'use strict';
// Explicit, owned SQL copies only; original customer/PIN data never leaves SQL
// except named non-secret profile fields of newly generated .invalid fixtures.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const lab=require('./copy-lab.cjs');
const {localSecrets}=require('./secrets.cjs');
const {readAdmin}=require('./admin-source.cjs');
const {NativeReceiver}=require('./sql-adapter.cjs');
const {hqCodeFor,profileHash}=require('./engine.cjs');
const {repairOwnedValidity}=require('./validity-repair.cjs');
async function run(){
 const state=localSecrets(),t=state.copy?.targetConfigs?.find(t=>t.branchCode==='005');
 if(t?.mode!=='copy'||t.connection.database!=='SCCRM_FanoutCopy_20261029_005')throw Error('VALIDITY_COPY_CONFIG_REQUIRED');
 const report={scope:'SCCRM-VALIDITY-REPAIR-COPY-ONLY',policy:'calendar-years-100',checks:[],productionWrites:0,pinRead:false};
 const check=(ok,name)=>{report.checks.push({name,ok:!!ok});if(!ok)throw Error('VALIDITY_COPY_ASSERTION_FAILED');};
 const nonce=crypto.randomBytes(5).toString('hex'),tag='validity-'+nonce;
 const target={identity:t.databaseIdentity,server:t.connection.server,machine:'SERVER',database:t.connection.database,branch:'005'};
 const admin=readAdmin('000'),receiver=new NativeReceiver({mode:'copy',connection:t.connection});
 const query=async(sql,parameters)=>{const r=await lab.query('005',sql,parameters);return r.results[0]||[];};
 const dates=code=>query('SELECT CONVERT(varchar(10),FDCstCrdIssue,23) issue,CONVERT(varchar(10),FDCstCrdExpire,23) expiry,CASE WHEN FDCstCrdExpire=DATEADD(year,100,FDCstCrdIssue) AND FDCstCrdIssue=CONVERT(datetime,CONVERT(varchar(8),FDDateIns,112),112) THEN 1 ELSE 0 END exact_policy,CASE WHEN ISNULL(FTCstStaActive,\'\')<>\'2\' AND ISNULL(FDCstCrdExpire,\'19000101\')>=CONVERT(datetime,CONVERT(varchar(8),GETDATE(),112),112) THEN 1 ELSE 0 END eligible FROM dbo.TCNMCst WHERE FTCstCode=@code',{code});
 const fixture=async label=>{const id=crypto.randomUUID(),code=hqCodeFor(id),profile={name:'COPY validity '+nonce+' '+label,phone:'099'+String(crypto.randomInt(10000000)).padStart(7,'0'),email:nonce+'-'+label+'@example.invalid'},hash=profileHash(profile);await receiver.receive({member_id:id,hq_code:code,profile,profile_hash:hash});return {memberId:id,adaCode:code,profileHash:hash};};
 const repair=members=>repairOwnedValidity({mode:'Copy',target,admin,members});
 const rejected=async(action,pattern,name)=>{let code;try{await action();}catch(e){code=e.code||e.message;}check(typeof code==='string'&&pattern.test(code),name);};
 try{
  await lab.snapshot('005',{copy:true,baselineTag:tag});
  const item=await fixture('missing');check((await dates(item.adaCode))[0].exact_policy===1,'receiver creates native calendar-year validity');
  await query('UPDATE dbo.TCNMCst SET FDCstCrdIssue=NULL,FDCstCrdExpire=NULL WHERE FTCstCode=@code',{code:item.adaCode});
  check((await dates(item.adaCode))[0].eligible===0,'NULL expiry reproduces actual AdaPos exclusion');
  const first=repair([item]);check(first.ok&&first.members[0].outcome==='populated-owned-dates'&&first.members[0].otherColumnsPreserved===99,'guarded repair changes only owned missing dates');
  const after=await dates(item.adaCode);check(after[0].eligible===1&&after[0].exact_policy===1,'repaired copy passes actual native expiry predicate');
  const again=repair([item]);check(again.members[0].outcome==='already-valid'&&JSON.stringify(await dates(item.adaCode))===JSON.stringify(after),'repair replay preserves exact issue and expiry');
  await rejected(()=>repair([{...item,profileHash:'0'.repeat(64)}]),/OWNED_PROFILE_CHANGED/,'wrong mapping fingerprint cannot repair');
  await rejected(()=>repair([{...item,adaCode:'AR001-000002'}]),/MEMBER_IDENTITY_REFUSED/,'ordinary existing Ada code cannot enter repair');
  await rejected(()=>repairOwnedValidity({mode:'Live',target,admin,members:[item]}),/LIVE_PILOT_ONLY/,'live mode cannot accept a copy target or missing pilot approval');
  const mismatch=await fixture('changed');await query('UPDATE dbo.TCNMCst SET FDCstCrdIssue=NULL,FDCstCrdExpire=NULL,FTCstName=@name WHERE FTCstCode=@code',{code:mismatch.adaCode,name:'Changed COPY '+nonce});
  await rejected(()=>repair([mismatch]),/OWNED_PROFILE_CHANGED/,'changed native profile is held without repair');check((await dates(mismatch.adaCode))[0].issue===null,'changed profile retains missing dates');
  const partial=await fixture('partial');await query('UPDATE dbo.TCNMCst SET FDCstCrdExpire=NULL WHERE FTCstCode=@code',{code:partial.adaCode});
  const beforePartial=await dates(partial.adaCode);await rejected(()=>repair([partial]),/EXISTING_DATES_REVIEW/,'partially populated dates are held');check(JSON.stringify(await dates(partial.adaCode))===JSON.stringify(beforePartial),'partial date is not overwritten');
  const p=await lab.verify('005',{copy:true,baselineTag:tag});report.preservation=p.proof;check(p.ok&&p.proof.columnsChecked===101,'all earlier copy customers retain all 101 non-PIN columns');
  report.ok=true;
 }catch(e){report.ok=false;report.code=/^[A-Z_]+$/.test(e.message)?e.message:'VALIDITY_COPY_FAILED';throw Object.assign(e,{report});}
 finally{receiver.close();admin.password='';report.passed=report.checks.filter(c=>c.ok).length;fs.writeFileSync(path.join(__dirname,'runtime/validity-repair-copy-result.json'),JSON.stringify(report,null,2));}
 return report;
}
if(require.main===module)run().then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(JSON.stringify(e.report||{ok:false,code:'VALIDITY_COPY_FAILED'}));process.exitCode=1;});
module.exports={run};
