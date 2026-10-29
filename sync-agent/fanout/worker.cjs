'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {Pool}=require('pg');
const {PgQueue,FanoutEngine,SCOPE,MARKER,safeCode}=require('./engine.cjs');
const {checkRuntimeRights,ROLE}=require('./pg-runtime.cjs');
const {HqSource,NativeReceiver}=require('./sql-adapter.cjs');
const {machineSecrets}=require('./secrets.cjs');
const ROOT=__dirname;
const FIXTURE_ID='bf0e4513-a72d-4c83-9b17-afff6779cf9b';
function validate(config,secrets){
 if(config.scope!==SCOPE||config.marker!==MARKER||config.mode!=='live'||config.source.machine!=='SERVER'||config.source.database!=='AdaAcc'||config.source.user!=='sccrm_member_fanout_source'||config.source.server!=='tcp:127.0.0.1,49800')throw Error('FANOUT_LIVE_SOURCE_REFUSED');
 const url=new URL(secrets.pgUrl);if(url.hostname!==config.pgHost||!url.hostname.endsWith('.pooler.supabase.com')||url.port!=='5432'||url.pathname!=='/postgres'||!decodeURIComponent(url.username).startsWith(ROLE+'.'))throw Error('FANOUT_LIVE_QUEUE_REFUSED');
 if(!Array.isArray(config.targets)||config.targets.length>4||new Set(config.targets.map(t=>t.targetId)).size!==config.targets.length)throw Error('FANOUT_TARGET_LIST_REFUSED');
 const destinations={'001':{peer:'100.81.137.41',machine:'SC_001'},'003':{peer:'100.77.101.94',machine:'POSSRV'},'004':{peer:'100.113.59.42',machine:'SERVER004'},'005':{peer:'100.106.107.80',machine:'POSSRV'}};
 for(const t of config.targets){const d=destinations[t.branchCode];if(!d||t.targetId!=='branch'+t.branchCode||t.machine!==d.machine||t.database!=='AdaAcc'||t.user!=='sccrm_member_fanout_'+t.branchCode||typeof secrets.targetPasswords[t.targetId]!=='string'||typeof t.databaseIdentity!=='string'||t.databaseIdentity.length>160)throw Error('FANOUT_TARGET_REFUSED');
  if(t.server!==d.peer+'\\SQLEXPRESS'&&!new RegExp('^tcp:'+d.peer.replaceAll('.','\\.')+',[0-9]{4,5}$').test(t.server))throw Error('FANOUT_TARGET_ENDPOINT_REFUSED');
  if(!t.databaseIdentity.startsWith('branch'+t.branchCode+'/'+d.machine+'.SQLEXPRESS/AdaAcc/'))throw Error('FANOUT_TARGET_BINDING_REFUSED');
 }
 if(config.heldSourceIds?.[FIXTURE_ID]!=='SYNTHETIC_SOURCE_FIXTURE_HELD')throw Error('KNOWN_SYNTHETIC_SOURCE_MUST_BE_HELD');return config;
}
async function scanOnce(source,queue,held={}){
 const checkpoint=await queue.getSourceCheckpoint();const records=await source.read(checkpoint);let enqueued=0,heldCount=0;
 for(const record of records){if(held[record.memberId]){await queue.holdConfirmed(record,held[record.memberId]);heldCount++;}else{await queue.enqueueConfirmed(record);enqueued++;}
  await queue.advanceSourceCheckpoint({createdAt:record.hqConfirmedAt,memberId:record.memberId});
 }
 return {observed:records.length,enqueued,held:heldCount};
}
async function catchUpEnabledTargets(queue){
 // Do not cache "caught up" by target ID. A source can be committed while a
 // target is disabled, even if disable/re-enable both happen between polls.
 // Reconcile only missing jobs, at most 100 owned HQ-created envelopes/target.
 // The durable unique key prevents replay; legacy Ada directory rows are never
 // scanned here. Current volume is the small native-create journal, not 1,438 old
 // Ada customers. An enable epoch can optimize this if that journal grows.
 const enabled=await queue.targets();let enqueued=0;
 for(const target of enabled)enqueued+=(await queue.enqueueExistingForTarget(target.target_id,{limit:100})).length;
 return {targets:enabled.length,enqueued,limitPerTarget:100};
}
function writeStatus(state){const dir=path.join(ROOT,'status');const temp=path.join(dir,'status.next.json');fs.writeFileSync(temp,JSON.stringify({at:new Date().toISOString(),scope:SCOPE,pid:process.pid,...state}));fs.renameSync(temp,path.join(dir,'status.json'));}
async function run(){
 if(process.env.COMPUTERNAME!=='SERVER')throw Error('FANOUT_HQ_SERVICE_ONLY');
 const config=JSON.parse(fs.readFileSync(path.join(ROOT,'config.json'),'utf8'));machineSecrets('Init');writeStatus({state:'waiting-credentials'});
 let stopping=false;process.on('SIGTERM',()=>{stopping=true;});
 const stopFile=path.join(ROOT,'runtime/stop.request'),pauseFile=path.join(ROOT,'runtime/pause.request');
 while(!fs.existsSync(path.join(ROOT,'runtime/credentials.hybrid.json'))){if(stopping||fs.existsSync(stopFile))return;await new Promise(resolve=>setTimeout(resolve,500));}
 const secret=machineSecrets();validate(config,secret);
 const pool=new Pool({connectionString:secret.pgUrl,ssl:{rejectUnauthorized:true,ca:fs.readFileSync(path.join(ROOT,'supabase-ca.crt'),'utf8')},max:6,connectionTimeoutMillis:5000,query_timeout:8000,application_name:'SCCRM-HQ-MemberFanout'});
 pool.on('error',()=>{});const queue=new PgQueue(pool);const source=new HqSource({mode:'live',connection:{...config.source,password:secret.sourcePassword}});
 const adapters=Object.fromEntries(config.targets.map(t=>[t.targetId,new NativeReceiver({mode:'live',connection:{...t,targetIdentity:t.databaseIdentity,password:secret.targetPasswords[t.targetId]}})]));
 let lastError=null,lastSourceError=null,lastScan={},lastCatchup={},engine,lastStatus=0;
 try{
  await queue.guard();await checkRuntimeRights(pool);
  engine=new FanoutEngine({queue,adapters,pollMs:1000,leaseMs:15000,timeoutMs:7500,onError:r=>{lastError=r;}}).start();
  while(!stopping&&!fs.existsSync(stopFile)){
   const paused=fs.existsSync(pauseFile);
   if(paused){if(!engine.stopped)await engine.stop();}
   else{
    if(engine.stopped)engine.start();
    try{lastScan=await scanOnce(source,queue,config.heldSourceIds||{});lastSourceError=null;}catch(e){lastSourceError=safeCode(e);}
    lastCatchup=await catchUpEnabledTargets(queue);
   }
   if(Date.now()-lastStatus>=5000){writeStatus({state:paused?'paused':lastSourceError?'source-retrying':'healthy',lastScan,lastCatchup,lastSourceError,lastError,targets:await queue.status(),sourceCheckpoint:await queue.getSourceCheckpoint(),heldSources:(await pool.query("SELECT member_id,hq_code,last_code FROM sccrm_fanout.sources WHERE state='review' ORDER BY member_id LIMIT 100")).rows,reviewJobs:(await pool.query("SELECT target_id,member_id,hq_code,last_code,attempt_count FROM sccrm_fanout.jobs WHERE state='review' ORDER BY id LIMIT 100")).rows});lastStatus=Date.now();}
   for(let i=0;i<10&&!stopping&&!fs.existsSync(stopFile);i++)await new Promise(resolve=>setTimeout(resolve,100));
  }
 }finally{if(engine)await engine.stop();source.close();for(const adapter of Object.values(adapters))adapter.close();await pool.end();writeStatus({state:'stopped'});}
}
if(require.main===module)run().catch(e=>{try{writeStatus({state:'blocked',code:safeCode(e)});}catch{}process.exitCode=1;});
module.exports={validate,scanOnce,catchUpEnabledTargets,run,FIXTURE_ID};
