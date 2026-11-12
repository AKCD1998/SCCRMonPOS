'use strict';
// Explicit operator fixture: all native writes are in pre-existing marker-owned copies.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const c=require('./time-copy.cjs'),{readAdmin}=require('../fanout/admin-source.cjs'),{stableRead}=require('./completeness.cjs');
const ROOT=path.join(__dirname,'runtime/completeness-20261112'),branches=['000','001','003','004','005'],hash=v=>crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const read=f=>JSON.parse(fs.readFileSync(path.join(ROOT,f),'utf8'));
const source=()=>fs.readFileSync(path.join(__dirname,'read-snapshot.sql'),'utf8');
function installCopies(){const proof=[];for(const b of branches){const t=c.target('000',c.databaseFor(b));
 const exists=c.sql(t,"SELECT OBJECT_ID('dbo.SCCRM_ReadReceiptSnapshot') id",{},{copy:true}).results[0][0].id;
 const sql=source().replace('CREATE PROCEDURE',exists?'ALTER PROCEDURE':'CREATE PROCEDURE').replaceAll('__DATABASE__',t.database).replaceAll('__TARGET__',b);
 c.sql(t,[sql,"IF USER_ID('SCCRM_ReceiptCopyWorker') IS NULL CREATE USER SCCRM_ReceiptCopyWorker WITHOUT LOGIN;GRANT EXECUTE ON dbo.SCCRM_ReadReceiptSnapshot TO SCCRM_ReceiptCopyWorker;"],{},{copy:true,transaction:true});
 const rights=c.sql(t,"SELECT HAS_PERMS_BY_NAME('dbo.SCCRM_ReadReceiptSnapshot','OBJECT','EXECUTE') reader,HAS_PERMS_BY_NAME('dbo.TCNMCst','OBJECT','UPDATE') customers,HAS_PERMS_BY_NAME('dbo.TPSTSalHD','OBJECT','UPDATE') sales,HAS_PERMS_BY_NAME('dbo.TCNTCstPoint','OBJECT','UPDATE') points",{},{copy:true,receiptWorker:true}).results[0][0];
 assert.deepEqual(rights,{reader:1,customers:0,sales:0,points:0});proof.push({branch:b,rights});}
 const p={ok:true,readerHash:hash(source()),proof,productionWrites:0};fs.writeFileSync(path.join(ROOT,'reader-copies.json'),JSON.stringify(p,null,2));return p;}
function seedTwo(){const cases=read('baseline-two.json').cases;for(const b of ['000','005']){const t=c.target('000',c.databaseFor(b));for(const v of cases){const doc=v.claim.receipt_no,code=v.member_code;
 for(const table of ['TCNMCst','TPSTSalHD','TPSTSalDT']){const columns=c.sql(t,"SELECT name FROM sys.columns WHERE object_id=OBJECT_ID(@table) AND name NOT LIKE '%pin%' AND name NOT LIKE '%password%' AND name NOT LIKE '%secret%' AND name NOT LIKE '%token%' ORDER BY column_id",{table:'dbo.'+table},{copy:true}).results[0].map(x=>{assert.match(x.name,/^[A-Za-z0-9_]+$/);return '['+x.name+']';});
 const where=table==='TCNMCst'?'s.FTCstCode=@code':'s.FTShdDocNo=@doc',key=table==='TCNMCst'?'d.FTCstCode=s.FTCstCode':'d.FTBchCode=s.FTBchCode AND d.FTShdDocNo=s.FTShdDocNo'+(table==='TPSTSalDT'?' AND d.FNSdtSeqNo=s.FNSdtSeqNo':'');
 c.sql(t,`INSERT dbo.${table}(${columns}) SELECT ${columns.map(x=>'s.'+x)} FROM AdaAcc.dbo.${table} s WHERE ${where} AND NOT EXISTS(SELECT 1 FROM dbo.${table} d WHERE ${key})`,{doc,code},{copy:true});}
 const p=v.deliveries.find(d=>d.target_branch===b).payload;c.sql(t,'UPDATE dbo.TCNMCst SET FTCstName=@name,FTCstTel=@phone WHERE FTCstCode=@code',{name:p.expectedName,phone:p.expectedPhone,code},{copy:true});
 const rc='FTShdDocNo,FNSrcSeqNo,FTRcvCode,FCSrcAmt,FCSrcNet,FCSrcChg';
 c.sql(t,`IF OBJECT_ID('dbo.TPSTSalRC') IS NULL SELECT TOP(0) ${rc} INTO dbo.TPSTSalRC FROM AdaAcc.dbo.TPSTSalRC;
  INSERT dbo.TPSTSalRC(${rc}) SELECT ${rc.split(',').map(x=>'s.'+x)} FROM AdaAcc.dbo.TPSTSalRC s WHERE s.FTShdDocNo=@doc AND NOT EXISTS(SELECT 1 FROM dbo.TPSTSalRC d WHERE d.FTShdDocNo=s.FTShdDocNo AND d.FNSrcSeqNo=s.FNSrcSeqNo)`,{doc},{copy:true});
 }}return {ok:true,seeded:2,productionWrites:0};}
