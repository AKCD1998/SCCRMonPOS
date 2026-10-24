'use strict';
const fs=require('node:fs'),path=require('node:path');const {Client}=require('pg');const {read}=require('./config.cjs');const {SqlCopy}=require('./bridge.cjs');const {Engine}=require('./engine.cjs');
const root=path.join(__dirname,'runtime');fs.mkdirSync(root,{recursive:true});let stop=false;
for(const s of ['SIGINT','SIGTERM'])process.on(s,()=>{stop=true;});
function status(s){const v={scope:'SANDBOX ONLY',at:new Date().toISOString(),...s};fs.writeFileSync(path.join(root,'status.tmp'),JSON.stringify(v,null,2));fs.renameSync(path.join(root,'status.tmp'),path.join(root,'status.json'));const publicDir=path.join(__dirname,'status');if(fs.existsSync(publicDir)){fs.writeFileSync(path.join(publicDir,'status.tmp'),JSON.stringify(v,null,2));fs.renameSync(path.join(publicDir,'status.tmp'),path.join(publicDir,'status.json'));}}
const sleep=async ms=>{for(let i=0;i<ms&&!stop;i+=250){if(fs.existsSync(path.join(root,'stop.request'))){stop=true;break;}await new Promise(r=>setTimeout(r,Math.min(250,ms-i)));}};
async function run(){const file=process.env.SCCRM_SYNC_CONFIG||path.join(root,'config.json'),c=read(file);let failures=0;
 while(!stop){let pg,ada;try{
  pg=new Client({...c.pg,connectionTimeoutMillis:5000,query_timeout:8000,application_name:'SCCRM-HQ-Sandbox-Worker'});pg.on('error',()=>{});await pg.connect();
  if(!(await pg.query("SELECT pg_try_advisory_lock(hashtextextended('SCCRM-HQ-SANDBOX',0)) held")).rows[0].held)throw Error('ANOTHER_WORKER_ACTIVE');
  ada=new SqlCopy(file);const engine=new Engine(pg,ada);await engine.guard();
  while(!stop){if(fs.existsSync(path.join(root,'pause.request'))){status({state:'paused'});await sleep(1000);continue;}
   const result=await engine.cycle();failures=0;status({state:'healthy',pid:process.pid,...result});if(process.argv.includes('--once')){stop=true;break;}await sleep(c.intervalMs);
  }
 }catch(e){failures++;status({state:'retrying',code:/^[A-Z_]{3,80}$/.test(e.code||e.message)?(e.code||e.message):'CONNECTION_OR_OPERATION_FAILED',failures});}
 finally{if(ada)ada.close();if(pg)await pg.end().catch(()=>{});}
 if(!stop)await sleep(Math.min(60000,1000*2**Math.min(failures,6)));
 }
 status({state:'stopped'});
}
if(require.main===module)run().catch(()=>{status({state:'startup_refused'});process.exitCode=1;});module.exports={run};
