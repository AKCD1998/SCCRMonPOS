'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),readline=require('node:readline'),{spawn,spawnSync}=require('node:child_process'),{Client}=require('pg');
const {record,hash}=require('../history/model.cjs');
const {resolveExisting,digestMember}=require('./existing-members.cjs');
const {configuration,runLane}=require('./scheduler.cjs');
const {failureCode,workerState}=require('./health.cjs');
const {recentHistory}=require('./recent-history.cjs');
const {BranchHistory}=require('./branch-history.cjs');
const ROOT=__dirname,MARKER='ef76cc14-1b6b-49c9-8da7-1bfaea3dd92b',SCOPE='LIVE-HQ000-ADAACC';
function validate(c,secrets){if(c.scope!=='SCCRM-HQ-LIVE-MEMBERS'||c.marker!==MARKER||c.sql.database!=='AdaAcc'||c.sql.user!=='sccrm_hq_member_sync'||!['tcp:127.0.0.1,49800','tcp:100.90.166.72,49800'].includes(c.sql.server))throw Error('LIVE_SOURCE_CONFIG_REFUSED');const u=new URL(secrets.pgUrl);if(u.hostname!==c.pgHost||u.port!=='5432'||u.pathname!=='/postgres'||!decodeURIComponent(u.username).startsWith('sccrm_hq_live_sync.')||!u.hostname.endsWith('.pooler.supabase.com'))throw Error('LIVE_DESTINATION_CONFIG_REFUSED');return c;}
class Source{
 constructor(file,password,{branch}={}){
  this.pending=new Map();this.sequence=0;this.closed=false;
  const env={...process.env,PSModulePath:'C:\\Windows\\SysWOW64\\WindowsPowerShell\\v1.0\\Modules'};
  if(branch&&!['001','003','004','005'].includes(branch))throw Error('BRANCH_SOURCE_CONFIG_REFUSED');
  this.child=spawn('C:/Windows/SysWOW64/WindowsPowerShell/v1.0/powershell.exe',['-NoProfile','-File',path.join(ROOT,branch?'BranchSqlRpc.ps1':'LiveSqlRpc.ps1'),...(branch?['-Branch',branch]:['-ConfigFile',file])],{env,windowsHide:true,stdio:['pipe','pipe','pipe']});
  this.child.stderr.on('data',()=>{});
  readline.createInterface({input:this.child.stdout}).on('line',line=>{
   let r;try{r=JSON.parse(line.replace(/^\uFEFF/,''));}catch{return;}
   if(r.ok===false&&r.id===undefined){this.fail('SOURCE_PROCESS_ENDED');return;}
   const job=this.pending.get(r.id);if(!job)return;this.pending.delete(r.id);clearTimeout(job.timer);
   r.ok?job.resolve(r.rows):job.reject(Error(r.code));
  });
  this.child.on('error',()=>this.fail('SOURCE_PROCESS_ENDED'));this.child.on('exit',()=>this.fail('SOURCE_PROCESS_ENDED'));
  this.child.stdin.on('error',()=>this.fail('SOURCE_PROCESS_ENDED'));
  this.child.stdin.write(JSON.stringify(branch?{action:'init'}:{action:'init',sqlPassword:password})+'\n');
 }
 fail(code){if(this.closed)return;this.closed=true;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(Error(code));}this.pending.clear();this.child.kill();}
 query(action,params={}){
  if(this.closed)return Promise.reject(Error('SOURCE_PROCESS_ENDED'));
  return new Promise((resolve,reject)=>{const id=++this.sequence,timer=setTimeout(()=>this.fail('SOURCE_TIMEOUT'),20000);
   this.pending.set(id,{resolve,reject,timer});this.child.stdin.write(JSON.stringify({id,action,...params})+'\n');});
 }
 close(){if(this.closed)return;this.closed=true;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(Error('LIVE_SERVICE_STOPPING'));}this.pending.clear();this.child.stdin.end(JSON.stringify({action:'close'})+'\n');}
}
function psSecrets(action){const r=spawnSync('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoProfile','-File',path.join(ROOT,'SecretBridge.ps1'),'-Action',action],{windowsHide:true,encoding:'utf8',timeout:30000,env:{...process.env,PSModulePath:'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules'}});if(r.status!==0)throw Error('SECRET_BRIDGE_REFUSED');return r.stdout.trim();}
async function guard(pg){const r=await pg.query('SELECT marker,scope FROM ada_history.meta');if(r.rows.length!==1||r.rows[0].marker!==MARKER||r.rows[0].scope!==SCOPE)throw Error('LIVE_MIRROR_MARKER_REQUIRED');if((await pg.query('SELECT current_user actor')).rows[0].actor!=='sccrm_hq_live_sync')throw Error('LIVE_PG_ROLE_REFUSED');}
function serialize(r){return {source_key:r.key,owner_code:r.owner,parent_key:r.parent,payload_hash:r.payloadHash,payload:r.payload};}
async function apply(pg,kind,records,snapshot,cursor){if(!records.length)return 0;return Number((await pg.query('SELECT ada_history.apply_batch($1,$2,$3,$4::jsonb,$5,$6) n',[MARKER,SCOPE,kind,JSON.stringify(records.map(serialize)),snapshot,String(cursor)])).rows[0].n);}
async function historyTotals(pg){
 // Resolve physical-source precedence once, before joining item rows. Repeated
 // expansion of the canonical view can exceed the restricted role's timeout.
 return (await pg.query(`WITH canonical AS MATERIALIZED (
  SELECT source_id,receipt_key,doc_type FROM ada_history.history_receipts
 ) SELECT (SELECT count(*)::int FROM ada_history.customer_profiles) customers,
  count(*) FILTER (WHERE doc_type='1')::int sales,
  count(*) FILTER (WHERE doc_type='9')::int returns,
  (SELECT count(*)::int FROM ada_history.lines l JOIN canonical r
   ON r.source_id=l.source_id AND r.receipt_key=l.receipt_key) lines
 FROM canonical`)).rows[0];
}
async function synchronize(pg,source,status){await guard(pg);const snapshot=crypto.randomUUID();let written=0,customerCount=0,receiptCount=0,lineCount=0;
 const cache={customers:new Map((await pg.query("SELECT ada_code,payload_hash FROM ada_history.customers WHERE source_id='hq000/AdaAcc'")).rows.map(r=>[r.ada_code,r.payload_hash])),receipts:new Map((await pg.query("SELECT receipt_key,payload_hash FROM ada_history.receipts WHERE source_id='hq000/AdaAcc'")).rows.map(r=>[r.receipt_key,r.payload_hash])),lines:new Map((await pg.query("SELECT line_key,payload_hash FROM ada_history.lines WHERE source_id='hq000/AdaAcc'")).rows.map(r=>[r.line_key,r.payload_hash]))};
 async function send(kind,records,cursor){const changed=records.filter(r=>cache[kind].get(r.key)!==r.payloadHash);for(let i=0;i<changed.length;i+=100)written+=await apply(pg,kind,changed.slice(i,i+100),snapshot,cursor);for(const r of records)cache[kind].set(r.key,r.payloadHash);}
 let after=null;for(;;){const rows=await source.query('customers',{after});if(!rows.length)break;const records=rows.map(p=>record('customers',p));await send('customers',records,records.at(-1).key);customerCount+=rows.length;after=rows.at(-1).FTCstCode;status({state:'importing',phase:'customers',customerCount,receiptCount,lineCount});}
 let afterCustomer=null,afterDoc='';for(;;){
  const rows=await source.query('receipts',{afterCustomer,afterDoc});if(!rows.length)break;
  const headers=new Map(rows.map(h=>[h.FTShdDocNo,h]));
  const lines=await source.query('lines',{docs:rows.map(h=>h.FTShdDocNo)});
  if(rows.some(h=>!lines.some(l=>l.FTShdDocNo===h.FTShdDocNo)))throw Error('HISTORY_SOURCE_ITEMS_PENDING');
  const headerRecords=rows.map(p=>record('receipts',p)),lineRecords=lines.map(p=>record('lines',p,headers));
  await pg.query('BEGIN');try{
   await send('receipts',headerRecords,rows.at(-1).FTShdDocNo);
   await send('lines',lineRecords,rows.at(-1).FTShdDocNo);
   await pg.query('COMMIT');
  }catch(error){await pg.query('ROLLBACK');throw error;}
  receiptCount+=rows.length;lineCount+=lines.length;afterCustomer=rows.at(-1).FTCstCode;afterDoc=rows.at(-1).FTShdDocNo;status({state:'importing',phase:'history',customerCount,receiptCount,lineCount});
 }
 return {customerCount,receiptCount,lineCount,written};}
