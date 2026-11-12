'use strict';
// Operator-only: bounded production reads, all writes in marker-owned copies.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const c=require('./time-copy.cjs'),{receive}=require('./native-adapter.cjs'),{readAdmin}=require('../fanout/admin-source.cjs');
const root=path.join(__dirname,'runtime/items-recheck-20261112'),read=f=>JSON.parse(fs.readFileSync(path.join(root,f),'utf8'));
const hash=v=>crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const cases=read('recovery-pg-before.json').cases;
const fields=['FTBchCode','FTShdDocNo','FNSdtSeqNo','FTPdtCode','FTPdtName','FTSdtBarCode','FTPunCode','FTSdtUnitName','FCSdtQty','FCSdtSetPrice','FCSdtNet','FCSdtDis','FTPmhCode'];
function native(b){
 const docs=cases.filter(x=>b==='000'||x.claim.branch_code===b).map(x=>x.claim.receipt_no);assert(docs.every(d=>/^S[0-9]{10}-[0-9]+$/.test(d)));
 const list=docs.map(d=>"'"+d+"'").join(',');
 const a=c.sql(c.target(b),`SELECT FTBchCode,FTPosCode,FTShdDocNo,FTCstCode,FTShdDocType,FTShdStaPaid,FTShdStaDoc,FCShdGrand,FCShdDis,FCShdRnd,FDShdDocDate,FTShdDocTime
 FROM dbo.TPSTSalHD WHERE FTShdDocNo IN(${list}) ORDER BY FTBchCode,FTShdDocNo;
 SELECT ${fields.join(',')} FROM dbo.TPSTSalDT WHERE FTShdDocNo IN(${list}) ORDER BY FTBchCode,FTShdDocNo,FNSdtSeqNo;
 SELECT FTShdDocNo,FNSrcSeqNo,FTRcvCode,FCSrcAmt,FCSrcNet,FCSrcChg,FDDateIns,FTTimeIns FROM dbo.TPSTSalRC WHERE FTShdDocNo IN(${list}) ORDER BY FTShdDocNo,FNSrcSeqNo;
 SELECT branch_code,doc_no,COUNT(*) n FROM dbo.SCCRM_ReceiptSyncJournal WHERE doc_no IN(${list}) GROUP BY branch_code,doc_no;`).results;
 return {at:new Date().toISOString(),branch:b,headers:a[0],items:a[1],payments:a[2],journals:a[3]};
}
async function prepare(){
 assert.equal(cases.length,8);
 const passes=[];for(let pass=0;pass<2;pass++){const n={};for(const b of ['000','001','003','004'])n[b]=native(b);passes.push(n);}
 fs.writeFileSync(path.join(root,'recovery-native-read-passes.json'),JSON.stringify(passes,null,2));
 const packets=[];
 for(const v of cases){const cl=v.claim,b=cl.branch_code,doc=cl.receipt_no;
  const subset=(n)=>({headers:n.headers.filter(h=>h.FTBchCode===b&&h.FTShdDocNo===doc),items:n.items.filter(i=>i.FTBchCode===b&&i.FTShdDocNo===doc),payments:n.payments.filter(p=>p.FTShdDocNo===doc),journals:n.journals.filter(j=>j.branch_code===b&&j.doc_no===doc)});
  const source=subset(passes[0][b]);assert.deepEqual(source,subset(passes[1][b]));assert.deepEqual(source,subset(passes[1]['000']));
  assert.equal(source.headers.length,1);assert.equal(source.journals.length,0);
  const h=source.headers[0];assert.equal(h.FTShdStaPaid,'3');assert.equal(h.FTShdStaDoc,'1');assert.equal(h.FTShdDocType,'1');assert(['0','',v.member_code].includes((h.FTCstCode||'').trim()));
  const final={...cl.receipt_snapshot,totalAmount:h.FCShdGrand,receiptDiscount:h.FCShdDis,items:source.items.map(i=>({seq:i.FNSdtSeqNo,productCode:i.FTPdtCode,productName:i.FTPdtName,barcode:i.FTSdtBarCode||null,unitCode:i.FTPunCode||null,unitName:i.FTSdtUnitName||null,qty:i.FCSdtQty,unitPrice:i.FCSdtSetPrice,lineTotal:i.FCSdtNet,lineDiscount:i.FCSdtDis||0,promotionCode:i.FTPmhCode||null}))};
  const p={policy:'ada-final-missing-suffix-v1',claimId:cl.id,memberId:cl.user_id,adaCode:v.member_code,branchCode:b,posCode:cl.receipt_snapshot.posCode,receiptNo:doc,originalSnapshot:cl.receipt_snapshot,finalSnapshot:final,
   nativeProof:{originBranch:b,pos:cl.receipt_snapshot.posCode,doc,paid:h.FTShdStaPaid,documentStatus:h.FTShdStaDoc,sourceAndHqMatch:true,stableReadCount:2,nativeJournalCount:0,paymentRows:source.payments.length,paymentNet:source.payments.reduce((n,r)=>n+r.FCSrcNet,0),rounding:h.FCShdRnd||0,snapshotHash:hash(final),sourceHash:hash(source),observedAt:passes[1][b].at}};
  packets.push(p);
 }
 fs.writeFileSync(path.join(root,'recovery-packets.json'),JSON.stringify(packets,null,2));
 return {ok:true,cases:packets.length,appendedLines:packets.reduce((n,p)=>n+p.finalSnapshot.items.length-p.originalSnapshot.items.length,0),productionWrites:0};
}
function seed(){
 const results=[];
 for(const b of ['000','001','003','004']){
  c.create(b);const t=c.target('000',c.databaseFor(b));
  const selected=cases.filter(v=>b==='000'||v.claim.branch_code===b),docs=selected.map(v=>"'"+v.claim.receipt_no+"'").join(','),codes=selected.map(v=>"'"+v.member_code+"'").join(',');
  const qs=[];
  for(const table of ['TCNMCst','TPSTSalHD','TPSTSalDT']){
   const cols=c.sql(t,"SELECT name FROM sys.columns WHERE object_id=OBJECT_ID(@table) AND name NOT LIKE '%pin%' AND name NOT LIKE '%password%' AND name NOT LIKE '%secret%' AND name NOT LIKE '%token%' ORDER BY column_id",{table:'dbo.'+table},{copy:true}).results[0].map(x=>{assert.match(x.name,/^[A-Za-z0-9_]+$/);return '['+x.name+']';});
   const where=table==='TCNMCst'?`s.FTCstCode IN(${codes})`:`s.FTShdDocNo IN(${docs})`,key=table==='TCNMCst'?'d.FTCstCode=s.FTCstCode':'d.FTBchCode=s.FTBchCode AND d.FTShdDocNo=s.FTShdDocNo'+(table==='TPSTSalDT'?' AND d.FNSdtSeqNo=s.FNSdtSeqNo':'');
   qs.push(`INSERT dbo.${table}(${cols}) SELECT ${cols.map(x=>'s.'+x)} FROM AdaAcc.dbo.${table} s WHERE ${where} AND NOT EXISTS(SELECT 1 FROM dbo.${table} d WHERE ${key});`);
  }
  const rc='FTShdDocNo,FNSrcSeqNo,FTRcvCode,FTRcvName,FTSrcRef,FCSrcAmt,FCSrcNet,FCSrcChg';
  qs.push(`IF OBJECT_ID('dbo.TPSTSalRC') IS NULL SELECT TOP(0) ${rc} INTO dbo.TPSTSalRC FROM AdaAcc.dbo.TPSTSalRC;
   INSERT dbo.TPSTSalRC(${rc}) SELECT ${rc.split(',').map(x=>'s.'+x)} FROM AdaAcc.dbo.TPSTSalRC s WHERE s.FTShdDocNo IN(${docs}) AND NOT EXISTS(SELECT 1 FROM dbo.TPSTSalRC d WHERE d.FTShdDocNo=s.FTShdDocNo AND d.FNSrcSeqNo=s.FNSrcSeqNo);`);
  c.sql(t,qs,{},{copy:true,transaction:true});results.push({branch:b,copyDatabase:t.database,cases:selected.length});
  // Earlier isolated tests can intentionally alter their synthetic profiles.
  // Restore only this approved fixture set, in the owned copy, before testing.
  for(const v of selected){const p=v.deliveries.find(d=>d.target_branch===b).payload;
   c.sql(t,'UPDATE dbo.TCNMCst SET FTCstName=@name,FTCstTel=@phone WHERE FTCstCode=@code',
    {name:p.expectedName,phone:p.expectedPhone,code:p.adaCode},{copy:true});}
 }
 return {ok:true,results,productionWrites:0,pinRead:false};
}
async function verify(){
 const packets=read('recovery-packets.json'),results=[],admin=readAdmin('000');
 try{for(const p of packets)for(const b of [p.branchCode,'000']){
  const original=cases.find(v=>v.claim.id===p.claimId).deliveries.find(d=>d.target_branch===b),id=crypto.randomUUID();
  const payload={...original.payload,operationId:id,totalAmount:p.finalSnapshot.totalAmount,items:p.finalSnapshot.items,lineAdjustments:null};
  const job={id,targetBranch:b,payload,payloadHash:hash(payload)},target={...c.target('000',c.databaseFor(b)),branch:b};
  const before=c.sql(c.target('000',c.databaseFor(b)),"SELECT FTCstCode FROM dbo.TPSTSalHD WHERE FTBchCode=@branch AND FTShdDocNo=@doc; SELECT COUNT(*) n FROM dbo.TCNTCstPoint",{branch:p.branchCode,doc:p.receiptNo},{copy:true}).results;
  const proof=await receive(target,admin,job,{mode:'Copy',rollbackCopy:true});
  const again=await receive(target,admin,job,{mode:'Copy',rollbackCopy:true});assert.equal(proof.adaCode,p.adaCode);assert.equal(again.nativeSoldAt,proof.nativeSoldAt);
  assert.deepEqual(c.sql(c.target('000',c.databaseFor(b)),"SELECT FTCstCode FROM dbo.TPSTSalHD WHERE FTBchCode=@branch AND FTShdDocNo=@doc; SELECT COUNT(*) n FROM dbo.TCNTCstPoint",{branch:p.branchCode,doc:p.receiptNo},{copy:true}).results,before);
  results.push({branch:b,doc:p.receiptNo,adaCode:p.adaCode,repeatPassed:true,copyRolledBack:true});
 }}finally{admin.password='';}
 const proof={ok:true,results,productionWrites:0,pointWrites:0};fs.writeFileSync(path.join(root,'recovery-native-copy-proof.json'),JSON.stringify(proof,null,2));return proof;
}
const actions={prepare,seed,verify};
if(require.main===module)Promise.resolve().then(()=>{assert(actions[process.argv[2]],'Explicit action required');return actions[process.argv[2]]();}).then(r=>console.log(JSON.stringify(r))).catch(e=>{console.log(JSON.stringify({ok:false,type:e.constructor.name,code:e.code||e.message,sql:e.result?.sqlNumber,detail:e.copySqlMessage}));process.exitCode=1;});
module.exports={prepare,seed,verify};
