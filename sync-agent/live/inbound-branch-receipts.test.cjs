'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {verifiedRecords}=require('./branch-receipts.cjs');
const doc='S2404004001-0000001',documents=[{doc,table:'TPSTSalHD'}];
function fixture(){const first={headers:[{FTShdDocNo:doc,FTBchCode:'004',FTPosCode:'001',FTShdDocType:'1',FTShdStaPaid:'3',FTShdStaDoc:'1',FTCstCode:'AR003-000001'}],lines:[{FTShdDocNo:doc,FTBchCode:'004',FNSdtSeqNo:1,FTPdtCode:'SYNTHETIC',FCSdtQty:'1.5'}]};return {ok:true,branch:'004',sourceId:'branch004/AdaAcc',productionWrites:0,pinRead:false,first,second:structuredClone(first)};}
test('stable native branch snapshots retain the original cross-branch member code',()=>{
 const p=verifiedRecords(fixture(),documents);assert.equal(p.headers[0].owner,'AR003-000001');assert.equal(p.lines[0].owner,'AR003-000001');assert.equal(p.sourceId,'branch004/AdaAcc');assert.deepEqual(p.pending,[]);
});
test('a moving native bill is pending and cannot publish either header or items',()=>{
 const p=fixture();p.second.lines[0].FCSdtQty='2';const result=verifiedRecords(p,documents);assert.deepEqual(result.pending,[doc]);assert.equal(result.headers.length,0);assert.equal(result.lines.length,0);
});
test('unexpected documents, changed source identities and secret fields refuse the source packet',()=>{
 const wrong=fixture();wrong.first.headers[0].FTShdDocNo='S2404004001-0000002';assert.throws(()=>verifiedRecords(wrong,documents),/BRANCH_RECEIPTS_DOCUMENT_REFUSED/);
 const source=fixture();source.sourceId='hq000/AdaAcc';assert.throws(()=>verifiedRecords(source,documents),/BRANCH_RECEIPTS_ACK_REFUSED/);
 const secret=fixture();secret.first.headers[0].password='synthetic';secret.second=structuredClone(secret.first);assert.throws(()=>verifiedRecords(secret,documents),/SENSITIVE_SOURCE_FIELD_REFUSED/);
});
