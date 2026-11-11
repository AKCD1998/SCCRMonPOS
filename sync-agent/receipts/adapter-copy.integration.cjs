'use strict';
const crypto=require('node:crypto'),assert=require('node:assert/strict');
const copy=require('../fanout/copy-lab.cjs'),{readAdmin}=require('../fanout/admin-source.cjs');
const {receive}=require('./native-adapter.cjs');
async function run(){
 const branch='005';
 // Live Ada headers require ARITHABORT for indexed DML. SELECT-INTO copies do
 // not preserve those indexes, so retain this copy-only regression fixture.
 await copy.query(branch,`SET ANSI_NULLS ON;SET ANSI_PADDING ON;SET ANSI_WARNINGS ON;SET ARITHABORT ON;
  SET CONCAT_NULL_YIELDS_NULL ON;SET QUOTED_IDENTIFIER ON;SET NUMERIC_ROUNDABORT OFF;
  IF NOT EXISTS(SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID('dbo.TSHD002') AND name='SCCRM_ReceiptCopy_SetOptions')
   CREATE INDEX SCCRM_ReceiptCopy_SetOptions ON dbo.TSHD002(FTCstCode) WHERE FTCstCode IS NOT NULL;`);
 const index=(await copy.query(branch,"SELECT has_filter FROM sys.indexes WHERE object_id=OBJECT_ID('dbo.TSHD002') AND name='SCCRM_ReceiptCopy_SetOptions'")).results[0][0];
 assert(index&&Number(index.has_filter)===1);
 const data=(await copy.query(branch,`SELECT TOP(1) h.FTShdDocNo,h.FTBchCode,h.FTPosCode,h.FDShdDocDate,h.FTShdDocTime,h.FCShdGrand,h.FTCstCode
  FROM dbo.TSHD002 h WHERE h.FTShdStaDoc='1' AND h.FTShdStaPaid='3' AND h.FCShdGrand>0 AND ISNULL(h.FTCstCode,'')='';
  SELECT TOP(1) FTCstCode,FTCstName,FTCstTel FROM dbo.TCNMCst WHERE LEN(LTRIM(RTRIM(FTCstName)))>0 AND LEN(LTRIM(RTRIM(FTCstTel)))>0 ORDER BY FTCstCode;`)).results;
 const h=data[0][0],m=data[1][0];assert(h&&m);
 const items=(await copy.query(branch,`SELECT FNSdtSeqNo,FTPdtCode,FTSdtBarCode,FTPunCode,FTSdtUnitName,FCSdtQty,FCSdtSetPrice,FCSdtNet,FCSdtDis FROM dbo.TSDT002 WHERE FTShdDocNo=@doc AND FTBchCode=@branch ORDER BY FNSdtSeqNo`,{doc:h.FTShdDocNo,branch})).results[0];
 const id=crypto.randomUUID(),payload={version:1,operationId:id,jobId:crypto.randomUUID(),memberId:crypto.randomUUID(),adaCode:m.FTCstCode,branchCode:branch,posCode:h.FTPosCode,
  receiptNo:h.FTShdDocNo,soldAt:h.FDShdDocDate.slice(0,10)+'T'+h.FTShdDocTime+'+07:00',totalAmount:h.FCShdGrand,expectedName:m.FTCstName.trim(),expectedPhone:m.FTCstTel.trim(),
  items:items.map(i=>({seq:Number(i.FNSdtSeqNo),productCode:i.FTPdtCode,barcode:i.FTSdtBarCode,unitCode:i.FTPunCode,unitName:i.FTSdtUnitName,qty:i.FCSdtQty,unitPrice:i.FCSdtSetPrice,lineTotal:i.FCSdtNet,lineDiscount:i.FCSdtDis||0}))};
 const job={id,targetBranch:branch,payload,payloadHash:crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex')};
 const admin=readAdmin('000');let result;
 try{result=await receive({branch,server:'tcp:100.90.166.72,49800',machine:'SERVER',database:copy.databaseFor(branch)},{user:admin.user,password:admin.password},job,{mode:'Copy',rollbackCopy:true});}
 finally{admin.password='';}
 assert.equal(result.operationId,id);assert.equal(result.outcome,'applied');assert(result.tables.includes('TSHD002'));
 const after=(await copy.query(branch,'SELECT FTCstCode FROM dbo.TSHD002 WHERE FTShdDocNo=@doc;SELECT COUNT(*) n FROM dbo.SCCRM_ReceiptSyncJournal WHERE operation_id=@id',{doc:h.FTShdDocNo,id})).results;
 assert.equal(after[0][0].FTCstCode,h.FTCstCode);assert.equal(after[1][0].n,0);
 return {ok:true,scope:'receipt-native-adapter-copy',checks:6,indexedDmlSessionOptionsVerified:true,thaiTextAndDateRoundtrip:true,outerRollbackVerified:true,productionWrites:0,pinRead:false};
}
module.exports={run};
if(require.main===module)run().then(x=>console.log(JSON.stringify(x))).catch(e=>{console.error(JSON.stringify({ok:false,code:/^RECEIPT_[A-Z_]+$/.test(e.message)?e.message:'RECEIPT_ADAPTER_COPY_FAILED',stage:e.stage,type:e.constructor.name,productionWrites:0}));process.exitCode=1;});
