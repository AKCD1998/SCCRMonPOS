'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const m=require('../points/model.cjs'),c=require('../points/compensation.cjs');
const clone=x=>JSON.parse(JSON.stringify(x)),CODE='AR001-000001',UUID='00000000-0000-4000-8000-000000000001';
function point(extra={}){return {...Object.fromEntries(m.POINT_FIELDS.map(k=>[k,null])),FTBchCode:'001',FTCstCode:CODE,FTPntRefDoc:'NATIVE-BILL',FTSplCode:'',FDPntDate:'2026-11-02T09:00:00.000',FCPntPointbyOne:'100',FCPntAmtRcv:'200',FNPntPoint:'2',FNPntPointOld:'10',FTPntExpired:'N',FTPntStaPrcDoc:'N',FTPntCardType:'1',FTWhoIns:'AdaPos',...extra};}
function receipt(extra={}){return {operation_id:UUID,ada_code:CODE,branch_code:'001',ref_doc:'SP'+UUID.replaceAll('-','').slice(0,28),revision:'a'.repeat(64),generation:'1',expected_intrinsic:'12',previous_balance:'12',target_balance:'17',delta_points:'5',created_at:'2026-11-02T02:00:00.000',...extra};}
function fixture(delta='5'){
 const r=receipt({delta_points:delta,target_balance:(12n+BigInt(delta)).toString()});
 const owned=point({FTPntRefDoc:r.ref_doc,FCPntPointbyOne:'0',FCPntAmtRcv:'0',FNPntPoint:(BigInt(delta)<0n?-BigInt(delta):BigInt(delta)).toString(),FNPntPointOld:'12',FTPntCardType:BigInt(delta)>0n?'1':'2',FTWhoIns:c.WHO});
 return {branch:'001',mode:'Live',identity:{machine:'SC_001',db:'AdaAcc'},databaseIdentity:'001/SC_001/AdaAcc',customers:[{FTCstCode:CODE,FCCstRetPoint:'10'}],points:delta==='0'?[point()]:[point(),owned],balances:[{FTCstCode:CODE,FNPntPoint:r.target_balance,FCPntAmtRcv:'200'}],ownedCompensation:{present:true,meta:[{singleton:1,marker:c.MARKER,target_identity:'001/SC_001/AdaAcc',branch_code:'001'}],receipts:[r]}};
}
test('proved positive and negative native corrections are removed from events and actual view, preserving raw input',()=>{
 for(const delta of['5','-3']){const raw=fixture(delta),before=clone(raw);assert.equal(m.calculateDatabase(raw).snapshotVerified,true);const derived=c.deriveIntrinsicSnapshot(raw);assert.equal(derived.points.length,1);assert.equal(derived.balances[0].FNPntPoint,'12');assert.equal(derived.intrinsicProof.excludedRows,1);assert.equal(m.calculateDatabase(derived).snapshotVerified,true);assert.deepEqual(raw,before);}
});
test('zero-delta receipt proves no native row and excludes no ordinary row',()=>{
 const raw=fixture('0');assert.equal(c.deriveIntrinsicSnapshot(raw).points.length,1);raw.points.push(point({FTPntRefDoc:raw.ownedCompensation.receipts[0].ref_doc,FNPntPoint:'0'}));assert.throws(()=>c.deriveIntrinsicSnapshot(raw),/POINT_OWNED_ZERO_ROW_REFUSED/);
});
test('receiver insertion-user text without valid receipt proof never excludes an award',()=>{
 const raw=fixture();delete raw.ownedCompensation;const derived=c.deriveIntrinsicSnapshot(raw);assert.equal(derived.points.length,2);assert.equal(derived.balances[0].FNPntPoint,'17');assert.equal(derived.intrinsicProof.excludedRows,0);
 raw.ownedCompensation={present:false,meta:[],receipts:[]};assert.equal(c.deriveIntrinsicSnapshot(raw).points.length,2);
 raw.ownedCompensation=fixture().ownedCompensation;raw.ownedCompensation.receipts=[];assert.equal(c.deriveIntrinsicSnapshot(raw).points.length,2,'empty marked receipt tables do not prove ownership of an insertion-user label');
});
test('missing, altered or duplicated owned row fails closed',()=>{
 for(const mutation of[
  s=>{s.points.pop();s.balances[0].FNPntPoint='12';},
  s=>s.points.push(clone(s.points[1])),
  s=>{s.points[1].FTPntExpired='Y';s.balances[0].FNPntPoint='12';},
  s=>{s.points[1].FTPntStaPrcDoc='Y';s.balances[0].FNPntPoint='12';},
  s=>{s.points[1].FTPntCardType='2';s.balances[0].FNPntPoint='7';},
  s=>{s.points[1].FNPntPoint='6';s.balances[0].FNPntPoint='18';},
  s=>{s.points[1].FTWhoIns='AdaPos';},s=>{s.points[1].FCPntPointbyOne='1';},s=>{s.points[1].FCPntAmtRcv='1';},
  s=>{s.points[1].FNPntPointOld='11';},s=>{s.points[1].FCPntPointbyOne=null;},s=>{s.points[1].FTPntExpired=null;s.balances[0].FNPntPoint='12';},
 ]){const raw=fixture();mutation(raw);assert.throws(()=>c.deriveIntrinsicSnapshot(raw),/POINT_OWNED_/);}
});
test('proof metadata must exactly match its native database, branch and marker',()=>{
 for(const mutation of[s=>{s.databaseIdentity='other';},s=>{s.ownedCompensation.meta[0].marker=null;},s=>{s.ownedCompensation.meta[0].target_identity='001/WRONG/AdaAcc';},s=>{s.ownedCompensation.meta[0].branch_code='005';},s=>{s.ownedCompensation.meta[0].singleton=null;},s=>{s.ownedCompensation.meta.push(clone(s.ownedCompensation.meta[0]));},s=>{s.ownedCompensation.present=false;}]){const raw=fixture();mutation(raw);assert.throws(()=>c.deriveIntrinsicSnapshot(raw),/POINT_OWNED_/);}
});
test('receipt operation reference, owner, arithmetic, generation and calendar fields are validated',()=>{
 for(const change of[{ref_doc:'OTHER'},{ada_code:'OTHER'},{delta_points:'6'},{target_balance:'18'},{previous_balance:null},{expected_intrinsic:'1.5'},{generation:'0'},{generation:'9007199254740992'},{revision:'bad'},{created_at:'2026-11-02T02:00:00.000Z'},{unexpected:'field'}]){const raw=fixture();Object.assign(raw.ownedCompensation.receipts[0],change);assert.throws(()=>c.deriveIntrinsicSnapshot(raw),/POINT_OWNED_/);}
 const duplicate=fixture();duplicate.ownedCompensation.receipts.push(clone(duplicate.ownedCompensation.receipts[0]));assert.throws(()=>c.deriveIntrinsicSnapshot(duplicate),/POINT_OWNED_/);
});
test('raw actual native view must verify before any owned correction is subtracted',()=>{
 const raw=fixture();raw.balances[0].FNPntPoint='999';assert.throws(()=>c.deriveIntrinsicSnapshot(raw),/POINT_OWNED_NATIVE_VIEW_NOT_VERIFIED/);
});
test('multiple corrections subtract their proved sum once and never become a native award',()=>{
 const raw=fixture(),id='10000000-0000-4000-8000-000000000002';
 const r=receipt({operation_id:id,ref_doc:'SP'+id.replaceAll('-','').slice(0,28),generation:'2',previous_balance:'17',target_balance:'14',delta_points:'-3'});
 raw.ownedCompensation.receipts.push(r);raw.points.push(point({FTPntRefDoc:r.ref_doc,FCPntPointbyOne:'0',FCPntAmtRcv:'0',FNPntPoint:'3',FNPntPointOld:'17',FTPntCardType:'2',FTWhoIns:c.WHO}));raw.balances[0].FNPntPoint='14';
 const derived=c.deriveIntrinsicSnapshot(raw);assert.equal(derived.points.length,1);assert.equal(derived.balances[0].FNPntPoint,'12');assert.deepEqual(derived.intrinsicProof.ownedTotals,[{adaCode:CODE,delta:'2'}]);assert.equal(c.deriveIntrinsicSnapshot(raw).intrinsicProof.proofHash,derived.intrinsicProof.proofHash);
});
test('marked fixed PointCopy identity is distinct from its original branch database',()=>{
 const raw=fixture();raw.mode='Copy';raw.identity={machine:'SERVER',db:'SCCRM_PointCopy_20261102_001'};raw.databaseIdentity='copy001/SERVER/SCCRM_PointCopy_20261102_001';raw.ownedCompensation.meta[0].target_identity=raw.databaseIdentity;assert.equal(c.deriveIntrinsicSnapshot(raw).points.length,1);
});
test('SQL GUID hexadecimal casing is accepted only when receipt and native row agree exactly',()=>{
 const raw=fixture(),r=raw.ownedCompensation.receipts[0];r.operation_id='abcdef00-0000-4000-8000-000000000001';r.ref_doc=('SP'+r.operation_id.replaceAll('-','').slice(0,28)).toUpperCase();raw.points[1].FTPntRefDoc=r.ref_doc;assert.equal(c.deriveIntrinsicSnapshot(raw).points.length,1);
 raw.points[1].FTPntRefDoc=r.ref_doc.toLowerCase();assert.throws(()=>c.deriveIntrinsicSnapshot(raw),/POINT_OWNED_ROW_MISSING_OR_DUPLICATE/);
});
test('receipt-proven corrections replicated into another DB are excluded globally only on exact business agreement',()=>{
 const origin=fixture(),replica=clone(origin);replica.branch='003';replica.identity={machine:'POSSRV',db:'AdaAcc'};replica.databaseIdentity='003/POSSRV/AdaAcc';delete replica.ownedCompensation;
 const derived=c.deriveIntrinsicSnapshots([origin,replica]);assert.ok(derived.every(s=>s.points.length===1&&s.balances[0].FNPntPoint==='12'));assert.equal(m.mergeReplicas(derived).canonicalEvents,1);assert.equal(derived[1].intrinsicProof.originProofHashes.length,1);
 assert.equal(c.deriveIntrinsicSnapshots([replica])[0].points.length,2,'Who text without origin receipt evidence remains an ordinary event');
 for(const mutation of[s=>{s.points[1].FNPntPoint='6';s.balances[0].FNPntPoint='18';},s=>{s.points[1].FTWhoIns='AdaCopy';}]){const changed=clone(replica);mutation(changed);assert.throws(()=>c.deriveIntrinsicSnapshots([origin,changed]),/POINT_OWNED_REPLICA_CHANGED/);}
});
