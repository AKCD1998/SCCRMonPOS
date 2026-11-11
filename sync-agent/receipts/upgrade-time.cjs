'use strict';
// Operator-only deployment. Never changes credentials or a native financial row.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawnSync}=require('node:child_process');
const copy=require('./time-copy.cjs');
const branches=['000','001','003','004','005'],service='SCCRMHQReceiptSync';
const remote='\\\\100.90.166.72\\D\\SCCRM-HQ-LiveSync-20261024\\receipts';
const digest=v=>crypto.createHash('sha256').update(v).digest('hex');
const definition=v=>v.replace(/^(?:CREATE|ALTER) PROCEDURE/,'CREATE PROCEDURE').replace(/\r\n/g,'\n').trim();
function sc(action){if(!['query','stop','start'].includes(action))throw Error('RECEIPT_TIME_SERVICE_ACTION_REFUSED');const r=spawnSync('C:/Windows/System32/sc.exe',['\\\\100.90.166.72',action,service],{windowsHide:true,encoding:'utf8',timeout:15000});if(r.status!==0)throw Error('RECEIPT_TIME_SERVICE_CONTROL_FAILED');return r.stdout;}
function owner(){const o=JSON.parse(fs.readFileSync(path.join(remote,'.receipt-service-owner.json'),'utf8'));if(o.marker!=='a7dc1e0f-91d3-431c-bd97-fb142c5ae082'||o.service!==service||o.root!=='D:\\SCCRM-HQ-LiveSync-20261024\\receipts')throw Error('RECEIPT_TIME_SERVICE_OWNER_REFUSED');return o;}
function noLink(file){if(fs.existsSync(file)&&fs.lstatSync(file).isSymbolicLink())throw Error('RECEIPT_TIME_REPARSE_REFUSED');}
function proof(){
 const native=branches.map(b=>JSON.parse(fs.readFileSync(path.join(copy.RUNTIME,'test-'+b+'.json'),'utf8').replace(/^\uFEFF/,'')));
 const real=JSON.parse(fs.readFileSync(path.join(copy.RUNTIME,'real-copy-proof.json'),'utf8'));
 if(native.some((p,i)=>!p.ok||p.branch!==branches[i]||p.productionWrites!==0||!p.customerAndSalesUnchanged)||!real.ok||real.productionWrites!==0||real.results.length!==6||!real.customerSaleAndPointRowsUnchanged)throw Error('RECEIPT_TIME_COPY_PROOF_REQUIRED');
 const receiver=fs.readFileSync(path.join(__dirname,'native-receiver.sql'),'utf8');return {native,real,receiverHash:digest(receiver),receiver};
}
function committed(){const repo=path.resolve(__dirname,'../..'),r=spawnSync('git',['-C',repo,'status','--porcelain','--untracked-files=all'],{encoding:'utf8'});if(r.status!==0||r.stdout.trim())throw Error('RECEIPT_TIME_COMMITTED_SOURCE_REQUIRED');const s=spawnSync('git',['-C',repo,'rev-parse','HEAD'],{encoding:'utf8'});if(s.status!==0||!/[a-f0-9]{40}/.test(s.stdout.trim()))throw Error('RECEIPT_TIME_COMMITTED_SOURCE_REQUIRED');return s.stdout.trim();}
function receiverStatements(b,database,receiver){return ['SET XACT_ABORT ON;',"IF OBJECT_ID('dbo.SCCRM_ReceiptTimeAudit') IS NULL BEGIN "+fs.readFileSync(path.join(__dirname,'native-time-audit.sql'),'utf8')+' END;',receiver.replace('CREATE PROCEDURE','ALTER PROCEDURE').replaceAll('__DATABASE__',database).replaceAll('__TARGET__',b),
 `DENY SELECT,INSERT,UPDATE,DELETE,ALTER ON dbo.SCCRM_ReceiptTimeAudit TO [sccrm_receipt_sync_${b}];UPDATE dbo.SCCRM_ReceiptSyncMeta SET receiver_hash=@hash WHERE singleton=1;`];}
