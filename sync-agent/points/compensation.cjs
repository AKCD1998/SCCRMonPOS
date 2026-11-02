'use strict';
// Only a receiver receipt plus its unchanged native row proves ownership. The
// insertion-user text alone is never authority to remove a native transaction.
const m=require('./model.cjs');
const MARKER='238ecf14-fda8-46a8-bc34-d663659b2202';
const WHO='SCCRM_POINT_SYNC_V1',SAFE=9007199254740991n;
const fail=code=>{throw Object.assign(Error(code),{code});};
const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
const digest=x=>m.hash(canonical(x));
function databaseIdentity(s){
 const native=m.databaseId(s),copy=s.mode==='Copy'&&s.identity.db===`SCCRM_PointCopy_20261102_${s.branch}`;
 const identity=copy?`copy${s.branch}/${s.identity.machine}/${s.identity.db}`:native;
 if(s.databaseIdentity!==undefined&&s.databaseIdentity!==identity)fail('POINT_OWNED_DATABASE_IDENTITY_REFUSED');
 return identity;
}
function exactInteger(value,{positive=false}={}){
 let n;try{n=m.integer(value);}catch{fail('POINT_OWNED_NUMERIC_REFUSED');}
 if(n< -SAFE||n>SAFE||positive&&n<=0n)fail('POINT_OWNED_NUMERIC_REFUSED');return n;
}
function exactKeys(value,keys){return value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===keys.slice().sort().join(',');}
const META=['singleton','marker','target_identity','branch_code'];
const RECEIPT=['operation_id','ada_code','branch_code','ref_doc','revision','generation','expected_intrinsic','previous_balance','target_balance','delta_points','created_at'];
function validateOwnedCompensation(snapshot){
 const identity=databaseIdentity(snapshot),proof=snapshot.ownedCompensation;
 if(proof===undefined)return {present:false,identity,receipts:[],ownedTotals:new Map(),ownedKeys:new Set(),proofHash:digest({present:false})};
 if(!exactKeys(proof,['present','meta','receipts'])||typeof proof.present!=='boolean'||!Array.isArray(proof.meta)||!Array.isArray(proof.receipts)||proof.receipts.length>100000)fail('POINT_OWNED_PROOF_FIELDS_REFUSED');
 if(!proof.present){if(proof.meta.length||proof.receipts.length)fail('POINT_OWNED_ABSENT_PROOF_REFUSED');return {present:false,identity,receipts:[],ownedTotals:new Map(),ownedKeys:new Set(),proofHash:digest(proof)};}
 if(proof.meta.length!==1||!exactKeys(proof.meta[0],META))fail('POINT_OWNED_META_REFUSED');
 const meta=proof.meta[0];
 if(meta.singleton!==1||meta.marker!==MARKER||meta.target_identity!==identity||meta.branch_code!==snapshot.branch)fail('POINT_OWNED_META_REFUSED');
 if(!proof.receipts.length)return {present:true,identity,receipts:[],ownedTotals:new Map(),ownedKeys:new Set(),proofHash:digest(proof)};
 const raw=m.calculateDatabase(snapshot),nativeByCode=new Map(raw.balances.map(b=>[b.adaCode,b]));
 const byKey=new Map();
 for(const point of snapshot.points){const key=m.keyFor(point),rows=byKey.get(key)||[];rows.push(point);byKey.set(key,rows);}
 const operations=new Set(),documents=new Set(),generations=new Set(),ownedKeys=new Set(),ownedTotals=new Map();
 for(const receipt of proof.receipts){
  if(!exactKeys(receipt,RECEIPT)||typeof receipt.operation_id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(receipt.operation_id)||typeof receipt.ada_code!=='string'||!receipt.ada_code||receipt.ada_code.length>20||receipt.branch_code!==snapshot.branch||typeof receipt.revision!=='string'||!/^[a-f0-9]{64}$/.test(receipt.revision)||typeof receipt.created_at!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}$/.test(receipt.created_at))fail('POINT_OWNED_RECEIPT_REFUSED');
  // SQL Server's GUID-to-varchar conversion can uppercase hexadecimal digits;
  // the native row still must match the receipt's exact stored document value.
  const expectedDoc=('SP'+receipt.operation_id.replaceAll('-','').slice(0,28)).toUpperCase();
  if(typeof receipt.ref_doc!=='string'||receipt.ref_doc.toUpperCase()!==expectedDoc||operations.has(receipt.operation_id)||documents.has(expectedDoc))fail('POINT_OWNED_RECEIPT_IDENTITY_REFUSED');
  operations.add(receipt.operation_id);documents.add(expectedDoc);
  const delta=exactInteger(receipt.delta_points),previous=exactInteger(receipt.previous_balance),target=exactInteger(receipt.target_balance),generation=exactInteger(receipt.generation,{positive:true});exactInteger(receipt.expected_intrinsic);
  const generationKey=receipt.ada_code+'/'+generation;
  if(target-previous!==delta||generations.has(generationKey))fail('POINT_OWNED_RECEIPT_ARITHMETIC_REFUSED');generations.add(generationKey);
  const native=nativeByCode.get(receipt.ada_code);
  if(!native||!native.viewMatches||native.state!=='verified')fail('POINT_OWNED_NATIVE_VIEW_NOT_VERIFIED');
  const key=JSON.stringify([receipt.branch_code,receipt.ada_code,receipt.ref_doc,'']),rows=byKey.get(key)||[];
  if(delta===0n){if(rows.length)fail('POINT_OWNED_ZERO_ROW_REFUSED');}
  else{
   if(rows.length!==1)fail('POINT_OWNED_ROW_MISSING_OR_DUPLICATE');
   const p=rows[0];
   if(p.FTPntExpired!=='N'||p.FTPntStaPrcDoc!=='N'||p.FTPntCardType!==(delta>0n?'1':'2')||p.FTWhoIns!==WHO||p.FNPntPoint===null||p.FCPntPointbyOne===null||p.FCPntAmtRcv===null||p.FNPntPointOld===null||exactInteger(p.FNPntPoint)!==(delta<0n?-delta:delta)||m.decimal(p.FCPntPointbyOne)!=='0'||m.decimal(p.FCPntAmtRcv)!=='0'||exactInteger(p.FNPntPointOld)!==previous)fail('POINT_OWNED_ROW_CHANGED');
   ownedKeys.add(key);
  }
  ownedTotals.set(receipt.ada_code,m.add(ownedTotals.get(receipt.ada_code)||0n,delta));
 }
 return {present:true,identity,receipts:proof.receipts,ownedTotals,ownedKeys,proofHash:digest(proof)};
}
function deriveWithProof(snapshot,proof,ownedKeys=proof.ownedKeys,ownedTotals=proof.ownedTotals,originProofHashes=[]){
 if(!ownedKeys.size&&!ownedTotals.size)return {...snapshot,intrinsicProof:{verified:true,present:proof.present,proofHash:proof.proofHash,excludedRows:0,ownedTotals:[]}};
 const raw=m.calculateDatabase(snapshot);
 for(const code of ownedTotals.keys()){const native=raw.balances.find(b=>b.adaCode===code);if(!native||native.state!=='verified'||!native.viewMatches)fail('POINT_OWNED_NATIVE_VIEW_NOT_VERIFIED');}
 const points=snapshot.points.filter(p=>!ownedKeys.has(m.keyFor(p)));
 const balances=snapshot.balances.map(row=>ownedTotals.has(row.FTCstCode)?{...row,FNPntPoint:m.add(m.integer(row.FNPntPoint),-ownedTotals.get(row.FTCstCode)).toString()}:row);
 const intrinsicProof={verified:true,present:proof.present,proofHash:proof.proofHash,...(originProofHashes.length?{originProofHashes}:{}),excludedRows:ownedKeys.size,ownedTotals:[...ownedTotals].sort(([a],[b])=>a.localeCompare(b)).map(([adaCode,delta])=>({adaCode,delta:delta.toString()}))};
 const derived={...snapshot,points,balances,intrinsicProof};
 const verification=m.calculateDatabase(derived);
 for(const code of ownedTotals.keys())if(verification.balances.find(b=>b.adaCode===code)?.state!=='verified')fail('POINT_OWNED_INTRINSIC_VIEW_NOT_VERIFIED');
 return derived;
}
function deriveIntrinsicSnapshot(snapshot){return deriveWithProof(snapshot,validateOwnedCompensation(snapshot));}
function deriveIntrinsicSnapshots(snapshots){
 if(!Array.isArray(snapshots))fail('POINT_OWNED_SNAPSHOTS_REQUIRED');
 const proofs=snapshots.map(validateOwnedCompensation),proven=new Map();
 for(let i=0;i<snapshots.length;i++)for(const p of snapshots[i].points){const key=m.keyFor(p);if(!proofs[i].ownedKeys.has(key))continue;
  const event=m.canonicalEvent(p,m.databaseId(snapshots[i])),old=proven.get(key);
  if(old&&old.businessHash!==event.businessHash)fail('POINT_OWNED_ORIGIN_PROOF_CONFLICT');
  proven.set(key,{businessHash:event.businessHash,contribution:event.contribution,adaCode:event.adaCode,proofHash:proofs[i].proofHash});
 }
 return snapshots.map((snapshot,i)=>{
  const proof=proofs[i],ownedKeys=new Set(),totals=new Map([...proof.ownedTotals.keys()].map(code=>[code,0n])),usedProofs=new Set();
  for(const p of snapshot.points){const key=m.keyFor(p),origin=proven.get(key);if(!origin)continue;
   const event=m.canonicalEvent(p,m.databaseId(snapshot));
   if(ownedKeys.has(key)||p.FTWhoIns!==WHO||event.businessHash!==origin.businessHash)fail('POINT_OWNED_REPLICA_CHANGED');
   ownedKeys.add(key);totals.set(event.adaCode,m.add(totals.get(event.adaCode)||0n,m.integer(origin.contribution)));usedProofs.add(origin.proofHash);
  }
  return deriveWithProof(snapshot,proof,ownedKeys,totals,[...usedProofs].sort());
 });
}
module.exports={MARKER,WHO,databaseIdentity,validateOwnedCompensation,deriveIntrinsicSnapshot,deriveIntrinsicSnapshots};
