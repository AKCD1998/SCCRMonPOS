'use strict';
// Own reader objects and the existing receipt service only; no business-table DML.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict'),{spawnSync}=require('node:child_process');
const c=require('./time-copy.cjs'),old=require('./upgrade-time.cjs'),copy=require('./completeness-copy.cjs');
const branches=['000','001','003','004','005'],remote='\\\\100.90.166.72\\D\\SCCRM-HQ-LiveSync-20261024\\receipts';
const digest=v=>crypto.createHash('sha256').update(v).digest('hex'),normalize=v=>v?.replace(/^(CREATE|ALTER) PROCEDURE/,'CREATE PROCEDURE').replace(/\r\n/g,'\n').trim();
const read=f=>JSON.parse(fs.readFileSync(path.join(copy.ROOT,f),'utf8'));
const files=['run-service.cjs','worker.cjs','completeness.cjs','Read-ReceiptSnapshot.ps1'];
function noLink(p){if(fs.existsSync(p)&&fs.lstatSync(p).isSymbolicLink())throw Error('COMPLETENESS_REPARSE_REFUSED');}
function committed(){const repo=path.resolve(__dirname,'../..');const r=spawnSync('git',['-C',repo,'status','--porcelain','--untracked-files=all'],{encoding:'utf8'});assert.equal(r.status,0);assert.equal(r.stdout.trim(),'','Committed source required');const head=spawnSync('git',['-C',repo,'rev-parse','HEAD'],{encoding:'utf8'}).stdout.trim();assert.match(head,/^[a-f0-9]{40}$/);return head;}
function proofs(){const p=read('reader-copies.json'),e=read('real-two-end-to-end.json');assert(p.ok&&p.productionWrites===0&&p.proof.length===5&&p.readerHash===digest(JSON.stringify(copy.source())));assert(e.ok&&e.productionWrites===0&&e.results.length===2&&e.pointRowsUnchanged===55&&e.nativeCopyTargets===4);return p;}
function readers(){return branches.map(branch=>({branch,result:c.sql(c.target(branch),"SELECT definition FROM sys.sql_modules WHERE object_id=OBJECT_ID('dbo.SCCRM_ReadReceiptSnapshot')").results[0]}));}
function sample(){const docs="'S2610005001-0004069','S2610005002-0011739'",data={};for(const b of ['000','005'])data[b]=c.sql(c.target(b),`SELECT FTBchCode,FTPosCode,FTShdDocNo,FTCstCode,FCShdGrand,FCShdDis FROM dbo.TPSTSalHD WHERE FTShdDocNo IN(${docs}) ORDER BY FTShdDocNo;
 SELECT FTShdDocNo,FNSdtSeqNo,FTPdtCode,FTPunCode,FTSdtUnitName,FCSdtQty,FCSdtSetPrice,FCSdtNet,FCSdtDis FROM dbo.TPSTSalDT WHERE FTShdDocNo IN(${docs}) ORDER BY FTShdDocNo,FNSdtSeqNo;
 SELECT FTBchCode,FTCstCode,FTPntRefDoc,FTPntCardType,FNPntPoint,FNPntPointOld,FCPntAmtRcv FROM dbo.TCNTCstPoint WHERE FTPntRefDoc IN(${docs}) ORDER BY FTPntRefDoc,FTCstCode,FTPntCardType;`).results;return data;}