function inspect(b){
 const r=copy.sql(copy.target(b),`SELECT CONVERT(varchar(36),marker) marker,target_branch,worker_login,receiver_hash FROM dbo.SCCRM_ReceiptSyncMeta;
 SELECT definition FROM sys.sql_modules WHERE object_id=OBJECT_ID('dbo.SCCRM_AttachReceiptMember');
 SELECT tr.name FROM sys.triggers tr JOIN sys.tables t ON t.object_id=tr.parent_id WHERE tr.is_disabled=0 AND t.name IN('TPSTSalHD','TSHD001','TSHD002');`).results;
 if(r[0].length!==1||r[0][0].marker.toLowerCase()!=='ab01553b-576c-465e-af30-87daa20e2d33'||r[0][0].target_branch!==b||r[0][0].worker_login!=='sccrm_receipt_sync_'+b||r[1].length!==1||r[2].length)throw Error('RECEIPT_TIME_NATIVE_OWNER_REFUSED');
 return {branch:b,meta:r[0][0],definition:r[1][0].definition};
}
function snapshot(b){
 const target=copy.target(b),cols=copy.sql(target,"SELECT name FROM sys.columns WHERE object_id=OBJECT_ID('dbo.TCNMCst') AND name NOT LIKE '%pin%' AND name NOT LIKE '%password%' AND name NOT LIKE '%secret%' AND name NOT LIKE '%token%' ORDER BY column_id").results[0].map(r=>{if(!/^[A-Za-z0-9_]+$/.test(r.name))throw Error('RECEIPT_TIME_COLUMN_REFUSED');return '['+r.name+']';});
 const data=copy.sql(target,'SELECT '+cols.join(',')+' FROM dbo.TCNMCst ORDER BY FTCstCode;').results[0];
 return {branch:b,customers:data.length,columns:cols.length,sha256:digest(JSON.stringify(data)),pinRead:false};
}
function receipts(){
 const result={};for(const b of ['000','004'])result[b]=copy.sql(copy.target(b),`SELECT 'TPSTSalHD' table_name,FTBchCode,FTPosCode,FTShdDocNo,FTCstCode,FDShdDocDate,FTShdDocTime,FCShdGrand,FTShdStaPaid,FTShdStaDoc FROM dbo.TPSTSalHD WHERE FTBchCode='004' AND FTShdDocNo IN('S2611004002-0025098','S2611004002-0025100','S2611004002-0025111') ORDER BY FTShdDocNo;
 ${b==='004'?"SELECT 'TSHD002' table_name,FTBchCode,FTPosCode,FTShdDocNo,FTCstCode,FDShdDocDate,FTShdDocTime,FCShdGrand,FTShdStaPaid,FTShdStaDoc FROM dbo.TSHD002 WHERE FTBchCode='004' AND FTShdDocNo IN('S2611004002-0025098','S2611004002-0025100','S2611004002-0025111') ORDER BY FTShdDocNo;":''}
 SELECT FTBchCode,FTCstCode,FTPntRefDoc,FTPntCardType,FNPntPoint,FNPntPointOld,FCPntAmtRcv FROM dbo.TCNTCstPoint WHERE FTBchCode='004' AND FTPntRefDoc IN('S2611004002-0025098','S2611004002-0025100','S2611004002-0025111') ORDER BY FTPntRefDoc,FTCstCode,FTPntCardType;`).results;return result;
}
async function run(action){
 owner();
 noLink(remote);noLink(path.join(remote,'runtime'));
 if(action==='verify-copy-upgrade'){
  const b='005',t=copy.target('000',copy.databaseFor(b)),p=proof(),assert=require('node:assert/strict');
  copy.sql(t,"IF COL_LENGTH('dbo.SCCRM_ReceiptSyncMeta','receiver_hash') IS NULL ALTER TABLE dbo.SCCRM_ReceiptSyncMeta ADD receiver_hash char(64) NULL;IF USER_ID('sccrm_receipt_sync_005') IS NULL CREATE USER sccrm_receipt_sync_005 WITHOUT LOGIN;",{},{copy:true});
  copy.sql(t,receiverStatements(b,t.database,p.receiver),{hash:p.receiverHash},{copy:true,transaction:true});
  const read=()=>copy.sql(t,"SELECT receiver_hash FROM dbo.SCCRM_ReceiptSyncMeta;SELECT definition FROM sys.sql_modules WHERE object_id=OBJECT_ID('dbo.SCCRM_AttachReceiptMember');",{},{copy:true}).results;
  const before=read();assert.equal(before[0][0].receiver_hash,p.receiverHash);assert.equal(definition(before[1][0].definition),definition(receiverStatements(b,t.database,p.receiver)[2]));
  assert.throws(()=>copy.sql(t,[...receiverStatements(b,t.database,p.receiver),"CREATE TABLE dbo.SCCRM_UpgradeRollbackFixture(id int);RAISERROR('RECEIPT_EXPECTED_COPY_ROLLBACK',16,1);"],{hash:'b'.repeat(64)},{copy:true,transaction:true}));
  assert.deepEqual(read(),before);assert.equal(copy.sql(t,"SELECT OBJECT_ID('dbo.SCCRM_UpgradeRollbackFixture') id",{},{copy:true}).results[0][0].id,null);
  const result={ok:true,action,receiverHash:p.receiverHash,clientTransactionDDL:true,failedDDLRolledBack:true,productionWrites:0};fs.writeFileSync(path.join(copy.RUNTIME,'upgrade-copy-proof.json'),JSON.stringify(result,null,2));return result;
 }
 if(action==='preflight'){
  const p=proof(),native=branches.map(inspect),customers=branches.map(snapshot),sales=receipts();
  fs.writeFileSync(path.join(copy.RUNTIME,'live-before.json'),JSON.stringify({at:new Date().toISOString(),native,customers,sales,receiverHash:p.receiverHash},null,2));
  return {ok:true,action,branches,customers,receiverHash:p.receiverHash,productionWrites:0,pinRead:false};
 }
 if(action==='upgrade-receivers'){
  const commit=committed(),p=proof();if(!/STATE\s*:\s*1\s+STOPPED/.test(sc('query')))throw Error('RECEIPT_TIME_SERVICE_MUST_BE_STOPPED');
  const backup=JSON.parse(fs.readFileSync(path.join(copy.RUNTIME,'live-before.json'),'utf8'));
  if(backup.receiverHash!==p.receiverHash)throw Error('RECEIPT_TIME_STALE_COPY_PROOF');
  const results=[];
  for(const b of branches){
   const current=inspect(b),prior=backup.native.find(n=>n.branch===b);if(current.definition!==prior.definition)throw Error('RECEIPT_TIME_NATIVE_CHANGED_SINCE_PREFLIGHT');
   const statements=receiverStatements(b,'AdaAcc',p.receiver);
   copy.sql(copy.target(b),statements,{hash:p.receiverHash},{transaction:true});
   const after=inspect(b);if(definition(after.definition)!==definition(receiverStatements(b,'AdaAcc',p.receiver)[2])||after.meta.receiver_hash!==p.receiverHash)throw Error('RECEIPT_TIME_NATIVE_READBACK_FAILED');
   results.push({branch:b,receiverHash:p.receiverHash,profileWrites:0,receiptWrites:0,pointWrites:0});
  }
  const result={ok:true,action,commit,results,at:new Date().toISOString()};fs.writeFileSync(path.join(copy.RUNTIME,'native-upgrade.json'),JSON.stringify(result,null,2));return result;
 }
 if(action==='stage-worker'){
  const commit=committed(),o=owner(),p=proof(),native=JSON.parse(fs.readFileSync(path.join(copy.RUNTIME,'native-upgrade.json'),'utf8'));
  if(!/STATE\s*:\s*1\s+STOPPED/.test(sc('query'))||!native.ok||native.commit!==commit||native.results.some(r=>r.receiverHash!==p.receiverHash))throw Error('RECEIPT_TIME_UPGRADE_ORDER_REFUSED');
  const backup=path.join(remote,'runtime','canonical-time-backup-20261111');noLink(backup);fs.mkdirSync(backup,{recursive:true});
  const files=['worker.cjs','native-adapter.cjs','Invoke-ReceiptNative.ps1','README.md'];
  const hashes=[];for(const file of files){const dest=path.join(remote,file);noLink(dest);noLink(path.join(backup,file));if(!fs.existsSync(path.join(backup,file)))fs.copyFileSync(dest,path.join(backup,file));fs.copyFileSync(path.join(__dirname,file),dest);hashes.push({file,sha256:digest(fs.readFileSync(dest))});}
  for(const file of ['.receipt-service-owner.json','package-manifest.json']){noLink(path.join(remote,file));noLink(path.join(backup,file));if(!fs.existsSync(path.join(backup,file)))fs.copyFileSync(path.join(remote,file),path.join(backup,file));}
  o.sourceCommit=commit;fs.writeFileSync(path.join(remote,'.receipt-service-owner.json'),JSON.stringify(o));
  const manifest=JSON.parse(fs.readFileSync(path.join(remote,'package-manifest.json'),'utf8'));manifest.sourceCommit=commit;manifest.receiverHash=p.receiverHash;
  for(const item of manifest.files){const changed=hashes.find(h=>h.file===item.path);if(changed)item.sha256=changed.sha256;else if(item.path==='.receipt-service-owner.json')item.sha256=digest(fs.readFileSync(path.join(remote,item.path)));}
  fs.writeFileSync(path.join(remote,'package-manifest.json'),JSON.stringify(manifest,null,2));
  const result={ok:true,action,commit,receiverHash:p.receiverHash,files:hashes,secretAndConfigFilesChanged:0,at:new Date().toISOString()};
  fs.writeFileSync(path.join(remote,'canonical-time-manifest.json'),JSON.stringify(result,null,2));
  fs.writeFileSync(path.join(copy.RUNTIME,'worker-upgrade.json'),JSON.stringify(result,null,2));return result;
 }
 if(action==='verify-data'){
  const before=JSON.parse(fs.readFileSync(path.join(copy.RUNTIME,'live-before.json'),'utf8')),after=branches.map(snapshot),sales=receipts();
  const unchanged=after.every(a=>{const b=before.customers.find(b=>b.branch===a.branch);return b.sha256===a.sha256&&b.customers===a.customers;});
  const pointUnchanged=['000','004'].every(b=>JSON.stringify(sales[b].at(-1))===JSON.stringify(before.sales[b].at(-1)));
  const result={ok:unchanged&&pointUnchanged,at:new Date().toISOString(),customers:after,allExistingCustomerColumnsUnchanged:unchanged,threeReceiptPointRowsUnchanged:pointUnchanged,beforeSales:before.sales,afterSales:sales};fs.writeFileSync(path.join(copy.RUNTIME,'live-data-proof.json'),JSON.stringify(result,null,2));return result;
 }
 throw Error('RECEIPT_TIME_EXPLICIT_ACTION_REQUIRED');
}
module.exports={run,sc,owner,inspect,snapshot,receipts};
if(require.main===module)run(process.argv[2]).then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(JSON.stringify({ok:false,code:/^RECEIPT_[A-Z_]+$/.test(e.message)?e.message:'RECEIPT_TIME_OPERATOR_FAILED',sqlNumber:e.result?.sqlNumber,detailsWithheld:true}));process.exitCode=1;});
