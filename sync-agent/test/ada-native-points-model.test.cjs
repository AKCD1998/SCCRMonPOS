'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const m=require('../points/model.cjs');
function point(extra={}){return Object.assign(Object.fromEntries(m.POINT_FIELDS.map(k=>[k,null])),{FTBchCode:'001',FTCstCode:'AR001-000001',FTPntRefDoc:'S2611001001-0000001',FTSplCode:'',FDPntDate:'2026-11-02T00:00:00.000',FCPntPointbyOne:'100',FCPntAmtRcv:'250',FNPntPoint:'2',FNPntPointOld:'0',FTPntExpired:'N',FTPntStaPrcDoc:'N',FTPntCardType:'1',FTCptJDate:'',FTCptTime:'09:00:00',FTPntStaExpired:'N',FTWhoIns:'ORIGINAL'},extra);}
function snapshot({branch='001',opening='10',points=[],view='10',customers}={}){return {branch,identity:{machine:branch==='001'?'SC_001':'SERVER',db:'AdaAcc'},schemaHash:'same',customers:customers||[{FTCstCode:'AR001-000001',FCCstRetPoint:opening,FCCstRetAmt:'0',FCCstWhsPoint:'123',FCCstDailyPoint:'456'}],points,balances:[{FTCstCode:'AR001-000001',FNPntPoint:view,FCPntAmtRcv:'0'}]};}
test('native view uses retail opening plus active type 1 minus type 2; wholesale and daily are not summed',()=>{
 const r=m.calculateDatabase(snapshot({points:[point({FNPntPoint:'20'}),point({FTPntRefDoc:'R1',FNPntPoint:'3',FTPntCardType:'2'})],view:'27'}));
 assert.equal(r.balances[0].computedPoints,'27');assert.equal(r.snapshotVerified,true);
});
test('expired or processed rows are ignored exactly as the native view filters them',()=>{
 const r=m.calculateDatabase(snapshot({points:[point({FTPntExpired:'Y'}),point({FTPntRefDoc:'P',FTPntStaPrcDoc:'Y'}),point({FTPntRefDoc:'NULL',FTPntExpired:null})]}));assert.equal(r.balances[0].computedPoints,'10');assert.equal(r.snapshotVerified,true);
});
test('type 6 with zero points is ignored without holding a member',()=>{const r=m.calculateDatabase(snapshot({points:[point({FTPntCardType:'6',FNPntPoint:'0'})]}));assert.equal(r.snapshotVerified,true);});
test('unknown nonzero type is ignored by native math but explicitly held for review',()=>{const r=m.calculateDatabase(snapshot({points:[point({FTPntCardType:'6',FNPntPoint:'5'})]}));assert.equal(r.balances[0].computedPoints,'10');assert.equal(r.balances[0].viewMatches,true);assert.equal(r.balances[0].state,'review');assert.ok(r.issues.some(i=>i.code==='POINT_UNKNOWN_NONZERO_TYPE'));});
test('decimal point balance, null point row and unsafe JS integer are refused',()=>{
 for(const v of ['1.5',null,9007199254740992])assert.throws(()=>m.integer(v),m.ModelError);
 const r=m.calculateDatabase(snapshot({opening:null,points:[point({FNPntPoint:null})]}));assert.equal(r.balances[0].state,'review');assert.ok(r.issues.some(i=>i.code==='POINT_NULL'));
});
test('bigints stay exact past Number.MAX_SAFE_INTEGER when supplied as decimal strings',()=>{
 const n='9007199254740993';const r=m.calculateDatabase(snapshot({opening:'0',points:[point({FNPntPoint:n})],view:n}));assert.equal(r.balances[0].computedPoints,n);assert.equal(r.balances[0].viewMatches,true);
});
test('native float view rounding is exposed as a mismatch, never rounded away by JS',()=>{
 const r=m.calculateDatabase(snapshot({opening:'0',points:[point({FNPntPoint:'9007199254740993'})],view:'9007199254740992'}));assert.equal(r.balances[0].state,'review');assert.ok(r.issues.some(i=>i.code==='POINT_NATIVE_VIEW_MISMATCH'));
});
test('signed bigint input and sum overflow hold rather than wrap',()=>{
 assert.throws(()=>m.integer('9223372036854775808'),/POINT_OVERFLOW/);
 const r=m.calculateDatabase(snapshot({opening:'9223372036854775807',points:[point()],view:'0'}));assert.equal(r.balances[0].computedPoints,null);assert.ok(r.issues.some(i=>i.code==='POINT_OVERFLOW'));
});
test('native negative amounts are retained with native CASE signs',()=>{
 const r=m.calculateDatabase(snapshot({points:[point({FNPntPoint:'-2'})],view:'8'}));assert.equal(r.balances[0].computedPoints,'8');assert.equal(r.snapshotVerified,true);
});
test('replaying an identical row does not award it a second time',()=>{const p=point();const r=m.calculateDatabase(snapshot({points:[p,{...p}],view:'12'}));assert.equal(r.replayCount,1);assert.equal(r.balances[0].computedPoints,'12');});
test('a contradictory duplicate within one snapshot is held and never chosen',()=>{const r=m.calculateDatabase(snapshot({points:[point(),point({FNPntPoint:'8'})],view:'10'}));assert.ok(r.issues.some(i=>i.code==='POINT_EVENT_IDENTITY_CONFLICT'));assert.equal(r.balances[0].state,'review');});
test('copies across HQ and branch deduplicate only when every business field agrees',()=>{
 const a=snapshot({branch:'000',points:[point()]});const b=snapshot({points:[point({FTWhoIns:'COPIED',FDDateIns:'2026-11-02T01:00:00.000'})]});const r=m.mergeReplicas([a,b]);assert.equal(r.canonicalEvents,1);assert.equal(r.duplicateReplicas,1);assert.equal(r.conflicts.length,0);
});
test('amount or eligibility flag disagreement between replicas is held',()=>{
 for(const change of [{FNPntPoint:'8'},{FTPntExpired:'Y'},{FCPntAmtRcv:'999'},{FNPntPointOld:'40'}]){
  const r=m.mergeReplicas([snapshot({branch:'000',points:[point()]}),snapshot({points:[point(change)]})]);assert.equal(r.canonicalEvents,0);assert.equal(r.conflictingEvents,1);assert.equal(r.conflicts[0].code,'POINT_REPLICA_BUSINESS_CONFLICT');
 }
});
test('same originating bill with a different owner is held even though native PK contains owner',()=>{
 const r=m.mergeReplicas([snapshot({points:[point()]}),snapshot({branch:'000',points:[point({FTCstCode:'AR001-000002'})]})]);assert.equal(r.canonicalEvents,0);assert.equal(r.conflictingEvents,2);assert.ok(r.conflicts.every(c=>c.code==='POINT_REPLICA_OWNER_CONFLICT'));
});
test('origin branch is a real event key component, not the database receiving a copy',()=>{assert.notEqual(m.keyFor(point()),m.keyFor(point({FTBchCode:'003'})));});
test('a legitimate later flag mutation is a version change, not a new award',()=>{
 const a=snapshot({points:[point()],view:'12'}),b=snapshot({points:[point({FTPntExpired:'Y'})],view:'10'}),r=m.compareEvents(a,b);assert.equal(r.added.length,0);assert.equal(r.changed.length,1);assert.equal(r.changed[0].before.contribution,'2');assert.equal(r.changed[0].after.contribution,'0');assert.equal(m.calculateDatabase(b).balances[0].computedPoints,'10');
});
test('late points are captured once and replay leaves the version unchanged',()=>{
 const a=snapshot(),b=snapshot({points:[point()],view:'12'});assert.equal(m.compareEvents(a,b).added.length,1);assert.equal(m.compareEvents(b,b).unchanged,1);assert.equal(m.compareEvents(b,b).changed.length,0);
});
test('source removal is reported explicitly, never silently subtracted or deleted',()=>{const a=snapshot({points:[point()]});assert.equal(m.compareEvents(a,snapshot()).removed.length,1);});
test('orphan native rows remain visible as held issues, never attached by phone or guessed member',()=>{
 const r=m.calculateDatabase(snapshot({points:[point({FTCstCode:'MISSING'})]}));assert.ok(r.issues.some(i=>i.code==='POINT_EVENT_CUSTOMER_MISSING'));assert.equal(r.heldEvents,1);assert.equal(r.snapshotVerified,false);assert.equal(r.balances[0].computedPoints,'10');
});
test('opening balances across databases are compared, never summed or selected',()=>{
 const a=snapshot({branch:'000',opening:'10'}),b=snapshot({opening:'10'}),c=snapshot({branch:'003',opening:'0'});const r=m.compareDatabases([a,b,c]);assert.equal(r.openings.conflictingCodes,1);assert.equal(r.globalOpeningSelected,false);assert.equal(r.aliasesMerged,false);assert.equal(r.openings.conflicts[0].variants.length,3);
});
test('matching nonzero opening values are reported once as a comparison, not an added balance',()=>{const r=m.compareOpenings([snapshot(),snapshot({branch:'000'})]);assert.equal(r.matchingNonzeroCodes,1);assert.equal(r.matching[0].openingPoints,'10');});
test('native local calendar dates remain calendar strings and cannot acquire a UTC suffix',()=>{
 assert.equal(m.canonicalEvent(point(),'test').businessPayload.FDPntDate,'2026-11-02T00:00:00.000');assert.throws(()=>m.canonicalEvent(point({FDPntDate:'2026-11-02T00:00:00.000Z'}),'test'),/POINT_CALENDAR_FORMAT/);
});
test('decimal representation differences in auxiliary monetary fields do not create false conflicts',()=>{const r=m.mergeReplicas([snapshot({points:[point({FCPntAmtRcv:'250.00'})]}),snapshot({branch:'000',points:[point({FCPntAmtRcv:'2.5E2'})]})]);assert.equal(r.canonicalEvents,1);assert.equal(r.conflicts.length,0);});
test('unexpected extra fields are refused, including PIN-shaped fields',()=>{assert.throws(()=>m.canonicalEvent(point({FTCstPin:'must-not-accept'}),'test'),/POINT_EVENT_FIELDS_REFUSED/);});
test('native home branch metadata is reported independently of code prefix and opening authority is not selected',()=>{
 const master=opening=>[{FTCstCode:'AR005-000001',FCCstRetPoint:opening,FTBchCode:'001',FDCstLastPoint:'2020-01-01T00:00:00.000',FDDateUpd:'2026-11-02T00:00:00.000',FTTimeUpd:'09:00:00'}];
 const a=snapshot({branch:'000',customers:master('0')}),b=snapshot({customers:master('200')});const r=m.compareDatabases([a,b]);assert.equal(r.homes.verifiedSourceCodes,1);assert.equal(r.homes.verified[0].homeBranch,'001');assert.equal(r.openings.conflictingCodes,1);assert.equal(r.globalOpeningSelected,false);assert.equal(r.openings.conflicts[0].variants[1].lastPointDate,'2020-01-01T00:00:00.000');
});
test('blank, contradictory or unavailable native home sources are counted without inference',()=>{
 const a=snapshot({branch:'000',customers:[{FTCstCode:'AR001-000001',FCCstRetPoint:'0',FTBchCode:'002'},{FTCstCode:'X',FCCstRetPoint:'0',FTBchCode:''},{FTCstCode:'Y',FCCstRetPoint:'0',FTBchCode:'001'}]});
 const b=snapshot({branch:'003',customers:[{FTCstCode:'Y',FCCstRetPoint:'0',FTBchCode:'003'}]});const r=m.compareHomes([a,b]);assert.equal(r.sourceUnavailableCodes,1);assert.equal(r.unavailable[0].homeBranch,'002');assert.equal(r.blankCodes,1);assert.equal(r.conflictingCodes,1);assert.equal(r.verifiedSourceCodes,0);
});
test('a changed second source pass holds even a mathematically matching captured view',()=>{
 const s=snapshot();s.sourceConsistency={stable:false};const r=m.calculateDatabase(s);assert.equal(r.balances[0].viewMatches,true);assert.equal(r.balances[0].state,'review');assert.equal(r.snapshotVerified,false);assert.ok(r.issues.some(i=>i.code==='POINT_SOURCE_CHANGED_DURING_CAPTURE'));
});
