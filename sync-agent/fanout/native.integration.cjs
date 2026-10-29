'use strict';
// Explicit native-COPY acceptance. It never accepts AdaAcc/live credentials,
// changes a native service, reads PIN, or runs the production worker.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {Pool}=require('pg');
const {PgQueue,FanoutEngine,profileHash,hqCodeFor}=require('./engine.cjs');
const {HqSource,NativeReceiver}=require('./sql-adapter.cjs');
const defaultLab=require('./copy-lab.cjs');
const COPY_PREFIX='SCCRM_FanoutCopy_20261029_';
function requireCopy(ok,name){if(!ok)throw Object.assign(Error(name),{code:name});}
function safeError(e){return /^[A-Z][A-Z0-9_]{2,79}$/.test(e?.code||e?.message||'')?(e.code||e.message):'NATIVE_COPY_CHECK_FAILED';}
function targetConfig(t){const targetId=t.targetId||t.id,branch=t.branchCode||t.branch,databaseIdentity=t.databaseIdentity||t.identity||t.connection?.targetIdentity;
 requireCopy(typeof targetId==='string'&&targetId.length<=100&&['001','003','004','005'].includes(branch)&&typeof databaseIdentity==='string','NATIVE_COPY_TARGET_CONFIG_REFUSED');
 const config={...t,mode:t.mode,connection:{...t.connection}};
 requireCopy(config.mode==='copy'&&config.connection.database===COPY_PREFIX+branch&&config.connection.machine==='SERVER'&&config.connection.targetIdentity===databaseIdentity&&/^sccrm_member_fanout_(001|003|004|005)_copy[a-zA-Z0-9_]*$/.test(config.connection.user),'NATIVE_COPY_TARGET_CONFIG_REFUSED');
 requireCopy(/^(?:tcp:)?(?:100\.90\.166\.72|127\.0\.0\.1),49800$/.test(config.connection.server),'NATIVE_COPY_TARGET_SERVER_REFUSED');
 return {targetId,branch,databaseIdentity,config};
}
async function runNativeIntegration({poolConfig,sourceConfig,targetConfigs,lab=defaultLab}){
 const url=new URL(poolConfig?.connectionString||'invalid:');
 requireCopy(['127.0.0.1','localhost','[::1]'].includes(url.hostname)&&url.port&&url.port!=='5432'&&/^\/sccrm_fanout_test_[a-z0-9_]+$/.test(url.pathname),'NATIVE_COPY_LOCAL_PG_REQUIRED');
 requireCopy(sourceConfig?.mode==='copy'&&sourceConfig.connection?.database===COPY_PREFIX+'000'&&sourceConfig.connection.machine==='SERVER'&&/^sccrm_member_fanout_source_copy[a-zA-Z0-9_]*$/.test(sourceConfig.connection.user),'NATIVE_COPY_SOURCE_CONFIG_REFUSED');
 requireCopy(/^(?:tcp:)?(?:100\.90\.166\.72|127\.0\.0\.1),49800$/.test(sourceConfig.connection.server),'NATIVE_COPY_SOURCE_SERVER_REFUSED');
 requireCopy(Array.isArray(targetConfigs)&&targetConfigs.length>=2,'NATIVE_COPY_SECOND_TARGET_REQUIRED');
 const targets=targetConfigs.map(targetConfig);requireCopy(new Set(targets.map(t=>t.branch)).size===targets.length&&new Set(targets.map(t=>t.targetId)).size===targets.length&&new Set(targets.map(t=>t.databaseIdentity)).size===targets.length,'NATIVE_COPY_TARGET_DUPLICATE');
 const primary=targets.find(t=>t.branch==='005');requireCopy(primary,'NATIVE_COPY_PILOT_TARGET_REQUIRED');const secondary=targets.find(t=>t!==primary);
 const nonce=crypto.randomBytes(6).toString('hex'),tag='native-'+nonce;
 const report={scope:'SCCRM-FANOUT-NATIVE-COPY-ONLY',startedAt:new Date().toISOString(),run:nonce,productionWrites:0,customerPinRead:false,checks:[],fixtures:[],preservation:{},windowsServiceRestartTested:false,membershipPolicy:{years:100,basis:'SQL DATEADD(year,100,issue)',eligibilityProof:'AdaPos search SQL-equivalent',actualNativeUiTested:false},membershipValidityByBranch:{}};
 const check=(ok,name,details={})=>{report.checks.push({name,ok:!!ok,...details});requireCopy(ok,'NATIVE_COPY_ASSERTION_FAILED');};
 let pool,q,source;const engines=new Set(),receivers=new Set(),snapshots=[];let stage='copy-preflight',failure;
 function newReceiver(target){const r=new NativeReceiver(target.config);receivers.add(r);return r;}
 function newEngine(adapters){const errors=[];const e=new FanoutEngine({queue:q,adapters,pollMs:1000,timeoutMs:7500,leaseMs:15000,onError:error=>errors.push(error)});e.testErrors=errors;engines.add(e);return e;}
 async function stopEngine(e){await e.stop();engines.delete(e);}
 async function copyQuery(branch,sql,parameters={}){const result=await lab.query(branch,sql,parameters);requireCopy(result.ok&&result.productionWrites===0&&result.database===COPY_PREFIX+branch,'NATIVE_COPY_LAB_ACK_REFUSED');return result.results||[];}
 async function nativeRows(branch,code){return (await copyQuery(branch,`SELECT FTCstCode,CONVERT(nvarchar(200),FTCstName) name,FTCstTel phone,CONVERT(nvarchar(100),ISNULL(FTCstEmail,'')) email,FCCstRetPoint,FCCstWhsPoint,FCCstDailyPoint,FTCstStaActive active_status,CONVERT(varchar(23),FDCstCrdIssue,126) membership_issue_at,CONVERT(varchar(23),FDCstCrdExpire,126) membership_expires_at,CONVERT(varchar(23),FDDateIns,126) native_created_at,CASE WHEN FDCstCrdIssue IS NOT NULL AND FDCstCrdExpire=DATEADD(year,100,FDCstCrdIssue) THEN 1 ELSE 0 END membership_100_calendar_years,CASE WHEN FDCstCrdIssue IS NOT NULL AND CONVERT(varchar(8),FDCstCrdIssue,112)=CONVERT(varchar(8),FDDateIns,112) THEN 1 ELSE 0 END membership_issue_is_creation_day FROM dbo.TCNMCst WHERE FTCstCode=@code`,{code}))[0]||[];}
 function validity(row){return {issuedAt:row?.membership_issue_at,expiresAt:row?.membership_expires_at};}
 function hasCreationValidity(row){return !!row?.membership_issue_at&&!!row.membership_expires_at&&Number(row.membership_100_calendar_years)===1&&Number(row.membership_issue_is_creation_day)===1;}
 async function nativeSearchRows(branch,code,typedName){
  // Observed AdaPos search predicate. The real view only LEFT JOINs point
  // aggregates and has no row filter; use its TCNMCst equivalent in the copy
  // without selecting/cloning the view's PIN or unrelated columns. This is
  // SQL eligibility evidence, not a claim of a real native UI search.
  return (await copyQuery(branch,`SELECT FTCstCode FROM dbo.TCNMCst WHERE FTCstCode=@code AND ISNULL(FTCstStaActive,'')<>'2' AND ISNULL(FDCstCrdExpire,CONVERT(datetime,'19000101',112))>=CONVERT(datetime,CONVERT(varchar(8),GETDATE(),112),112) AND CHARINDEX(@typedName,FTCstName)>0`,{code,typedName}))[0]||[];
 }
 async function nativeLinks(branch,id){return (await copyQuery(branch,'SELECT CONVERT(varchar(36),member_id) member_id,hq_code,ada_code,target_identity,profile_hash FROM dbo.SCCRM_FanoutMemberLink WHERE member_id=@id',{id}))[0]||[];}
 async function jobs(id){return (await pool.query('SELECT j.*,t.database_identity FROM sccrm_fanout.jobs j JOIN sccrm_fanout.targets t USING(target_id) WHERE member_id=$1 ORDER BY target_id',[id])).rows;}
 async function poll(e,id,predicate,ms=12000){const until=Date.now()+ms;for(;;){await e.tick();const rows=await jobs(id);if(predicate(rows))return rows;if(Date.now()>until)throw Object.assign(Error('NATIVE_COPY_DELIVERY_TIMEOUT'),{code:'NATIVE_COPY_DELIVERY_TIMEOUT',jobStates:rows.map(x=>({target:x.target_id,state:x.state,code:x.last_code}))});await new Promise(resolve=>setTimeout(resolve,30));}}
 async function rejects(action,name,pattern){try{await action();check(false,name);}catch(e){if(e.code==='NATIVE_COPY_ASSERTION_FAILED')throw e;check(pattern.test(safeError(e)),name,{code:safeError(e)});return safeError(e);}}
 async function makeSource(label){
  const id=crypto.randomUUID(),code=hqCodeFor(id),phone='099'+String(crypto.randomInt(10000000)).padStart(7,'0');
  const profile={name:'ทดสอบสำเนา FANOUT '+nonce+' '+label,phone,email:'fanout-'+nonce+'-'+label+'@example.invalid'};
  const created=await copyQuery('000','EXEC dbo.SCCRM_CreateMemberFromSccrm @MemberId=@id,@Name=@name,@Phone=@phone,@Email=@email',{id,name:profile.name,phone,email:profile.email});
  check(created[0]?.length===1&&created[0][0].ada_code===code&&String(created[0][0].member_id).toLowerCase()===id,'owned HQ-copy member creation '+label);
  let cursor=null,found;
  for(let pages=0;pages<100;pages++){const rows=await source.read(cursor);if(!rows.length)break;found=rows.find(r=>r.memberId===id);if(found)break;const last=rows.at(-1);cursor={createdAt:last.hqConfirmedAt,memberId:last.memberId};}
  check(found&&found.hqCode===code&&profileHash(found.profile)===profileHash(profile),'native source adapter exact acknowledgement '+label);
  report.fixtures.push({label,memberId:id,hqCode:code,copyOnly:true});return found;
 }
 async function seedCollision(branch,{code,profile}){
  await copyQuery(branch,`INSERT dbo.TCNMCst(FTCstCode,FTCstName,FTCstTel,FTCstEmail,FTBchCode,FTCstStaActive,FCCstRetPoint,FCCstRetAmt,FCCstWhsPoint,FCCstDailyPoint,FDDateIns,FTTimeIns,FTWhoIns,FDDateUpd,FTTimeUpd,FTWhoUpd) VALUES(@code,@name,@phone,@email,'000','1',0,0,0,0,GETDATE(),CONVERT(varchar(8),GETDATE(),108),'FANOUT_COPY_FIXTURE',GETDATE(),CONVERT(varchar(8),GETDATE(),108),'FANOUT_COPY_FIXTURE')`,{code,name:profile.name,phone:profile.phone,email:profile.email});
 }
 try{
  for(const branch of ['000',...targets.map(t=>t.branch)]){const snapshot=await lab.snapshot(branch,{copy:true,baselineTag:tag});check(snapshot.ok&&snapshot.productionWrites===0&&snapshot.targetCopy===true,'copy baseline captured '+branch);snapshots.push(branch);}
  const proc=(await copyQuery('000',"SELECT OBJECT_ID('dbo.SCCRM_CreateMemberFromSccrm') object_id"))[0]?.[0]?.object_id;
  if(proc==null){await copyQuery('000',fs.readFileSync(path.join(__dirname,'../live/CreateMember.sql'),'utf8').replaceAll('__DATABASE__',COPY_PREFIX+'000'));check(true,'HQ creation procedure installed only in owned copy');}
  pool=new Pool({...poolConfig,ssl:false,max:4,connectionTimeoutMillis:4000,query_timeout:8000,application_name:'SCCRM-Fanout-Native-Copy-Acceptance'});
  check((await pool.query("SELECT to_regnamespace('sccrm_fanout') n")).rows[0].n===null,'fresh isolated queue schema');
  await pool.query(fs.readFileSync(path.join(__dirname,'schema.sql'),'utf8'));q=new PgQueue(pool);await q.guard();
  for(const t of targets)await pool.query('INSERT INTO sccrm_fanout.targets(target_id,database_identity,branch_code,enabled) VALUES($1,$2,$3,true)',[t.targetId,t.databaseIdentity,t.branch]);
  source=new HqSource(sourceConfig);const initialReceivers=new Map(targets.map(t=>[t.targetId,newReceiver(t)]));const primaryReceiver=initialReceivers.get(primary.targetId);
  stage='happy-native-create';
  const happy=await makeSource('happy');await q.enqueueConfirmed(happy,targets.map(t=>t.targetId));
  let e=newEngine(Object.fromEntries(initialReceivers));let state=await poll(e,happy.memberId,rows=>rows.length===targets.length&&rows.every(r=>r.state==='succeeded'));await stopEngine(e);
  const primaryState=state.find(r=>r.target_id===primary.targetId);
  const happyNative=await nativeRows(primary.branch,happy.hqCode),happyLinks=await nativeLinks(primary.branch,happy.memberId);
  check(happyNative.length===1&&happyLinks.length===1&&String(happyLinks[0].member_id).toLowerCase()===happy.memberId&&happyLinks[0].ada_code===happy.hqCode,'native destination exact member and code');
  check(profileHash({name:happyNative[0].name,phone:happyNative[0].phone,email:happyNative[0].email})===profileHash(happy.profile),'native destination actual profile matches');
  check(Number(happyNative[0].FCCstRetPoint)===0&&Number(happyNative[0].FCCstWhsPoint)===0&&Number(happyNative[0].FCCstDailyPoint)===0,'new member starts with zero points only');
  const latencyMs=new Date(primaryState.completed_at).getTime()-new Date(happy.hqConfirmedAt).getTime();report.copyLatencyMs=latencyMs;check(latencyMs>=-1000&&latencyMs<10000,'copy HQ commit to destination ack under ten seconds',{latencyMs});
  report.copyLatencyByBranch={};
  for(const t of targets){
   const j=state.find(r=>r.target_id===t.targetId),actual=await nativeRows(t.branch,happy.hqCode),links=await nativeLinks(t.branch,happy.memberId);
   check(actual.length===1&&links.length===1&&String(links[0].member_id).toLowerCase()===happy.memberId&&links[0].ada_code===happy.hqCode&&links[0].target_identity===t.databaseIdentity,'all-branch native exact mapping '+t.branch);
   check(profileHash({name:actual[0].name,phone:actual[0].phone,email:actual[0].email})===profileHash(happy.profile),'all-branch native profile matches '+t.branch);
   check(hasCreationValidity(actual[0]),'all-branch creation-date membership is exactly100calendar years '+t.branch,{...validity(actual[0]),nativeCreatedAt:actual[0].native_created_at});
   const searchable=await nativeSearchRows(t.branch,happy.hqCode,happy.profile.name);check(searchable.length===1&&searchable[0].FTCstCode===happy.hqCode,'all-branch actual AdaPos active-expiry-name SQL eligibility '+t.branch);
   const repeated=await initialReceivers.get(t.targetId).receive(j);check(['already_delivered','existing_mapped'].includes(repeated.outcome)&&String(repeated.memberId).toLowerCase()===happy.memberId&&repeated.adaCode===happy.hqCode,'all-branch native replay identity '+t.branch);
   const replayedValidity=await nativeRows(t.branch,happy.hqCode);check(replayedValidity.length===1&&hasCreationValidity(replayedValidity[0])&&JSON.stringify(validity(replayedValidity[0]))===JSON.stringify(validity(actual[0])),'all-branch replay preserves original membership issue and expiry '+t.branch);
   report.membershipValidityByBranch[t.branch]={...validity(actual[0]),nativeCreatedAt:actual[0].native_created_at,calendarYears:100,nativeSearchSqlEligible:true,datesPreservedAfterReplay:true};
   const measured=new Date(j.completed_at).getTime()-new Date(happy.hqConfirmedAt).getTime();report.copyLatencyByBranch[t.branch]=measured;check(measured>=-1000&&measured<10000,'all-branch copy commit-to-ack budget '+t.branch,{latencyMs:measured});
  }
  check((await pool.query('SELECT count(*)::int n FROM sccrm_fanout.mappings WHERE member_id=$1',[happy.memberId])).rows[0].n===targets.length,'distinct durable mapping for every target database');
  const firstMap=(await pool.query('SELECT * FROM sccrm_fanout.mappings WHERE member_id=$1',[happy.memberId])).rows;
  for(let i=0;i<3;i++)await q.enqueueConfirmed(happy,[primary.targetId]);
  const replay=await primaryReceiver.receive(primaryState);check(['already_delivered','existing_mapped'].includes(replay.outcome),'native procedure replay returns stored identity');
  check((await nativeRows(primary.branch,happy.hqCode)).length===1&&(await jobs(happy.memberId)).every(j=>j.attempt_count===1),'repeated enqueue never duplicates native row');
  check(JSON.stringify((await pool.query('SELECT * FROM sccrm_fanout.mappings WHERE member_id=$1',[happy.memberId])).rows)===JSON.stringify(firstMap),'replay preserves initial mapping');
  stage='lost-ack-and-restart';
  const lost=await makeSource('lostack');await q.enqueueConfirmed(lost,[primary.targetId]);let lose=true;
  e=newEngine({[primary.targetId]:{async receive(j,opts){const r=await primaryReceiver.receive(j,opts);if(lose){lose=false;throw Object.assign(Error('ECONNRESET'),{code:'ECONNRESET'});}return r;}}});
  await poll(e,lost.memberId,rows=>rows[0]?.state==='retry');await stopEngine(e);const committedBeforeRestart=await nativeRows(primary.branch,lost.hqCode);check(committedBeforeRestart.length===1,'native commit exists despite lost ack');
  check(hasCreationValidity(committedBeforeRestart[0]),'lost-ack committed native row has100calendar-year validity');
  for(const r of receivers)r.close();receivers.clear();source.close();await pool.end();
  pool=new Pool({...poolConfig,ssl:false,max:4,connectionTimeoutMillis:4000,query_timeout:8000,application_name:'SCCRM-Fanout-Native-Copy-Restart'});q=new PgQueue(pool);await q.guard();source=new HqSource(sourceConfig);
  const resumed=newReceiver(primary);e=newEngine({[primary.targetId]:resumed});state=await poll(e,lost.memberId,rows=>rows[0]?.state==='succeeded');await stopEngine(e);
  const lostAfterRestart=await nativeRows(primary.branch,lost.hqCode);check(state[0].attempt_count===2&&lostAfterRestart.length===1&&(await nativeLinks(primary.branch,lost.memberId)).length===1,'fresh worker and SQL/PG connections recover lost ack once');
  check(hasCreationValidity(lostAfterRestart[0])&&JSON.stringify(validity(lostAfterRestart[0]))===JSON.stringify(validity(committedBeforeRestart[0])),'lost-ack replay preserves initial issue and expiry exactly');
  check((await nativeSearchRows(primary.branch,lost.hqCode,lost.profile.name)).length===1,'lost-ack recovered row remains native-search SQL eligible');
  stage='offline-isolation-and-reconnect';
  const offline=await makeSource('offline');await q.enqueueConfirmed(offline,[primary.targetId,secondary.targetId]);let online=false;const secondReceiver=newReceiver(secondary);
  e=newEngine({[primary.targetId]:resumed,[secondary.targetId]:{async receive(j,opts){if(!online)throw Object.assign(Error('TARGET_OFFLINE'),{code:'TARGET_OFFLINE'});return secondReceiver.receive(j,opts);}}});
  state=await poll(e,offline.memberId,rows=>rows.some(x=>x.target_id===primary.targetId&&x.state==='succeeded')&&rows.some(x=>x.target_id===secondary.targetId&&x.state==='retry'));
  check(state.find(x=>x.target_id===secondary.targetId).last_code==='TARGET_OFFLINE','offline branch retained separately while other succeeded');
  online=true;state=await poll(e,offline.memberId,rows=>rows.length===2&&rows.every(x=>x.state==='succeeded'));await stopEngine(e);
  for(const t of [primary,secondary]){const actual=await nativeLinks(t.branch,offline.memberId);check(actual.length===1&&actual[0].ada_code===offline.hqCode&&String(actual[0].member_id).toLowerCase()===offline.memberId,'online recovery preserves identity '+t.branch);}
  stage='phone-and-code-conflicts';
  for(const kind of ['phone','code']){
   const item=await makeSource(kind);const conflictCode=kind==='code'?item.hqCode:'FX-'+nonce+'-P';
   const conflictingProfile={name:'Existing COPY collision '+nonce,phone:kind==='phone'?item.profile.phone:'098'+String(crypto.randomInt(10000000)).padStart(7,'0'),email:'existing-copy@example.invalid'};
   await seedCollision(primary.branch,{code:conflictCode,profile:conflictingProfile});const before=await nativeRows(primary.branch,conflictCode);
   if(kind==='phone'){check(before.length===1&&before[0].membership_expires_at==null&&(await nativeSearchRows(primary.branch,conflictCode,conflictingProfile.name)).length===0,'observed AdaPos predicate hides ownCOPYNULL-expiry fixture');}
   const conflictTag=tag+'-'+kind;await lab.snapshot(primary.branch,{copy:true,baselineTag:conflictTag});
   await q.enqueueConfirmed(item,[primary.targetId]);e=newEngine({[primary.targetId]:resumed});state=await poll(e,item.memberId,rows=>rows[0]?.state==='review');await stopEngine(e);
   check(kind==='code'?/CODE_COLLISION/.test(state[0].last_code):/EXISTING_CUSTOMER_REVIEW/.test(state[0].last_code),'native '+kind+' collision held with reason',{code:state[0].last_code});
   check(JSON.stringify(await nativeRows(primary.branch,conflictCode))===JSON.stringify(before),'native '+kind+' collision row never overwritten');
   const conflictProof=await lab.verify(primary.branch,{copy:true,baselineTag:conflictTag});check(conflictProof.proof?.unchanged&&conflictProof.proof.columnsChecked===101,'all native '+kind+' collision baseline columns preserved',{columnsChecked:101,baselineRows:conflictProof.proof.baselineRows});
   check((await pool.query('SELECT count(*)::int n FROM sccrm_fanout.mappings WHERE member_id=$1',[item.memberId])).rows[0].n===0,'native '+kind+' collision never auto-mapped');
   await q.enqueueConfirmed(item,[primary.targetId]);e=newEngine({[primary.targetId]:resumed});await e.tick();await stopEngine(e);check((await jobs(item.memberId))[0].attempt_count===1,'native '+kind+' review does not retry automatically');
  }
  stage='profile-mismatch-after-native-commit';
  const mismatch=await makeSource('profile');await q.enqueueConfirmed(mismatch,[primary.targetId]);let leased=await q.lease(primary.targetId,crypto.randomUUID(),15000);check(leased.member_id===mismatch.memberId,'profile replay test owns expected lease');
  await resumed.receive(leased);await q.failed(leased,Object.assign(Error('ECONNRESET'),{code:'ECONNRESET'}));
  await copyQuery(primary.branch,'UPDATE dbo.TCNMCst SET FTCstName=@name WHERE FTCstCode=@code',{name:'Changed COPY fixture '+nonce,code:mismatch.hqCode});
  const altered=await nativeRows(primary.branch,mismatch.hqCode);e=newEngine({[primary.targetId]:resumed});state=await poll(e,mismatch.memberId,rows=>rows[0]?.state==='review');await stopEngine(e);
  check(/PROFILE_CHANGED_REVIEW/.test(state[0].last_code),'changed native name is held on replay',{code:state[0].last_code});
  check(JSON.stringify(await nativeRows(primary.branch,mismatch.hqCode))===JSON.stringify(altered),'changed copy fixture is not repaired by overwrite');
  check((await pool.query('SELECT count(*)::int n FROM sccrm_fanout.mappings WHERE member_id=$1',[mismatch.memberId])).rows[0].n===0,'profile mismatch has no false successful mapping');
  stage='lease-expiry-restart';
  const crashed=await makeSource('lease');await q.enqueueConfirmed(crashed,[primary.targetId]);leased=await q.lease(primary.targetId,crypto.randomUUID(),2000);await resumed.receive(leased);
  await new Promise(resolve=>setTimeout(resolve,2100));const newReceiverAfterCrash=newReceiver(primary);e=newEngine({[primary.targetId]:newReceiverAfterCrash});state=await poll(e,crashed.memberId,rows=>rows[0]?.state==='succeeded');await stopEngine(e);
  check(state[0].attempt_count===2&&(await nativeRows(primary.branch,crashed.hqCode)).length===1,'expired service lease replays committed native row once');
  check(await q.succeeded(leased,await resumed.receive(leased))===false,'stale old process cannot acknowledge a new lease');
  report.queueStatus=await q.status();report.workerRestartTested=true;report.sourceCursorContract='UTC created_at and canonical UUID lexical ordering';
 }catch(error){failure=error;report.failure={stage,code:safeError(error),...(error.jobStates?{jobStates:error.jobStates}:{})};}
 finally{
  for(const engine of engines)await engine.stop({waitMs:1000}).catch(()=>{});for(const r of receivers)r.close();source?.close();if(pool)await pool.end().catch(()=>{});
  for(const branch of snapshots){try{const verification=await lab.verify(branch,{copy:true,baselineTag:tag});report.preservation[branch]=verification.proof;check(verification.ok&&verification.proof?.unchanged&&verification.proof.columnsChecked===101,'all original copied profiles preserved '+branch);}catch(error){failure||=error;report.preservation[branch]={ok:false,code:safeError(error)};}}
 }
 report.finishedAt=new Date().toISOString();report.ok=!failure;report.passed=report.checks.filter(c=>c.ok).length;
 if(failure){const error=Object.assign(Error('NATIVE_COPY_INTEGRATION_FAILED'),{code:'NATIVE_COPY_INTEGRATION_FAILED',report});throw error;}return report;
}
module.exports={runNativeIntegration};
if(require.main===module){
 if(process.argv.length!==3||process.argv[2]!=='--copy-config-stdin'){console.error(JSON.stringify({ok:false,code:'EXPLICIT_NATIVE_COPY_CONFIG_REQUIRED'}));process.exitCode=1;}
 else{let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',part=>{input+=part;if(Buffer.byteLength(input)>131072){process.stdin.destroy();console.error(JSON.stringify({ok:false,code:'NATIVE_COPY_CONFIG_TOO_LARGE'}));process.exitCode=1;}});process.stdin.on('end',async()=>{try{const config=JSON.parse(input);input='';requireCopy(config.scope==='SCCRM-FANOUT-NATIVE-COPY-TEST','NATIVE_COPY_CONFIG_SCOPE_REQUIRED');const report=await runNativeIntegration(config);console.log(JSON.stringify(report));}catch(error){console.error(JSON.stringify(error.report||{ok:false,code:safeError(error)}));process.exitCode=1;}});}
}
