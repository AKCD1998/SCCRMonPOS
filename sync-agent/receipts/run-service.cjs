'use strict';
const fs=require('node:fs'),path=require('node:path');
const {createWorker,httpApi,SCOPE}=require('./worker.cjs');
const {receive,verifyRights}=require('./native-adapter.cjs');
const {machineSecrets}=require('./secrets.cjs');
const {createReconciler}=require('./completeness.cjs');
const ROOT=__dirname;
function publish(status){const file=path.join(ROOT,'status','service.json');fs.writeFileSync(file+'.tmp',JSON.stringify({...status,at:new Date().toISOString()}));fs.renameSync(file+'.tmp',file);}
async function main(){
 if(process.env.COMPUTERNAME!=='SERVER'||path.resolve(ROOT).toLowerCase()!=='d:\\sccrm-hq-livesync-20261024\\receipts')throw Error('RECEIPT_SERVICE_LOCATION_REFUSED');
 machineSecrets('Init');
 if(!fs.existsSync(path.join(ROOT,'runtime','credentials.hybrid.json'))){publish({state:'awaiting_credentials',scope:SCOPE});return;}
 const config=JSON.parse(fs.readFileSync(path.join(ROOT,'config.json'),'utf8'));
 if(config.scope!==SCOPE||config.enabled!==true){publish({state:'paused',scope:SCOPE});return;}
 const secrets=machineSecrets();if(secrets.scope!==SCOPE)throw Error('RECEIPT_SERVICE_CREDENTIAL_SCOPE_REFUSED');
 const targets=config.targets;
 for(const t of targets){const c=secrets.credentials?.[t.branch];if(c?.user!=='sccrm_receipt_sync_'+t.branch||!c.password)throw Error('RECEIPT_WORKER_CREDENTIAL_REQUIRED');}
 const api=httpApi({token:secrets.apiToken});
 const worker=createWorker({api,targets,
  probe:target=>verifyRights(target,secrets.credentials[target.branch]),
  receive:(target,job)=>receive(target,secrets.credentials[target.branch],job),onStatus:publish,
  stopping:()=>fs.existsSync(path.join(ROOT,'runtime','stop.request'))||fs.existsSync(path.join(ROOT,'runtime','pause.request'))});
 const reconciler=config.completenessEnabled===true?createReconciler({api,targets,credentials:secrets.credentials,
  onStatus:status=>{const file=path.join(ROOT,'status','completeness.json');fs.writeFileSync(file+'.tmp',JSON.stringify(status));fs.renameSync(file+'.tmp',file);},
  stopping:()=>fs.existsSync(path.join(ROOT,'runtime','stop.request'))||fs.existsSync(path.join(ROOT,'runtime','pause.request'))}):null;
 const stop=()=>{worker.requestStop();reconciler?.requestStop();};
 process.on('SIGTERM',stop);process.on('SIGINT',stop);
 await Promise.all([worker.start(),reconciler?.start()]);publish({scope:SCOPE,state:'stopped'});
}
module.exports={main};
if(require.main===module)main().catch(()=>{try{publish({scope:SCOPE,state:'blocked',code:'RECEIPT_SERVICE_START_FAILED'});}catch{}process.exitCode=1;});