function signature(b){const t=c.target('000',c.databaseFor(b)),data={};for(const table of ['TCNMCst','TPSTSalHD','TPSTSalDT','TCNTCstPoint']){
 const cols=c.sql(t,"SELECT name FROM sys.columns WHERE object_id=OBJECT_ID(@table) AND name NOT LIKE '%pin%' AND name NOT LIKE '%password%' AND name NOT LIKE '%secret%' AND name NOT LIKE '%token%' ORDER BY column_id",{table:'dbo.'+table},{copy:true}).results[0].map(x=>{assert.match(x.name,/^[A-Za-z0-9_]+$/);return '['+x.name+']';});
 data[table]=c.sql(t,`SELECT ${cols} FROM dbo.${table}`,{},{copy:true}).results[0];}return hash(data);}
async function verify(){const before=Object.fromEntries(['000','005'].map(b=>[b,signature(b)])),admin=readAdmin('000'),proof=[];
 try{for(const v of read('baseline-two.json').cases){const p=v.deliveries[0].payload,job={id:v.claim.id,policy:'ada-receipt-completeness-v1',identity:{memberId:v.claim.user_id,adaCode:v.member_code,branchCode:v.claim.branch_code,posCode:v.claim.receipt_snapshot.posCode,receiptNo:v.claim.receipt_no},expectedName:p.expectedName,expectedPhone:p.expectedPhone};
 const observations={};for(const b of ['000','005']){
  const t={...c.target('000',c.databaseFor(b)),branch:b};observations[b]=await stableRead(t,admin,job,{mode:'Copy'});
  const query='EXEC dbo.SCCRM_ReadReceiptSnapshot @Branch=@branch,@Pos=@pos,@Doc=@doc,@AdaCode=@code,@ExpectedName=@name,@ExpectedPhone=@phone';
  const restricted=c.sql(t,query,{branch:'005',pos:job.identity.posCode,doc:job.identity.receiptNo,code:job.identity.adaCode,name:job.expectedName,phone:job.expectedPhone},{copy:true,receiptWorker:true}).results;
  assert.equal(restricted[0].length,1);assert.equal(restricted[4][0].memberMatches,true);
 }
 proof.push({claimId:v.claim.id,identity:job.identity,source:observations['005'],hq:observations['000']});
 }}finally{admin.password='';}
 assert.deepEqual(Object.fromEntries(['000','005'].map(b=>[b,signature(b)])),before);
 const result={ok:true,readerHash:hash(source()),proof,customerSalePointRowsUnchanged:true,productionWrites:0};fs.writeFileSync(path.join(ROOT,'two-copy-observations.json'),JSON.stringify(result,null,2));return {ok:true,cases:proof.length,productionWrites:0,customerSalePointRowsUnchanged:true};
}
if(require.main===module)Promise.resolve().then(()=>({installCopies,seedTwo,verify})[process.argv[2]]()).then(x=>console.log(JSON.stringify(x))).catch(e=>{console.log(JSON.stringify({ok:false,code:e.code||e.message,copyDetail:e.copyDetail,sqlDetail:e.copySqlMessage}));process.exitCode=1;});
module.exports={installCopies,seedTwo,verify,ROOT,source,signature};