async function waitStopped(){for(let n=0;n<20;n++){if(/STATE\s*:\s*1\s+STOPPED/.test(old.sc('query')))return;await new Promise(r=>setTimeout(r,500));}throw Error('COMPLETENESS_SERVICE_STOP_TIMEOUT');}
async function run(action){old.owner();noLink(remote);noLink(path.join(remote,'runtime'));
 if(action==='preflight'){
  const proof=proofs(),data={at:new Date().toISOString(),readerHash:proof.readerHash,readers:readers(),native:branches.map(old.inspect),customers:branches.map(old.snapshot),sample:sample()};
  fs.writeFileSync(path.join(copy.ROOT,'live-before.json'),JSON.stringify(data,null,2));return {ok:true,branches,customerWrites:0,pointWrites:0};
 }
 if(action==='install-readers'){
  const commit=committed(),p=proofs(),before=read('live-before.json');assert.equal(before.readerHash,p.readerHash);const result=[];
  for(const b of branches){const beforeReader=before.readers.find(r=>r.branch===b).result[0]?.definition,current=c.sql(c.target(b),"SELECT definition FROM sys.sql_modules WHERE object_id=OBJECT_ID('dbo.SCCRM_ReadReceiptSnapshot')").results[0][0]?.definition;
   assert.equal(current,beforeReader,'Reader changed since preflight');const expected=copy.source().replaceAll('__DATABASE__','AdaAcc').replaceAll('__TARGET__',b);
   if(current)assert.equal(normalize(current),normalize(expected),'Unowned reader collision');else c.sql(c.target(b),[expected,`GRANT EXECUTE ON dbo.SCCRM_ReadReceiptSnapshot TO [sccrm_receipt_sync_${b}];`],{},{transaction:true});
   const actual=c.sql(c.target(b),"SELECT definition FROM sys.sql_modules WHERE object_id=OBJECT_ID('dbo.SCCRM_ReadReceiptSnapshot')").results[0][0].definition;assert.equal(normalize(actual),normalize(expected));
   const rights=c.sql(c.target(b),`EXECUTE AS USER='sccrm_receipt_sync_${b}' WITH NO REVERT;SELECT HAS_PERMS_BY_NAME('dbo.SCCRM_ReadReceiptSnapshot','OBJECT','EXECUTE') reader,HAS_PERMS_BY_NAME('dbo.TCNMCst','OBJECT','UPDATE') customers,HAS_PERMS_BY_NAME('dbo.TPSTSalHD','OBJECT','UPDATE') sales,HAS_PERMS_BY_NAME('dbo.TCNTCstPoint','OBJECT','UPDATE') points;`).results[0][0];assert.deepEqual(rights,{reader:1,customers:0,sales:0,points:0});
   assert.deepEqual(old.inspect(b),before.native.find(n=>n.branch===b));result.push({branch:b,rights});
  }
  const after=branches.map(old.snapshot);assert.deepEqual(after,before.customers);assert.deepEqual(sample(),before.sample);
  const r={ok:true,commit,readerHash:p.readerHash,result,customersAndFinancialRowsUnchanged:true};fs.writeFileSync(path.join(copy.ROOT,'live-reader-install.json'),JSON.stringify(r,null,2));return r;
 }
 if(action==='stage-worker'||action==='refresh-worker'){
  const commit=committed(),proof=read('live-reader-install.json');assert(proof.ok&&proof.result.length===5);proofs();
  const backup=path.join(remote,'runtime',action==='stage-worker'?'completeness-backup-20261112':'completeness-refresh-'+commit.slice(0,12));noLink(backup);assert(!fs.existsSync(backup),'Backup already exists; inspect before repeating');fs.mkdirSync(backup);
  const originals=[...files.filter(f=>fs.existsSync(path.join(remote,f))),'config.json','.receipt-service-owner.json','package-manifest.json'];
  for(const f of originals){noLink(path.join(remote,f));fs.copyFileSync(path.join(remote,f),path.join(backup,f));}
  old.sc('stop');await waitStopped();
  try{
   const hashes=[];for(const f of files){noLink(path.join(remote,f));fs.copyFileSync(path.join(__dirname,f),path.join(remote,f));hashes.push({path:f,sha256:digest(fs.readFileSync(path.join(remote,f)))});}
   const config=JSON.parse(fs.readFileSync(path.join(remote,'config.json'),'utf8'));config.completenessEnabled=true;fs.writeFileSync(path.join(remote,'config.json'),JSON.stringify(config,null,2));
   const owner=old.owner();owner.sourceCommit=commit;fs.writeFileSync(path.join(remote,'.receipt-service-owner.json'),JSON.stringify(owner));
   const manifest=JSON.parse(fs.readFileSync(path.join(remote,'package-manifest.json'),'utf8'));manifest.sourceCommit=commit;
   for(const f of [...files,'config.json','.receipt-service-owner.json']){const item={path:f,sha256:digest(fs.readFileSync(path.join(remote,f)))};const n=manifest.files.findIndex(i=>i.path===f);if(n<0)manifest.files.push(item);else manifest.files[n]=item;}
   fs.writeFileSync(path.join(remote,'package-manifest.json'),JSON.stringify(manifest,null,2));old.sc('start');
   const result={ok:true,commit,backup,files:hashes,service:'SCCRMHQReceiptSync',otherServicesChanged:0,at:new Date().toISOString()};fs.writeFileSync(path.join(copy.ROOT,'live-worker-upgrade.json'),JSON.stringify(result,null,2));return result;
  }catch(e){for(const f of originals)fs.copyFileSync(path.join(backup,f),path.join(remote,f));try{old.sc('start');}catch{}throw e;}
 }
 if(action==='rollback-worker'){
  const backup=path.join(remote,'runtime','completeness-backup-20261112');noLink(backup);assert(fs.existsSync(backup));old.sc('stop');await waitStopped();
  for(const f of [...files,'config.json','.receipt-service-owner.json','package-manifest.json'])if(fs.existsSync(path.join(backup,f)))fs.copyFileSync(path.join(backup,f),path.join(remote,f));old.sc('start');return {ok:true,restoredOwnWorker:true,dataDeleted:0};
 }
 if(action==='status'){return {service:old.sc('query'),delivery:JSON.parse(fs.readFileSync(path.join(remote,'status/service.json'),'utf8')),completeness:fs.existsSync(path.join(remote,'status/completeness.json'))?JSON.parse(fs.readFileSync(path.join(remote,'status/completeness.json'),'utf8')):null};}
 throw Error('Explicit action required');
}
if(require.main===module)run(process.argv[2]).then(r=>console.log(JSON.stringify(r))).catch(e=>{console.log(JSON.stringify({ok:false,code:e.code||e.message,sqlNumber:e.result?.sqlNumber}));process.exitCode=1;});
module.exports={run};
