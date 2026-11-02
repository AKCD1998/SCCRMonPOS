'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {readAdmin}=require('../fanout/admin-source.cjs');
const {RUNTIME,safeCode}=require('./export.cjs');
const {invokeNative,createTarget}=require('./native-adapter.cjs');
async function run(){
 const a=readAdmin('000'),state=JSON.parse(fs.readFileSync(path.join(RUNTIME,'native-copy.secrets.json'))),target={branch:'005',server:a.server,machine:a.machine,database:'SCCRM_PointCopy_20261102_005',identity:'copy005/SERVER/SCCRM_PointCopy_20261102_005'};
 const report={ok:false,at:new Date().toISOString(),productionWrites:0,pinRead:false};
 try{
  const admin={user:a.user,password:a.password};
  await invokeNative({mode:'Copy',target,credentials:admin,action:'upgrade-copy'});
  const before=await invokeNative({mode:'Copy',target,credentials:admin,action:'baseline'});
  const adapter=createTarget({mode:'Copy',target,targetId:'branch005',credentials:{user:'sccrm_point_copy_005',password:state.copies['005'].password}});
  const job={operation_id:crypto.randomUUID(),ada_code:'AR000-000017',generation:'3',projection_version:crypto.createHash('sha256').update('copy-race10-protocol3').digest('hex'),target_balance:'10',expected_intrinsic:'3'};
  const first=await adapter.apply(job),again=await adapter.apply(job);
  assert.equal(first.outcome,'applied');assert.equal(first.delta_points,'0');assert.equal(again.outcome,'replayed');
  const after=await invokeNative({mode:'Copy',target,credentials:admin,action:'baseline'});assert.deepEqual(after,before);
  report.ok=true;report.checks=4;report.nativeTemplateSha256=crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname,'native-receiver.sql'))).digest('hex');report.ackCaseChecked=true;report.appendedNativeRows=0;report.unchanged=true;
 }catch(e){report.code=safeCode(e);report.stage=e.stage;report.sqlNumber=e.sqlNumber;throw Object.assign(e,{report});}
 finally{a.password='';fs.writeFileSync(path.join(RUNTIME,'native-protocol-result.json'),JSON.stringify(report,null,2));}
 return report;
}
if(require.main===module)run().then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(JSON.stringify(e.report||{ok:false,code:safeCode(e)}));process.exitCode=1;});
module.exports={run};
