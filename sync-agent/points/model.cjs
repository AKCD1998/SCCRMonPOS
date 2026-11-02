'use strict';
// Pure source model. It never picks a global opening balance or merges aliases.
const crypto=require('node:crypto');
const MIN=-9223372036854775808n,MAX=9223372036854775807n;
const POINT_FIELDS=Object.freeze(['FTBchCode','FTCstCode','FTPntRefDoc','FTSplCode','FDPntDate','FCPntPointbyOne','FCPntAmtRcv','FNPntPoint','FNPntPointOld','FTPntExpired','FTPntStaPrcDoc','FTPntCardType','FTCptJDate','FTCptTime','FDPntSplStart','FDPntSplExpired','FTPntStaExpired','FDDateUpd','FTTimeUpd','FTWhoUpd','FDDateIns','FTTimeIns','FTWhoIns']);
const PROVENANCE=new Set(['FDDateUpd','FTTimeUpd','FTWhoUpd','FDDateIns','FTTimeIns','FTWhoIns']);
const BUSINESS_FIELDS=Object.freeze(POINT_FIELDS.filter(k=>!PROVENANCE.has(k)));
const NUMERIC=new Set(['FCPntPointbyOne','FCPntAmtRcv','FNPntPoint','FNPntPointOld']);
const DATES=new Set(['FDPntDate','FDPntSplStart','FDPntSplExpired']);
class ModelError extends Error{constructor(code){super(code);this.code=code;}}
const fail=c=>{throw new ModelError(c);};
const hash=x=>crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
function decimal(value){
 if(value===null||value===undefined)fail('POINT_NULL');
 if(typeof value==='number'){if(!Number.isFinite(value))fail('POINT_NOT_FINITE');if(Number.isInteger(value)&&!Number.isSafeInteger(value))fail('POINT_UNSAFE_NUMBER');value=String(value);}
 if(typeof value!=='string'||value.length>128)fail('POINT_NUMERIC_FORMAT');
 const m=/^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(value);
 if(!m)fail('POINT_NUMERIC_FORMAT');
 const exponent=Number(m[4]||0);if(!Number.isSafeInteger(exponent)||Math.abs(exponent)>128)fail('POINT_OVERFLOW');
 let digits=m[2]+(m[3]||''),position=m[2].length+exponent;
 if(position<0){digits='0'.repeat(-position)+digits;position=0;}
 if(position>digits.length)digits+='0'.repeat(position-digits.length);
 let whole=digits.slice(0,position)||'0',fraction=digits.slice(position);
 whole=whole.replace(/^0+(?=\d)/,'');fraction=fraction.replace(/0+$/,'');
 const negative=m[1]==='-'&&(whole!=='0'||fraction!=='');
 return (negative?'-':'')+whole+(fraction?'.'+fraction:'');
}
function integer(value){const d=decimal(value);if(d.includes('.'))fail('POINT_NOT_INTEGER');const n=BigInt(d);if(n<MIN||n>MAX)fail('POINT_OVERFLOW');return n;}
function add(a,b){const n=a+b;if(n<MIN||n>MAX)fail('POINT_OVERFLOW');return n;}
function field(value,max,{blank=false}={}){if(typeof value!=='string'||value.length>max||!blank&&!value.length||/[\u0000-\u001f]/.test(value))fail('POINT_IDENTITY_FORMAT');return value;}
function databaseId(s){return [s.branch,s.identity?.machine,s.identity?.db].map(v=>field(v,128)).join('/');}
function keyFor(row){return JSON.stringify([field(row.FTBchCode,6),field(row.FTCstCode,20),field(row.FTPntRefDoc,30,{blank:true}),field(row.FTSplCode,20,{blank:true})]);}
function canonicalEvent(row,sourceDatabase){
 if(!row||typeof row!=='object'||Array.isArray(row)||Object.keys(row).length!==POINT_FIELDS.length||POINT_FIELDS.some(k=>!Object.hasOwn(row,k)))fail('POINT_EVENT_FIELDS_REFUSED');
 const key=keyFor(row),amount=integer(row.FNPntPoint),payload={};
 for(const k of BUSINESS_FIELDS){
  let v=row[k];
  if(NUMERIC.has(k))v=v==null?null:decimal(v);
  else if(DATES.has(k)&&v!==null&&!(typeof v==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}$/.test(v)))fail('POINT_CALENDAR_FORMAT');
  else if(v!==null&&typeof v!=='string')fail('POINT_EVENT_VALUE_REFUSED');
  payload[k]=v;
 }
 const active=row.FTPntExpired==='N'&&row.FTPntStaPrcDoc==='N';
 const type=row.FTPntCardType,known=type==='1'||type==='2';
 const contribution=!active||!known?0n:type==='1'?amount:-amount;
 if(contribution<MIN||contribution>MAX)fail('POINT_OVERFLOW');
 return {key,ownerKey:JSON.stringify([row.FTBchCode,row.FTPntRefDoc,row.FTSplCode]),adaCode:row.FTCstCode,originBranch:row.FTBchCode,sourceDatabase,amount:amount.toString(),cardType:type,active,contribution:contribution.toString(),unknownNonzero:!known&&amount!==0n,businessHash:hash(payload),businessPayload:payload};
}
function issueCode(e){return e instanceof ModelError?e.code:'POINT_MODEL_FAILED';}
function calculateDatabase(snapshot){
 const sourceDatabase=databaseId(snapshot);
 if(!Array.isArray(snapshot.customers)||!Array.isArray(snapshot.points)||!Array.isArray(snapshot.balances))fail('POINT_SNAPSHOT_FIELDS_REFUSED');
 const masters=new Map(),views=new Map(),events=new Map(),issues=[],memberIssues=new Map();
 let replayCount=0;
 const issue=(code,adaCode,key)=>{const entry={code,...(adaCode?{adaCode}:{}),...(key?{key}:{})};issues.push(entry);if(adaCode){const list=memberIssues.get(adaCode)||[];list.push(code);memberIssues.set(adaCode,list);}};
 for(const row of snapshot.customers){try{
  const code=field(row.FTCstCode,20);
  if(masters.has(code)){issue('POINT_CUSTOMER_DUPLICATE',code);continue;}
  let opening;try{opening=integer(row.FCCstRetPoint);}catch(e){issue(issueCode(e),code);}
  masters.set(code,{row,opening});
 }catch(e){issue(issueCode(e));}}
 if(snapshot.sourceConsistency?.stable===false){issue('POINT_SOURCE_CHANGED_DURING_CAPTURE');for(const code of masters.keys())issue('POINT_SOURCE_CHANGED_DURING_CAPTURE',code);}
 for(const row of snapshot.balances){try{
  const code=field(row.FTCstCode,20);
  if(views.has(code)){issue('POINT_VIEW_DUPLICATE',code);continue;}
  let value;try{value=integer(row.FNPntPoint);}catch(e){issue(issueCode(e),code);}
  views.set(code,value);
  if(!masters.has(code))issue('POINT_VIEW_CUSTOMER_MISSING',code);
 }catch(e){issue(issueCode(e));}}
 for(const row of snapshot.points){let code,key;try{
  code=field(row.FTCstCode,20);key=keyFor(row);const event=canonicalEvent(row,sourceDatabase);
  if(!masters.has(code))issue('POINT_EVENT_CUSTOMER_MISSING',code,key);
  if(event.unknownNonzero)issue('POINT_UNKNOWN_NONZERO_TYPE',code,key);
  if(events.has(key)){
   const old=events.get(key);
   if(old&&old.businessHash===event.businessHash){replayCount++;continue;}
   issue('POINT_EVENT_IDENTITY_CONFLICT',code,key);events.set(key,null);continue;
  }
  events.set(key,event);
 }catch(e){issue(issueCode(e),code,key);}}
 const totals=new Map();
 for(const event of events.values())if(event){try{totals.set(event.adaCode,add(totals.get(event.adaCode)||0n,BigInt(event.contribution)));}catch(e){issue(issueCode(e),event.adaCode,event.key);}}
 const balances=[];
 for(const [adaCode,m]of masters){
  let computed;const transactionPoints=totals.get(adaCode)||0n;
  try{if(m.opening!==undefined)computed=add(m.opening,transactionPoints);}catch(e){issue(issueCode(e),adaCode);}
  const hasView=views.has(adaCode),view=views.get(adaCode);
  if(!hasView)issue('POINT_VIEW_MISSING',adaCode);
  if(computed!==undefined&&view!==undefined&&computed!==view)issue('POINT_NATIVE_VIEW_MISMATCH',adaCode);
  balances.push({adaCode,openingPoints:m.opening?.toString()??null,transactionPoints:transactionPoints.toString(),computedPoints:computed?.toString()??null,viewPoints:view?.toString()??null,viewMatches:computed!==undefined&&view!==undefined&&computed===view,state:memberIssues.has(adaCode)?'review':'verified',issues:[...new Set(memberIssues.get(adaCode)||[])]});
 }
 balances.sort((a,b)=>a.adaCode.localeCompare(b.adaCode));
 return {sourceDatabase,branch:snapshot.branch,balances,events:[...events.values()].filter(Boolean),issues,replayCount,verified:balances.filter(b=>b.state==='verified').length,held:balances.filter(b=>b.state==='review').length,heldEvents:issues.filter(i=>i.key).length,viewMismatches:balances.filter(b=>!b.viewMatches).length,snapshotVerified:issues.length===0};
}
function mergeReplicas(snapshots){
 const byKey=new Map(),owners=new Map(),invalid=[];
 for(const snapshot of snapshots){const sourceDatabase=databaseId(snapshot);for(const row of snapshot.points){try{
  const event=canonicalEvent(row,sourceDatabase);const versions=byKey.get(event.key)||new Map();
  const group=versions.get(event.businessHash)||{event,sources:new Set()};group.sources.add(sourceDatabase);versions.set(event.businessHash,group);byKey.set(event.key,versions);
  const owner=owners.get(event.ownerKey)||new Set();owner.add(event.adaCode);owners.set(event.ownerKey,owner);
 }catch(e){invalid.push({sourceDatabase,code:issueCode(e)});}}}
 const events=[],conflicts=[];let duplicateReplicas=0;
 for(const [key,versions]of byKey){const groups=[...versions.values()];const ownerConflict=owners.get(groups[0].event.ownerKey).size>1;
  if(groups.length!==1||ownerConflict){conflicts.push({key,code:ownerConflict?'POINT_REPLICA_OWNER_CONFLICT':'POINT_REPLICA_BUSINESS_CONFLICT',variants:groups.map(g=>({...g.event,sources:[...g.sources].sort()}))});continue;}
  const g=groups[0],sources=[...g.sources].sort();duplicateReplicas+=Math.max(0,sources.length-1);events.push({...g.event,sources});
 }
 return {events,conflicts,invalid,canonicalEvents:events.length,duplicateReplicas,conflictingEvents:conflicts.length};
}
function compareEvents(previous,current){
 const index=s=>new Map(s.points.map(row=>{const e=canonicalEvent(row,databaseId(s));return[e.key,e];}));
 const before=index(previous),after=index(current),added=[],changed=[],removed=[];
 for(const [key,event]of after){const old=before.get(key);if(!old)added.push(event);else if(old.businessHash!==event.businessHash)changed.push({key,before:old,after:event});}
 for(const [key,event]of before)if(!after.has(key))removed.push(event);
 return {added,changed,removed,unchanged:after.size-added.length-changed.length};
}
function compareOpenings(snapshots){
 const codes=new Map(),invalid=[];
 for(const s of snapshots){const sourceDatabase=databaseId(s);for(const r of s.customers){try{
  const code=field(r.FTCstCode,20),opening=integer(r.FCCstRetPoint).toString();const rows=codes.get(code)||[];rows.push({sourceDatabase,branch:s.branch,openingPoints:opening,homeBranch:r.FTBchCode??null,lastPointDate:r.FDCstLastPoint??null,updatedDate:r.FDDateUpd??null,updatedTime:r.FTTimeUpd??null});codes.set(code,rows);
 }catch(e){invalid.push({sourceDatabase,adaCode:r.FTCstCode,code:issueCode(e)});}}}
 const conflicts=[],matching=[],singleDatabase=[];
 for(const [adaCode,rows]of codes){const values=[...new Set(rows.map(r=>r.openingPoints))];const record={adaCode,variants:rows};if(rows.length<2)singleDatabase.push(record);else if(values.length>1)conflicts.push(record);else matching.push({...record,openingPoints:values[0]});}
 return {conflicts,matching,singleDatabase,invalid,codes:codes.size,sharedCodes:conflicts.length+matching.length,conflictingCodes:conflicts.length,matchingCodes:matching.length,matchingNonzeroCodes:matching.filter(r=>r.openingPoints!=='0').length};
}
function compareHomes(snapshots){
 const codes=new Map();
 for(const s of snapshots)for(const r of s.customers){const code=field(r.FTCstCode,20),rows=codes.get(code)||[];rows.push({sourceDatabase:databaseId(s),branch:s.branch,homeBranch:r.FTBchCode??null});codes.set(code,rows);}
 const conflicting=[],blank=[],unavailable=[],verified=[];
 for(const [adaCode,variants]of codes){
  const homes=[...new Set(variants.map(r=>r.homeBranch))];
  if(homes.some(h=>typeof h!=='string'||!h.trim()))blank.push({adaCode,variants});
  const nonblank=homes.filter(h=>typeof h==='string'&&h.trim());
  if(nonblank.length>1){conflicting.push({adaCode,variants});continue;}
  if(nonblank.length===1){const home=nonblank[0],source=variants.find(r=>r.branch===home);if(!source)unavailable.push({adaCode,homeBranch:home,variants});else if(homes.length===1)verified.push({adaCode,homeBranch:home,sourceDatabase:source.sourceDatabase});}
 }
 const homeCounts={};for(const r of verified)homeCounts[r.homeBranch]=(homeCounts[r.homeBranch]||0)+1;
 return {codes:codes.size,conflictingCodes:conflicting.length,blankCodes:blank.length,sourceUnavailableCodes:unavailable.length,verifiedSourceCodes:verified.length,verifiedHomeCounts:homeCounts,conflicting,blank,unavailable,verified};
}
function compareDatabases(snapshots){
 const databases=snapshots.map(calculateDatabase),replicas=mergeReplicas(snapshots),openings=compareOpenings(snapshots),homes=compareHomes(snapshots);
 return {scope:'SCCRM-ADA-POINTS-COMPARISON-20261102',at:new Date().toISOString(),schemaHashes:[...new Set(snapshots.map(s=>s.schemaHash))],sameSchema:new Set(snapshots.map(s=>s.schemaHash)).size===1,databases,replicas,openings,homes,globalOpeningSelected:false,aliasesMerged:false,productionWrites:0,pinRead:false};
}
module.exports={MIN,MAX,POINT_FIELDS,BUSINESS_FIELDS,ModelError,hash,decimal,integer,add,databaseId,keyFor,canonicalEvent,calculateDatabase,mergeReplicas,compareEvents,compareOpenings,compareHomes,compareDatabases};
