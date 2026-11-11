'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const defaultCopy=require('../fanout/copy-lab.cjs');
const xml=s=>String(s??'').replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll("'",'&apos;');
const itemsXml=items=>'<items>'+items.map(i=>'<i '+Object.entries({seq:i.FNSdtSeqNo,sku:i.FTPdtCode,barcode:i.FTSdtBarCode,unit:i.FTPunCode,unitName:i.FTSdtUnitName,
 qty:i.FCSdtQty,price:i.FCSdtSetPrice,net:i.FCSdtNet,discount:i.FCSdtDis||0}).map(([k,v])=>k+'="'+xml(v)+'"').join(' ')+'/>').join('')+'</items>';
const hash=x=>crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
async function run(branch='005',copy=defaultCopy){
 if(!['000','001','003','004','005'].includes(branch))throw Error('RECEIPT_COPY_BRANCH_REQUIRED');
 const query=async(sql,p={},options={})=>{try{return await copy.query(branch,sql,p,options);}catch(e){e.stage=sql.trim().slice(0,45);throw e;}};
 const tables=(await query("SELECT name FROM sys.tables WHERE name IN('TCNMCst','TCNTCstPoint','TPSTSalHD','TPSTSalDT','TSHD001','TSDT001','TSHD002','TSDT002') ORDER BY name")).results[0].map(r=>r.name);
 assert(tables.includes('TPSTSalHD')&&tables.includes('TPSTSalDT'));
 const columns={};
 for(const table of tables)columns[table]=(await query("SELECT name FROM sys.columns WHERE object_id=OBJECT_ID(@table) AND name NOT LIKE '%pin%' AND name NOT LIKE '%password%' AND name NOT LIKE '%secret%' AND name NOT LIKE '%token%' ORDER BY column_id",{table:'dbo.'+table})).results[0].map(r=>r.name);
 const snapshot=async()=>{
  const result={};for(const table of tables){assert(columns[table].every(c=>/^[a-z0-9_]+$/i.test(c)));result[table]=(await query('SELECT '+columns[table].map(c=>'['+c+']').join(',')+' FROM dbo.['+table+']')).results[0];}
  return result;
 };
 const before=await snapshot();
 const meta=(await query("SELECT OBJECT_ID('dbo.SCCRM_ReceiptSyncMeta') id")).results[0][0].id;
 if(!meta)await query(`CREATE TABLE dbo.SCCRM_ReceiptSyncMeta(singleton int PRIMARY KEY,marker uniqueidentifier NOT NULL,target_branch char(3) NOT NULL);
  INSERT dbo.SCCRM_ReceiptSyncMeta VALUES(1,'ab01553b-576c-465e-af30-87daa20e2d33','${branch}');
  CREATE TABLE dbo.SCCRM_ReceiptSyncJournal(operation_id uniqueidentifier PRIMARY KEY,payload_hash char(64) NOT NULL,ada_code varchar(20) NOT NULL,
   branch_code char(3) NOT NULL,pos_code char(3) NOT NULL,doc_no varchar(20) NOT NULL,created_at datetime NOT NULL,UNIQUE(branch_code,doc_no));`);
 if(!(await query("SELECT OBJECT_ID('dbo.SCCRM_ReceiptTimeAudit') id")).results[0][0].id)await query(fs.readFileSync(path.join(__dirname,'native-time-audit.sql'),'utf8'));
 let proc=fs.readFileSync(path.join(__dirname,'native-receiver.sql'),'utf8').replaceAll('__DATABASE__',copy.databaseFor(branch)).replaceAll('__TARGET__',branch);
 if((await query("SELECT OBJECT_ID('dbo.SCCRM_AttachReceiptMember') id")).results[0][0].id)proc=proc.replace('CREATE PROCEDURE','ALTER PROCEDURE');
 await query(proc);
 await query(`IF NOT EXISTS(SELECT 1 FROM sys.database_principals WHERE name='SCCRM_ReceiptCopyWorker') CREATE USER SCCRM_ReceiptCopyWorker WITHOUT LOGIN;
  GRANT EXECUTE ON dbo.SCCRM_AttachReceiptMember TO SCCRM_ReceiptCopyWorker;
  DENY SELECT,INSERT,UPDATE,DELETE ON dbo.TCNMCst TO SCCRM_ReceiptCopyWorker;
  ${tables.filter(t=>t!=='TCNMCst').map(t=>'DENY INSERT,UPDATE,DELETE ON dbo.['+t+'] TO SCCRM_ReceiptCopyWorker;').join('\n')}
  DENY SELECT,INSERT,UPDATE,DELETE ON dbo.SCCRM_ReceiptTimeAudit TO SCCRM_ReceiptCopyWorker;`);
 const headTable=branch==='000'?'TPSTSalHD':null;
 const header=(headTable?before[headTable]:['001','002'].flatMap(p=>before['TSHD'+p]||[])).find(r=>r.FTShdStaDoc==='1'&&r.FTShdStaPaid==='3'&&r.FCShdGrand>0&&(branch==='000'||!r.FTCstCode)&&before[headTable?'TPSTSalDT':'TSDT'+r.FTPosCode]?.some(d=>d.FTShdDocNo===r.FTShdDocNo&&d.FTBchCode===r.FTBchCode));
 assert(header,'A paid blank-member receipt copied from this branch is required');
 const headerTable=headTable||'TSHD'+header.FTPosCode;
 const items=before[headTable?'TPSTSalDT':'TSDT'+header.FTPosCode].filter(r=>r.FTShdDocNo===header.FTShdDocNo&&r.FTBchCode===header.FTBchCode);
 const profile=before.TCNMCst.find(r=>r.FTCstCode&&r.FTCstName&&r.FTCstTel);
 assert(profile&&items.length);
 const params={operation:crypto.randomUUID(),hash:'a'.repeat(64),code:profile.FTCstCode,branch:header.FTBchCode,pos:header.FTPosCode,doc:header.FTShdDocNo,
  date:header.FDShdDocDate.slice(0,10).replaceAll('-',''),time:header.FTShdDocTime,grand:header.FCShdGrand,name:profile.FTCstName,phone:profile.FTCstTel,items:itemsXml(items)};
 const exec='EXEC dbo.SCCRM_AttachReceiptMember @OperationId=@operation,@PayloadHash=@hash,@AdaCode=@code,@Branch=@branch,@Pos=@pos,@Doc=@doc,@SoldDate=@date,@SoldTime=@time,@Grand=@grand,@ExpectedName=@name,@ExpectedPhone=@phone,@Items=@items;';
 let tests=0;
 // Each fixture is inside an outer rollback; the procedure's internal commit
 // cannot commit the caller's outer transaction. No persistent test customers.
 const blankFixture=branch==='000'?`UPDATE dbo.${headerTable} SET FTCstCode='' WHERE FTShdDocNo=@doc AND FTBchCode=@branch;`:'';
 const applied=await query('BEGIN TRY BEGIN TRANSACTION;'+blankFixture+exec+exec+"SELECT COUNT(*) journals FROM dbo.SCCRM_ReceiptSyncJournal WHERE operation_id=@operation;ROLLBACK TRANSACTION;END TRY BEGIN CATCH IF XACT_STATE()<>0 ROLLBACK TRANSACTION;SELECT ERROR_MESSAGE() failure;END CATCH",params);
 if(applied.results[0]?.[0]?.failure){const e=Error(applied.results[0][0].failure);e.copySqlMessage=applied.results[0][0].failure;throw e;}
 assert.equal(applied.results[0][0].outcome,'applied');assert.equal(applied.results[1][0].outcome,'replayed');assert.equal(applied.results[2][0].journals,1);tests+=3;
 // The reader switches directly to this database-only user WITH NO REVERT.
 // No nested impersonation and no ability to return to the admin principal.
 const rights=await query("SELECT HAS_PERMS_BY_NAME('dbo.TCNMCst','OBJECT','SELECT') customer_read,HAS_PERMS_BY_NAME('dbo.TCNMCst','OBJECT','UPDATE') customer_update,HAS_PERMS_BY_NAME('dbo."+headerTable+"','OBJECT','UPDATE') sale_update;",{}, {receiptWorker:true});
 assert.deepEqual(rights.results[0][0],{customer_read:0,customer_update:0,sale_update:0});tests++;
 if(branch!=='000'){
  const scoped=await query('BEGIN TRANSACTION;'+exec+exec+'ROLLBACK TRANSACTION;',params,{receiptWorker:true});
  assert.equal(scoped.results[0][0].outcome,'applied');assert.equal(scoped.results[1][0].outcome,'replayed');tests+=2;
 }
 const oldDate=new Date(Date.parse(header.FDShdDocDate)-86400000).toISOString().slice(0,10).replaceAll('-','');
 for(const shift of [{time:params.time==='00:00:01'?'00:00:02':'00:00:01'},{date:oldDate,time:'23:59:59'}]){
  const result=await query('BEGIN TRANSACTION;'+blankFixture+exec+exec+"SELECT COUNT(*) audit_rows FROM dbo.SCCRM_ReceiptTimeAudit WHERE operation_id=@operation;ROLLBACK TRANSACTION;",{...params,...shift});
  assert.equal(result.results[0][0].time_policy,'ada-final-time-v1');assert.equal(result.results[0][0].time_adjusted,1);
  assert.equal(result.results[0][0].native_sold_at,header.FDShdDocDate.slice(0,10)+'T'+header.FTShdDocTime+'+07:00');
  assert.equal(result.results[1][0].outcome,'replayed');assert.equal(result.results[2][0].audit_rows,1);tests+=4;
 }
 const walkInFixture=`UPDATE dbo.${headerTable} SET FTCstCode='0' WHERE FTShdDocNo=@doc AND FTBchCode=@branch;`;
 const walkIn=await query('BEGIN TRANSACTION;'+walkInFixture+exec+exec+'ROLLBACK TRANSACTION;',params);
 assert.equal(walkIn.results[0][0].outcome,'applied');assert.equal(walkIn.results[1][0].outcome,'replayed');tests+=2;
 for(const fixture of ["UPDATE dbo.TCNMCst SET FTCstName=N'An actual named customer' WHERE FTCstCode='0';"+walkInFixture,
  `UPDATE dbo.${headerTable} SET FTCstCode='000' WHERE FTShdDocNo=@doc AND FTBchCode=@branch;`]){
  const denied=await query('BEGIN TRY BEGIN TRANSACTION;'+fixture+exec+"ROLLBACK TRANSACTION;SELECT 'unexpected' result;END TRY BEGIN CATCH IF XACT_STATE()<>0 ROLLBACK TRANSACTION;SELECT ERROR_MESSAGE() result;END CATCH",params);
  assert.equal(denied.results[0][0].result,'RECEIPT_OTHER_MEMBER');tests++;
 }
 for(const [key,value] of [['code','0'],['grand',header.FCShdGrand+1],['branch',branch==='001'?'003':'001'],['pos',header.FTPosCode==='001'?'002':'001'],['name','A different person'],['phone','0990000000'],
  ...['FCSdtQty','FCSdtSetPrice','FCSdtNet','FCSdtDis'].map(key=>['items',itemsXml(items.map((r,i)=>i?r:{...r,[key]:(r[key]||0)+1}))])]){
  const p={...params,[key]:value};
  const result=await query('BEGIN TRY BEGIN TRANSACTION;'+blankFixture+exec+" ROLLBACK TRANSACTION;SELECT 'unexpected' result;END TRY BEGIN CATCH IF XACT_STATE()<>0 ROLLBACK TRANSACTION;SELECT ERROR_MESSAGE() result;END CATCH",p);
  assert.match(result.results[0][0].result,/^RECEIPT_/);assert.notEqual(result.results[0][0].result,'unexpected');tests++;
 }
 const owned=await query("BEGIN TRY BEGIN TRANSACTION;UPDATE dbo."+headerTable+" SET FTCstCode='AR999-999999' WHERE FTShdDocNo=@doc AND FTBchCode=@branch;"+exec+"ROLLBACK TRANSACTION;SELECT 'unexpected' result;END TRY BEGIN CATCH IF XACT_STATE()<>0 ROLLBACK TRANSACTION;SELECT ERROR_MESSAGE() result;END CATCH",params);
 assert.equal(owned.results[0][0].result,'RECEIPT_OTHER_MEMBER');tests++;
 const notFinal=await query('BEGIN TRY BEGIN TRANSACTION;'+blankFixture+`UPDATE dbo.${headerTable} SET FTShdStaPaid='0' WHERE FTShdDocNo=@doc AND FTBchCode=@branch;`+exec+"ROLLBACK TRANSACTION;SELECT 'unexpected' result;END TRY BEGIN CATCH IF XACT_STATE()<>0 ROLLBACK TRANSACTION;SELECT ERROR_MESSAGE() result;END CATCH",params);
 assert.equal(notFinal.results[0][0].result,'RECEIPT_NOT_FINAL');tests++;
 const after=await snapshot();assert.equal(hash(after),hash(before));tests++;
 return {ok:true,branch,database:copy.databaseFor(branch),tests,productionWrites:0,pinRead:false,
  originalCustomers:before.TCNMCst.length,customerColumns:columns.TCNMCst.length,customerAndSalesUnchanged:true,
  receiptRowsBefore:Object.fromEntries(tables.filter(t=>t!=='TCNMCst').map(t=>[t,before[t].length]))};
}
module.exports={run,itemsXml};
if(require.main===module)run(process.argv[2],process.argv.includes('--time-copy')?require('./time-copy.cjs'):defaultCopy).then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(JSON.stringify({ok:false,code:/^[A-Z_]{4,80}$/.test(e.message)?e.message:'RECEIPT_COPY_TEST_FAILED',stage:e.stage,copySqlMessage:e.copySqlMessage,sqlNumber:e.result?.sqlNumber,type:e.constructor.name,productionWrites:0}));process.exitCode=1;});
