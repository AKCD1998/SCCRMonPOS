'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {nativeValidity}=require('./sql-adapter.cjs');
const row=(issue,expiry,eligible=1)=>({card_issue_date:issue,card_expiry_date:expiry,native_lookup_eligible:eligible});
test('only a native-searchable card with the approved 100-calendar-year validity can acknowledge',()=>{
 assert.deepEqual(nativeValidity(row('2026-10-29','2126-10-29')),{cardIssueDate:'2026-10-29',cardExpiryDate:'2126-10-29',nativeLookupEligible:true});
 for(const r of [{},row(null,null),row('2026-10-29','2027-10-29'),row('2026-10-29','2126-10-29',0),row('2026-10-29','2126-10-29',true),row('2026-02-30','2126-03-02'),row('2026/10/29','2126/10/29'),row('2026-10-29','9999-12-31')])assert.throws(()=>nativeValidity(r),{code:'ACK_NATIVE_VALIDITY_MISMATCH'});
});
test('SQL DATEADD calendar semantics preserve leap dates and clamp the exceptional century',()=>{
 assert.equal(nativeValidity(row('2024-02-29','2124-02-29')).cardExpiryDate,'2124-02-29');
 assert.equal(nativeValidity(row('2000-02-29','2100-02-28')).cardExpiryDate,'2100-02-28');
 assert.throws(()=>nativeValidity(row('2000-02-29','2100-03-01')),{code:'ACK_NATIVE_VALIDITY_MISMATCH'});
});
