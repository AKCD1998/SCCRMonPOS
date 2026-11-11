'use strict';
// Operator-only, read the three approved real receipts and replay solely in
// marker-owned copies. Credentials remain in memory and child stdin.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const copy=require('./time-copy.cjs'),{readAdmin}=require('../fanout/admin-source.cjs'),{receive}=require('./native-adapter.cjs');
const hash=v=>crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const jobs=JSON.parse(fs.readFileSync(path.join(copy.RUNTIME,'real-jobs.json'),'utf8'));
let stage='start';
async function run({reuseFixtures=false}={}){
 const results=[];
 for(const b of ['000','004']){
  const live=copy.target(b),target={...copy.target('000',copy.databaseFor(b)),branch:b};
  const metadata={};const meta=table=>metadata[table]||(metadata[table]=copy.sql(live,"SELECT name,TYPE_NAME(system_type_id) data_type FROM sys.columns WHERE object_id=OBJECT_ID(@table) AND name NOT LIKE '%pin%' AND name NOT LIKE '%password%' AND name NOT LIKE '%secret%' AND name NOT LIKE '%token%' ORDER BY column_id",{table:'dbo.'+table}).results[0]);
  const tableNames=b==='000'?['TCNMCst','TPSTSalHD','TPSTSalDT']:['TCNMCst','TSHD002','TSDT002'];
  for(const record of reuseFixtures?[]:jobs.filter(j=>j.target_branch===b)){
   const p=record.payload;
   for(const table of tableNames){
    stage=b+':read:'+table;
    const cols=meta(table).map(r=>{assert.match(r.name,/^[A-Za-z0-9_]+$/);return r.name;}),dates=meta(table).filter(r=>['datetime','smalldatetime'].includes(r.data_type)).map(r=>r.name),where=table==='TCNMCst'?'FTCstCode=@code':'FTBchCode=@branch AND FTShdDocNo=@doc';
    const rows=copy.sql(live,'SELECT '+cols.map(c=>'['+c+']').join(',')+' FROM dbo.['+table+'] WHERE '+where,{code:p.adaCode,branch:p.branchCode,doc:p.receiptNo}).results[0];
    assert(rows.length,table+' must contain approved real evidence');
    for(const row of rows){const keys=Object.keys(row),params=Object.fromEntries(keys.map((k,i)=>['v'+i,row[k]]));
     stage=b+':copy:'+table;
     const lookup=table==='TCNMCst'?'FTCstCode=@v'+keys.indexOf('FTCstCode'):'FTBchCode=@v'+keys.indexOf('FTBchCode')+' AND FTShdDocNo=@v'+keys.indexOf('FTShdDocNo')+((table==='TPSTSalDT'||/^TSDT[0-9]{3}$/.test(table))?' AND FNSdtSeqNo=@v'+keys.indexOf('FNSdtSeqNo'):'');
     await copy.query(b,'IF NOT EXISTS(SELECT 1 FROM dbo.['+table+'] WHERE '+lookup+') INSERT dbo.['+table+']('+keys.map(c=>'['+c+']').join(',')+') VALUES('+keys.map((c,i)=>'@v'+i).join(',')+');',params,{dateParameters:dates.map(k=>'v'+keys.indexOf(k))});
    }
   }
  }
  const snap=async()=>{const value={};for(const table of [...tableNames,'TCNTCstPoint'])value[table]=(await copy.query(b,'SELECT * FROM dbo.['+table+']')).results[0];return hash(value);};
  stage=b+':snapshot';const before=await snap(),admin=readAdmin('000');
  try{for(const record of jobs.filter(j=>j.target_branch===b)){
   const job={id:record.id,targetBranch:b,payloadHash:record.payload_hash,payload:record.payload};
   stage=b+':adapter:'+job.payload.receiptNo;
   const a=await receive(target,admin,job,{mode:'Copy',rollbackCopy:true});
   const again=await receive(target,admin,job,{mode:'Copy',rollbackCopy:true});
   assert.equal(a.timePolicy,'ada-final-time-v1');assert.equal(a.timeAdjusted,true);assert.equal(a.nativeSoldAt,again.nativeSoldAt);
   assert.equal(a.adaCode,record.member_code);assert.equal(Date.parse(a.submittedSoldAt),Date.parse(record.payload.soldAt));
   assert.equal(Date.parse(a.nativeSoldAt)>Date.parse(a.submittedSoldAt),true);
   results.push({branch:b,receiptNo:job.payload.receiptNo,adaCode:a.adaCode,submittedSoldAt:a.submittedSoldAt,nativeSoldAt:a.nativeSoldAt,repeatSameProof:true});
  }}finally{admin.password='';}
  assert.equal(await snap(),before,'all customer, receipt and point rows preserved by outer rollback');
 }
 const proof={ok:true,results,productionWrites:0,pinRead:false,customerSaleAndPointRowsUnchanged:true};
 fs.writeFileSync(path.join(copy.RUNTIME,'real-copy-proof.json'),JSON.stringify(proof,null,2));return proof;
}
if(require.main===module)run({reuseFixtures:process.argv.includes('--reuse-fixtures')}).then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(JSON.stringify({ok:false,code:e.code||e.message,stage:e.stage||stage,context:stage,sqlNumber:e.sqlNumber||e.result?.sqlNumber,copyDetail:e.copySqlMessage||e.result?.detail,detailsWithheld:true}));process.exitCode=1;});
module.exports={run};
