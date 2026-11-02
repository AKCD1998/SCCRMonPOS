'use strict';
// A native-only, copy-testable projection. Does not write either database,
// sum copied opening balances, merge member aliases, or read SCCRM earnings.
const {calculateDatabase,mergeReplicas,integer,add,hash}=require('./model.cjs');
const {deriveIntrinsicSnapshots}=require('./compensation.cjs');
const BRANCHES=Object.freeze(['000','001','003','004','005']);
const fail=code=>{throw Object.assign(Error(code),{code});};
function projectNativePoints(snapshots,{openingSourceByCode={},allowNativeHomeBranch=false,ownerMap=[]}={}){
 if(!Array.isArray(snapshots)||snapshots.length!==BRANCHES.length||
   snapshots.map(s=>s.branch).sort().join(',')!==BRANCHES.join(','))fail('POINT_ALL_REVIEWED_SOURCES_REQUIRED');
 if(typeof allowNativeHomeBranch!=='boolean'||!openingSourceByCode||typeof openingSourceByCode!=='object'||Array.isArray(openingSourceByCode))fail('POINT_OPENING_POLICY_INVALID');
 if(!Array.isArray(ownerMap)||ownerMap.length>100000)fail('POINT_OWNER_MAP_INVALID');
 const owners=new Map(),primaryByMember=new Map();
 for(const row of ownerMap){
  if(!row||typeof row.member_id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.member_id)||
    typeof row.ada_code!=='string'||!row.ada_code||row.ada_code.length>20||typeof row.canonical_code!=='string'||row.canonical_code.length>50)fail('POINT_OWNER_MAP_INVALID');
  const memberId=row.member_id.toLowerCase();
  if(owners.has(row.ada_code)||primaryByMember.has(memberId)&&primaryByMember.get(memberId)!==row.canonical_code)fail('POINT_OWNER_MAP_CONFLICT');
  owners.set(row.ada_code,memberId);primaryByMember.set(memberId,row.canonical_code);
 }
 const sourceHashes=new Set(snapshots.map(s=>s.schemaHash));
 if(sourceHashes.size!==1||[...sourceHashes].some(x=>typeof x!=='string'||!/^[a-f0-9]{64}$/.test(x)))fail('POINT_SOURCE_SCHEMA_MISMATCH');
 const asOfTimes=snapshots.map(s=>Date.parse(s.captureCompletedAt));
 if(asOfTimes.some(t=>!Number.isFinite(t)))fail('POINT_SOURCE_TIME_INVALID');
 const observedAt=new Date(Math.min(...asOfTimes)).toISOString();
 snapshots=deriveIntrinsicSnapshots(snapshots);
 const databases=snapshots.map(calculateDatabase),replicas=mergeReplicas(snapshots),codes=new Map();
 const blocked=new Map(),block=(code,reason)=>{const r=blocked.get(code)||new Set();r.add(reason);blocked.set(code,r);};
 for(let i=0;i<snapshots.length;i++){
  const s=snapshots[i],db=databases[i],byCode=new Map(db.balances.map(r=>[r.adaCode,r]));
  for(const c of s.customers){
   if(typeof c.FTCstCode!=='string'||!c.FTCstCode||c.FTCstCode.length>20)fail('POINT_CUSTOMER_IDENTITY_INVALID');
   const record=byCode.get(c.FTCstCode),variants=codes.get(c.FTCstCode)||[];
   if(!record||record.state!=='verified'||!record.viewMatches)block(c.FTCstCode,'NATIVE_VIEW_NOT_VERIFIED');
   variants.push({branch:s.branch,homeBranch:c.FTBchCode??null,openingPoints:record?.openingPoints??null});
   codes.set(c.FTCstCode,variants);
  }
  for(const issue of db.issues)if(issue.adaCode)block(issue.adaCode,issue.code);
 }
 // The exact business event owner is part of its identity. Conflicting owners
 // or versions are held; neither arrival order nor phone numbers resolve them.
 for(const conflict of replicas.conflicts)for(const v of conflict.variants)block(v.adaCode,conflict.code);
 if(replicas.invalid.length)fail('POINT_INVALID_SOURCE_EVENT');
 const contributions=new Map(),eventHashes=new Map();
 for(const event of replicas.events){
  if(event.unknownNonzero)block(event.adaCode,'UNKNOWN_NONZERO_NATIVE_TYPE');
  try{contributions.set(event.adaCode,add(contributions.get(event.adaCode)||0n,integer(event.contribution)));}
  catch{block(event.adaCode,'GLOBAL_POINT_OVERFLOW');}
  const values=eventHashes.get(event.adaCode)||[];values.push(event.businessHash);eventHashes.set(event.adaCode,values);
 }
 const balances=[];
 for(const [adaCode,variants]of [...codes].sort(([a],[b])=>a<b?-1:a>b?1:0)){
  let opening,openingSource,openingRule;
  const values=[...new Set(variants.map(v=>v.openingPoints))];
  if(values.length===1&&values[0]!==null){opening=values[0];openingRule='identical_native_openings';openingSource=variants.map(v=>v.branch).sort();}
  else if(Object.hasOwn(openingSourceByCode,adaCode)){
   const branch=openingSourceByCode[adaCode],v=variants.find(v=>v.branch===branch);
   if(!BRANCHES.includes(branch)||!v||v.openingPoints===null)block(adaCode,'APPROVED_OPENING_SOURCE_UNAVAILABLE');
   else{opening=v.openingPoints;openingSource=[branch];openingRule='explicit_source_selection';}
  }else if(allowNativeHomeBranch){
   const homes=[...new Set(variants.map(v=>v.homeBranch))];
   const v=homes.length===1&&BRANCHES.includes(homes[0])?variants.find(v=>v.branch===homes[0]):null;
   if(!v||v.openingPoints===null)block(adaCode,'NATIVE_HOME_OPENING_UNAVAILABLE');
   else{opening=v.openingPoints;openingSource=[v.branch];openingRule='approved_native_home_branch';}
  }else block(adaCode,'OPENING_BALANCE_CONFLICT');
  let balance;
  try{if(opening!==undefined)balance=add(integer(opening),contributions.get(adaCode)||0n).toString();}
  catch{block(adaCode,'GLOBAL_POINT_OVERFLOW');}
  const reasons=[...(blocked.get(adaCode)||[])].sort();
  const state=reasons.length?'review':'ready';
  const content={adaCode,openingPoints:opening??null,openingRule:openingRule??null,openingSource:openingSource??[],
   transactionPoints:(contributions.get(adaCode)||0n).toString(),balanceExact:state==='ready'?balance:null,
   events:(eventHashes.get(adaCode)||[]).sort(),reasons};
  balances.push({...content,state,observedAt,version:hash(content)});
 }
 // An approved family is an explicit native-code mapping, never a name/phone
 // match. Union source events, not database balances. Ambiguous carried points
 // across two former aliases remain held even when the people were merged.
 const families=new Map();
 for(const b of balances){const owner=owners.get(b.adaCode);if(owner){const list=families.get(owner)||[];list.push(b);families.set(owner,list);}}
 let approvedFamilies=0;
 for(const [memberId,family]of families){
  const raw=primaryByMember.get(memberId),canonical=raw.startsWith('ADA-')?raw.slice(4):raw;
  const reasons=new Set(family.flatMap(b=>b.reasons));
  if(!family.some(b=>b.adaCode===canonical))reasons.add('CANONICAL_ADA_SOURCE_MISSING');
  const nonzero=family.filter(b=>b.openingPoints!==null&&b.openingPoints!=='0');
  if(nonzero.length>1)reasons.add('MULTIPLE_ALIAS_OPENINGS_REQUIRE_REVIEW');
  let total=0n,opening=0n,transactions=0n;
  try{for(const b of family){if(b.openingPoints===null)reasons.add('ALIAS_OPENING_UNAVAILABLE');else opening=add(opening,integer(b.openingPoints));transactions=add(transactions,integer(b.transactionPoints));}total=add(opening,transactions);}
  catch{reasons.add('GLOBAL_POINT_OVERFLOW');}
  const memberEvents=family.flatMap(b=>b.events).sort(),sortedReasons=[...reasons].sort();
  const familyRevision=hash({memberId,canonical,codes:family.map(b=>b.adaCode).sort(),opening:opening.toString(),transactions:transactions.toString(),events:memberEvents,reasons:sortedReasons});
  for(const b of family){
   b.nativeCodeOpeningPoints=b.openingPoints;b.nativeCodeTransactionPoints=b.transactionPoints;
   b.openingPoints=opening.toString();b.transactionPoints=transactions.toString();b.events=memberEvents;
   b.balanceExact=reasons.size?null:total.toString();b.state=reasons.size?'review':'ready';b.reasons=sortedReasons;
   b.approvedMemberId=memberId;b.canonicalCode=canonical;b.familyRevision=familyRevision;
   b.version=hash({adaCode:b.adaCode,familyRevision});
  }
  if(family.length>1)approvedFamilies++;
 }
 return {scope:'SCCRM-ADA-POINTS-PROJECTION-20261102',observedAt,balances,
  ready:balances.filter(b=>b.state==='ready').length,review:balances.filter(b=>b.state==='review').length,
  nativeEvents:replicas.canonicalEvents,duplicateReplicas:replicas.duplicateReplicas,
  orphanEvents:replicas.events.filter(e=>!codes.has(e.adaCode)).map(e=>({key:e.key,adaCode:e.adaCode})),
  // This statement describes this pure function, not any future deployment.
  sccrmLedgerIncluded:false,aliasesMerged:false,approvedFamilies,productionWrites:0,pinRead:false};
}
module.exports={BRANCHES,projectNativePoints};
