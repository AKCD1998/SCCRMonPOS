'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const p=require('./contact-phones.cjs');
const example={memberId:'11111111-1111-4111-8111-111111111111',adaCode:'AR000-000123',primaryPhone:'0812345678',alternatePhone:'081234567',approvalReference:'fixture approval'};
test('contact approval retains a single valid assignment phone and permits a search-only typo',()=>{
 assert.equal(p.validate(example).nativePhone,'0812345678;081234567');
 for(const change of [{primaryPhone:'081234567'},{alternatePhone:'0812345678'},{alternatePhone:"123';DROP"},{approvalReference:''},{adaCode:'OTHER'}])assert.throws(()=>p.validate({...example,...change}));
});
test('HQ snapshots and acknowledgements keep immutable primary profiles',()=>{
 const sql=fs.readFileSync(path.join(__dirname,'Hq.sql'),'utf8').split(/\r?\nGO\r?\n/);
 const create=p.patchProcedure('SCCRM_CreateMemberFromSccrmV2',sql[0]);
 assert.match(create,/ContactPhoneMatches\(a.member_id,a.ada_code/);
 assert.match(create,/CONVERT\(varbinary\(max\),a.profile_phone\)=CONVERT\(varbinary\(max\),@Phone\)/);
 const snapshot=p.patchProcedure('SCCRM_GetAssignedCustomerSnapshot',sql[2].replace('__SNAPSHOT_COLUMNS__','c.[FTCstCode],c.[FTCstTel]'));
 assert.match(snapshot,/a.profile_phone AS \[FTCstTel\]/);
 assert.throws(()=>p.patchProcedure('SCCRM_CreateMemberFromSccrmV2',create));
});
test('branch replay accepts only approved contact representation; migration remains exact',()=>{
 const sql=fs.readFileSync(path.join(__dirname,'Target.sql'),'utf8').split(/\r?\nGO\r?\n/).find(x=>x.includes('CREATE PROCEDURE dbo.SCCRM_ReceiveAssignedMember'));
 const patched=p.patchProcedure('SCCRM_ReceiveAssignedMember',sql);
 assert.match(patched,/ContactPhoneMatches\(r.member_id,r.ada_code/);
 assert.match(patched,/a.profile_phone profile_phone/);
 assert.equal((patched.match(/ISNULL\(c.FTCstTel,''\)\)=CONVERT\(varbinary\(max\),@Phone\)/g)||[]).length,1);
 assert.throws(()=>p.patchProcedure('Unknown',sql));
 assert.throws(()=>p.patchProcedure('SCCRM_ReceiveAssignedMember',sql.replace("SET @Outcome='existing'",'changed')));
});
test('writes are confined to native telephone under unchanged assignment and customer guards',()=>{
 const sql=p.applySql(example);
 assert.equal((sql.match(/UPDATE dbo.TCNMCst SET/g)||[]).length,1);
 assert.match(sql,/SET FTCstTel=/);assert.match(sql,/CONTACT_NATIVE_CHANGED/);
 assert.match(sql,/CONTACT_ASSIGNMENT_REFUSED/);assert.match(sql,/CONTACT_APPROVAL_CONFLICT/);
 for(const field of ['FCCstRetPoint','FTCstCode=','profile_phone='])assert.ok(!sql.includes('SET '+field));
 assert.match(p.matcher,/p.member_id=@MemberId/);assert.match(p.matcher,/p.native_phone\)=CONVERT\(varbinary\(max\),@Native\)/);
});
test('receipt attachment and verification recognize the approved primary without changing name checks',()=>{
 for(const [name,file]of [['SCCRM_AttachReceiptMember','native-receiver.sql'],['SCCRM_ReadReceiptSnapshot','read-snapshot.sql']]){
  const sql=fs.readFileSync(path.join(__dirname,'../receipts',file),'utf8');
  const patched=p.patchProcedure(name,sql);
  assert.match(patched,/ContactPhoneMatches\(\(SELECT member_id/);
  assert.match(patched,/@ExpectedPhone IS NULL OR/);
  assert.match(patched,/RTRIM\(@ExpectedName\)/);
 }
});