function profile(row){const phone=String(row.phone_number||'').replace(/\D/g,'').replace(/^66(?=\d{9}$)/,'0'),name=String(row.full_name||'').trim(),email=String(row.email||'').trim().toLowerCase();if(!name||name.length>200||!/^0\d{9}$/.test(phone)||email.length>100)throw Error('PROFILE_NOT_REPRESENTABLE');return {name,phone,email};}
async function outbound(pg,source,{onOutcome=()=>{},registrationConfirmationEnabled=false}={}){
 const contact=registrationConfirmationEnabled?'COALESCE(u.phone_number,m.contact_phone)':'u.phone_number';
 const approval=registrationConfirmationEnabled?`,(SELECT r.request_id::text FROM sccrm_registration.confirmations r WHERE r.member_id=u.id AND r.action='new' AND r.allow_shared_contact=true ORDER BY r.confirmed_at DESC LIMIT 1) distinct_request_id,
   (SELECT r.profile_hash FROM sccrm_registration.confirmations r WHERE r.member_id=u.id AND r.action='new' AND r.allow_shared_contact=true ORDER BY r.confirmed_at DESC LIMIT 1) confirmed_profile_hash`:'';
 const pending=(await pg.query(`SELECT u.id,u.full_name,${contact} AS phone_number,u.email${approval} FROM public.users u JOIN public.member_profiles m ON m.user_id=u.id LEFT JOIN ada_history.outbound_state o ON o.member_id=u.id WHERE m.is_active=true AND NOT EXISTS(SELECT 1 FROM ada_history.member_links l WHERE l.member_id=u.id) ORDER BY(o.member_id IS NOT NULL),o.updated_at NULLS FIRST,u.id LIMIT 100`)).rows;
 const approved=(await pg.query('SELECT * FROM ada_history.pending_approved_member_links(20)')).rows;
 const members=[...new Map([...pending,...approved].map(m=>[m.id,m])).values()];
 let created=0,linked=0,review=0;
 for(const m of members){
  const digest=digestMember(m),old=(await pg.query('SELECT * FROM ada_history.outbound_state WHERE member_id=$1',[m.id])).rows[0];
  if(old?.profile_hash===digest&&old.state==='created'&&!approved.some(a=>a.id===m.id))continue;
  const observedAt=new Date().toISOString();
  try{
   const distinctRequest=registrationConfirmationEnabled&&m.confirmed_profile_hash===digest&&/^[a-f0-9-]{36}$/.test(m.distinct_request_id||'')?m.distinct_request_id:null;
   if(registrationConfirmationEnabled&&m.distinct_request_id&&!distinctRequest)throw Error('REGISTRATION_CONFIRMATION_PROFILE_CHANGED');
   const p=profile(m),existing=distinctRequest?null:await resolveExisting(pg,source,m,apply);
   if(existing){
    await pg.query("INSERT INTO ada_history.outbound_state(member_id,profile_hash,state,ada_code,last_code) VALUES($1,$2,'created',$3,'EXISTING_MEMBER_LINKED') ON CONFLICT(member_id) DO UPDATE SET profile_hash=EXCLUDED.profile_hash,state='created',ada_code=EXCLUDED.ada_code,last_code=EXCLUDED.last_code,updated_at=now()",[m.id,digest,existing.adaCode]);
    linked++;onOutcome({memberId:m.id,adaCode:existing.adaCode,kind:'existing',observedAt,confirmedAt:new Date().toISOString()});continue;
   }
   // Unchanged conflicts stay held. A new explicit web approval is separately
   // selected above and can complete publication without another registration.
   if(old?.profile_hash===digest&&old.state==='review'&&!distinctRequest){review++;continue;}
   const answer=(await source.query('createMember',{memberId:m.id,...p,...(distinctRequest?{distinctRequest}:{})}))[0];
   if(!answer||String(answer.member_id).toLowerCase()!==m.id)throw Error('MEMBER_ACK_IDENTITY_REFUSED');
   const raw=(await source.query('customer',{code:answer.ada_code}))[0];
   if(!raw)throw Error('NEW_NATIVE_CUSTOMER_NOT_FOUND');
   await apply(pg,'customers',[record('customers',raw)],crypto.randomUUID(),answer.ada_code);
   await pg.query('BEGIN');try{
    await pg.query('INSERT INTO ada_history.member_links VALUES($1,$2,$3,$4) ON CONFLICT(source_id,ada_code) DO NOTHING',[m.id,'hq000/AdaAcc',answer.ada_code,'native create acknowledgement']);
    const actual=(await pg.query('SELECT member_id FROM ada_history.member_links WHERE source_id=$1 AND ada_code=$2',['hq000/AdaAcc',answer.ada_code])).rows[0];
    if(actual.member_id!==m.id)throw Error('MEMBER_LINK_CHANGE_REFUSED');
    await pg.query("INSERT INTO ada_history.outbound_state(member_id,profile_hash,state,ada_code) VALUES($1,$2,'created',$3) ON CONFLICT(member_id) DO UPDATE SET profile_hash=EXCLUDED.profile_hash,state='created',ada_code=EXCLUDED.ada_code,last_code=NULL,updated_at=now()",[m.id,digest,answer.ada_code]);
    await pg.query('COMMIT');
   }catch(error){await pg.query('ROLLBACK');throw error;}
   created++;onOutcome({memberId:m.id,adaCode:answer.ada_code,kind:'created',observedAt,confirmedAt:new Date().toISOString(),hqCommittedAt:answer.assigned_at||null});
  }catch(error){
   const code=/^[A-Z_]{5,80}$/.test(error.message)?error.message:'MEMBER_SYNC_REVIEW';
   if(/SOURCE_TIMEOUT|SOURCE_PROCESS_ENDED|MEMBER_CREATE_BUSY|MEMBER_CODES_BUSY|MEMBER_LINK_SOURCE_CHANGED|MEMBER_LINK_MEMBER_CHANGED/.test(code)||['42501','55P03','40P01','40001','57014','53300','57P01','08000','08006','ECONNRESET'].includes(error.code))throw error;
   await pg.query("INSERT INTO ada_history.outbound_state(member_id,profile_hash,state,last_code) VALUES($1,$2,'review',$3) ON CONFLICT(member_id) DO UPDATE SET profile_hash=EXCLUDED.profile_hash,state='review',last_code=EXCLUDED.last_code,updated_at=now() WHERE outbound_state.profile_hash<>EXCLUDED.profile_hash OR outbound_state.last_code IS DISTINCT FROM EXCLUDED.last_code",[m.id,digest,code]);review++;
  }
 }
 return {created,linked,review};
}
async function run(){
 if(process.env.COMPUTERNAME!=='SERVER')throw Error('HQ_SERVICE_ONLY');
 const configFile=path.join(ROOT,'config.json'),c=JSON.parse(fs.readFileSync(configFile,'utf8')),poll=configuration(c);
 psSecrets('Init');
 const state={members:{state:'waiting-credentials'},history:{state:'waiting-credentials'},receipts:{state:'waiting-credentials'},branches:{},outbound:{},totals:{},outcomes:[]};
 if(poll.branchHistoryEnabled)for(const branch of poll.branchHistoryBranches)state.branches[branch]={state:'waiting-credentials'};
 const publish=()=>{const phase=workerState(state.members,state.history,state.receipts,...Object.values(state.branches));
  fs.writeFileSync(path.join(ROOT,'status/status.json'),JSON.stringify({at:new Date().toISOString(),scope:SCOPE,pid:process.pid,state:phase,...state.totals,outbound:state.outbound,members:state.members,history:state.history,receipts:state.receipts,branches:state.branches,lastCycle:state.lastCycle,memberPollMs:poll.memberPollMs,historyPollMs:poll.historyPollMs,receiptPollMs:poll.receiptPollMs,branchHistoryPollMs:poll.branchHistoryPollMs,lastMemberOutcomes:state.outcomes}));};
 publish();while(!fs.existsSync(path.join(ROOT,'runtime/credentials.rsa')))await new Promise(r=>setTimeout(r,1000));
 const secrets=JSON.parse(Buffer.from(psSecrets('Read'),'base64').toString('utf8'));validate(c,secrets);
 const connection={connectionString:secrets.pgUrl,ssl:{rejectUnauthorized:true,ca:fs.readFileSync(path.join(ROOT,'supabase-ca.crt'),'utf8')},connectionTimeoutMillis:8000,query_timeout:20000};
 const historyPg=new Client({...connection,application_name:'SCCRM-HQ-History'}),memberPg=new Client({...connection,application_name:'SCCRM-HQ-FastMembers'}),receiptPg=new Client({...connection,application_name:'SCCRM-HQ-FastReceipts'});
 const historySource=new Source(configFile,secrets.sqlPassword),memberSource=new Source(configFile,secrets.sqlPassword),receiptSource=new Source(configFile,secrets.sqlPassword);
 let branchPg=null,branchHistory=null;
 let stopping=false,tasks=[];const stopped=()=>stopping||fs.existsSync(path.join(ROOT,'runtime/stop.request'));
 process.on('SIGTERM',()=>{stopping=true;});
 const failed=lane=>error=>{state[lane]={state:'retrying',at:new Date().toISOString(),code:failureCode(error)};publish();if(/SOURCE_PROCESS_ENDED|SOURCE_TIMEOUT|Connection terminated|connection closed/i.test(error.message))throw error;};
 try{
  await historyPg.connect();await guard(historyPg);
  if(!(await historyPg.query('SELECT pg_try_advisory_lock(731024,1439) locked')).rows[0].locked)throw Error('LIVE_WORKER_ALREADY_RUNNING');
  await memberPg.connect();await guard(memberPg);
  await receiptPg.connect();await guard(receiptPg);
  if(poll.branchHistoryEnabled){
   branchPg=new Client({...connection,application_name:'SCCRM-Branch-Inbound'});await branchPg.connect();await guard(branchPg);
   branchHistory=new BranchHistory(branchPg,{sourceFactory:branch=>new Source(null,null,{branch}),hqProfileReader:codes=>historySource.query('customersForCodes',{codes}),guard,marker:MARKER,scope:SCOPE,fullPollMs:poll.branchHistoryFullPollMs,onStatus:(branch,status)=>{state.branches[branch]=status;publish();}});
  }
  tasks=[runLane({intervalMs:poll.memberPollMs,stopping:stopped,onError:failed('members'),cycle:async()=>{
   if(fs.existsSync(path.join(ROOT,'runtime/pause.request'))){state.members={state:'paused'};publish();return;}
   const start=Date.now();state.outbound=await outbound(memberPg,memberSource,{registrationConfirmationEnabled:c.registrationConfirmationEnabled===true,onOutcome:outcome=>{
    state.outcomes.push(outcome);if(state.outcomes.length>20)state.outcomes.shift();
    fs.appendFileSync(path.join(ROOT,'status/member-outcomes.jsonl'),JSON.stringify(outcome)+'\n');
   }});state.members={state:'healthy',at:new Date().toISOString(),durationMs:Date.now()-start};publish();
   await memberPg.query("INSERT INTO ada_history.worker_status VALUES('hq000',$1,$2,now()) ON CONFLICT(worker) DO UPDATE SET state=EXCLUDED.state,details=EXCLUDED.details,updated_at=now()",[workerState(state.members,state.history,state.receipts,...Object.values(state.branches)),JSON.stringify({outbound:state.outbound,members:state.members,history:state.history,receipts:state.receipts,branches:state.branches,memberPollMs:poll.memberPollMs,receiptPollMs:poll.receiptPollMs,branchHistoryPollMs:poll.branchHistoryPollMs})]);
  }}),runLane({intervalMs:poll.receiptPollMs,stopping:stopped,onError:failed('receipts'),cycle:async()=>{
   if(fs.existsSync(path.join(ROOT,'runtime/pause.request'))){state.receipts={state:'paused'};publish();return;}
   const start=Date.now(),result=await recentHistory({pg:receiptPg,source:receiptSource,guard,apply});
   state.receipts={...result,state:result.pendingCount||result.missingCustomerCount?'retrying':'healthy',...(result.pendingCount||result.missingCustomerCount?{code:'RECENT_SOURCE_INCOMPLETE'}:{}),at:new Date().toISOString(),durationMs:Date.now()-start};publish();
  }}),runLane({intervalMs:poll.historyPollMs,stopping:stopped,onError:failed('history'),cycle:async()=>{
   if(fs.existsSync(path.join(ROOT,'runtime/pause.request'))){state.history={state:'paused'};publish();return;}
   state.lastCycle=await synchronize(historyPg,historySource,progress=>{state.history={...progress,at:new Date().toISOString()};publish();});
   state.totals=await historyTotals(historyPg);
   state.history={state:'healthy',at:new Date().toISOString()};publish();
  }})];
  if(branchHistory)for(const branch of poll.branchHistoryBranches)tasks.push(runLane({intervalMs:poll.branchHistoryPollMs,stopping:stopped,onError:error=>{throw error;},cycle:async()=>{
   if(fs.existsSync(path.join(ROOT,'runtime/pause.request'))){state.branches[branch]={state:'paused'};publish();return;}
   await branchHistory.cycle(branch);
  }}));
  await Promise.all(tasks);
 }finally{stopping=true;historySource.close();memberSource.close();receiptSource.close();if(branchHistory)branchHistory.close();await Promise.allSettled(tasks);await Promise.allSettled([historyPg.end(),memberPg.end(),receiptPg.end(),...(branchPg?[branchPg.end()]:[])]);}
}
if(require.main===module)run().catch(e=>{const code=/^[A-Z_]{5,80}$/.test(e.message)?e.message:'LIVE_WORKER_REFUSED';fs.writeFileSync(path.join(ROOT,'status/status.json'),JSON.stringify({state:'stopped',at:new Date().toISOString(),code}));process.exitCode=1;});
module.exports={validate,Source,guard,serialize,apply,historyTotals,synchronize,profile,outbound,run,MARKER,SCOPE};
