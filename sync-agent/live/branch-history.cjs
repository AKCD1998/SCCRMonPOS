'use strict';
const crypto=require('node:crypto');
const {verifiedRecords}=require('./branch-receipts.cjs');
const {failureCode}=require('./health.cjs');
const {record}=require('../history/model.cjs');
const serialize=r=>({source_key:r.key,owner_code:r.owner,parent_key:r.parent,payload_hash:r.payloadHash,payload:r.payload});
// Independent native readers share one destination connection through this
// queue. No source/network I/O is allowed inside a destination queue callback.
function serialDestination(){let tail=Promise.resolve();return operation=>{const next=tail.then(operation);tail=next.catch(()=>{});return next;};}
class BranchHistory {
 constructor(pg,{sourceFactory,guard,marker,scope,hqProfileReader=async()=>[],onStatus=()=>{},clock=Date.now,fullPollMs=300000}){
  Object.assign(this,{pg,sourceFactory,guard,marker,scope,hqProfileReader,onStatus,clock,fullPollMs});
  this.serial=serialDestination();this.sources=new Map();this.fullAttempts=new Map();this.lastFull=new Map();this.fullErrors=new Map();
 }
 async publish(branch,value){this.onStatus(branch,{...value,at:new Date(this.clock()).toISOString()});}
 source(branch){let source=this.sources.get(branch);if(!source||source.closed){source=this.sourceFactory(branch);this.sources.set(branch,source);}return source;}
 async profiles(records){
  const codes=[...new Set(records.headers.map(h=>h.owner))];if(!codes.length)return [];
  const known=await this.serial(async()=>new Set((await this.pg.query("SELECT ada_code FROM ada_history.customer_profiles WHERE source_id='hq000/AdaAcc' AND profile_origin='hq' AND ada_code=ANY($1::text[])",[codes])).rows.map(r=>r.ada_code)));
  const needed=codes.filter(code=>!known.has(code));if(!needed.length)return [];
  const errors=[];let hq=[];try{hq=await this.hqProfileReader(needed);}catch(error){errors.push({branch:'000',code:failureCode(error)});}
  if(hq.length>needed.length||hq.some(c=>!needed.includes(c.FTCstCode))||new Set(hq.map(c=>c.FTCstCode)).size!==hq.length)throw Error('BRANCH_HQ_PROFILE_SCOPE_REFUSED');
  const result=hq.map(c=>({origin:'hq',record:record('customers',c)})),remaining=needed.filter(code=>!hq.some(c=>c.FTCstCode===code));result.errors=errors;
  for(const home of ['001','003','004','005']){
   const localCodes=remaining.filter(code=>new RegExp('^AR'+home+'-[0-9]{6}$').test(code));if(!localCodes.length)continue;
   const source=this.source(home);let customers;
   try{customers=await source.query('profiles',{codes:localCodes});}catch(error){
    errors.push({branch:home,code:failureCode(error)});
    if(source.closed||/SOURCE_TIMEOUT|SOURCE_PROCESS_ENDED/.test(error.message)){source.close();if(this.sources.get(home)===source)this.sources.delete(home);}
    continue;
   }
   if(customers.length>localCodes.length||customers.some(c=>!localCodes.includes(c.FTCstCode)||c.FTBchCode!==home)||new Set(customers.map(c=>c.FTCstCode)).size!==customers.length)throw Error('BRANCH_LOCAL_PROFILE_SCOPE_REFUSED');
   for(const c of customers)result.push({origin:'branch',branch:home,record:record('customers',c),header:records.headers.find(h=>h.owner===c.FTCstCode).payload});
  }
  return result;
 }
 async save(records,profiles=[]){return this.serial(async()=>{
  const {sourceId,headers,lines}=records;if(!headers.length)return {written:0,missingCustomers:[],removedItems:0};
  const keys=headers.map(h=>h.key);
  const cachedHeaders=new Map((await this.pg.query('SELECT receipt_key,payload_hash FROM ada_history.receipts WHERE source_id=$1 AND receipt_key=ANY($2::bpchar[])',[sourceId,keys])).rows.map(r=>[r.receipt_key.trim(),r.payload_hash]));
  const cachedLines=(await this.pg.query('SELECT line_key,receipt_key,payload_hash FROM ada_history.lines WHERE source_id=$1 AND receipt_key=ANY($2::bpchar[])',[sourceId,keys])).rows;
  const changed=[],removed=[];
  for(const h of headers){
   const sourceLines=lines.filter(l=>l.parent===h.key),stored=cachedLines.filter(l=>l.receipt_key.trim()===h.key),lineKeys=new Set(sourceLines.map(l=>l.key));
   if(stored.some(l=>!lineKeys.has(l.line_key.trim()))){removed.push(h.key);continue;}
   if(cachedHeaders.get(h.key)!==h.payloadHash||stored.length!==sourceLines.length||sourceLines.some(l=>!stored.some(c=>c.line_key.trim()===l.key&&c.payload_hash===l.payloadHash)))changed.push(h);
  }
  let written=0;
  const hq=profiles.filter(p=>p.origin==='hq');
  if(hq.length)written+=Number((await this.pg.query('SELECT ada_history.apply_batch($1,$2,$3,$4::jsonb,$5,$6) n',[this.marker,this.scope,'customers',JSON.stringify(hq.map(p=>serialize(p.record))),crypto.randomUUID(),'branch-owner-profile'])).rows[0].n);
  if(changed.length){
   const changedKeys=new Set(changed.map(h=>h.key)),items=lines.filter(l=>changedKeys.has(l.parent));
   written+=Number((await this.pg.query('SELECT ada_history.apply_branch_receipt_packet($1,$2,$3,$4::jsonb,$5::jsonb,$6) n',[sourceId,this.marker,this.scope,JSON.stringify(changed.map(serialize)),JSON.stringify(items.map(serialize)),crypto.randomUUID()])).rows[0].n);
  }
  for(const p of profiles.filter(p=>p.origin==='branch'))written+=Number((await this.pg.query('SELECT ada_history.apply_branch_customer_profile($1,$2,$3,$4::jsonb,$5,$6,$7::jsonb) n',[this.marker,this.scope,p.branch,JSON.stringify(p.record.payload),p.record.payloadHash,crypto.randomUUID(),JSON.stringify(p.header)])).rows[0].n);
  const codes=[...new Set(headers.map(h=>h.owner))];
  const present=new Set((await this.pg.query("SELECT ada_code FROM ada_history.customer_profiles WHERE source_id='hq000/AdaAcc' AND ada_code=ANY($1::text[])",[codes])).rows.map(r=>r.ada_code));
  return {written,missingCustomers:codes.filter(code=>!present.has(code)),removedItems:removed.length};
 });}
 async cycle(branch){
  const start=this.clock(),previousAttempt=this.fullAttempts.get(branch),full=previousAttempt===undefined||start-previousAttempt>=this.fullPollMs;
  if(full)this.fullAttempts.set(branch,start);
  let source=this.sources.get(branch),receiptCount=0,lineCount=0,written=0,pendingCount=0;
  const missing=new Set(),profileErrors=[];
  try{
   source=this.source(branch);
   await this.serial(()=>this.guard(this.pg));
   const window=await source.query('historyWindow',{full}),floor=window[0]?.floor;
   if(!/^\d{4}-\d{2}-\d{2}T00:00:00(?:\.000)?$/.test(floor||''))throw Error('BRANCH_WINDOW_REFUSED');
   let afterDate=floor,afterDoc='';
   await this.publish(branch,{state:'importing',full});
   for(;;){
    const rows=await source.query('recentReceipts',{floor,afterDate,afterDoc});if(!rows.length)break;
    if(rows.length>50)throw Error('BRANCH_PAGE_SCOPE_REFUSED');
    const last=rows.at(-1);
    if(last.FDShdDocDate<afterDate||(last.FDShdDocDate===afterDate&&last.FTShdDocNo<=afterDoc))throw Error('BRANCH_CURSOR_NOT_ADVANCING');
    const packet=await source.query('snapshot',{docs:rows.map(h=>h.FTShdDocNo)});
    if(packet.branch!==branch)throw Error('BRANCH_RECEIPTS_ACK_REFUSED');
    const records=verifiedRecords(packet,rows.map(h=>({doc:h.FTShdDocNo})));
    const profiles=await this.profiles(records);
    profileErrors.push(...(profiles.errors||[]));
    const result=await this.save(records,profiles);written+=result.written;pendingCount+=records.pending.length+result.removedItems;
    for(const code of result.missingCustomers)missing.add(code);
    receiptCount+=records.headers.length;lineCount+=records.lines.length;
    afterDate=last.FDShdDocDate;afterDoc=last.FTShdDocNo;
    await this.publish(branch,{state:'importing',full,receiptCount,lineCount,pendingCount,missingCustomerCount:missing.size});
   }
   if(full){if(!pendingCount&&!missing.size){this.lastFull.set(branch,new Date(this.clock()).toISOString());this.fullErrors.delete(branch);}else this.fullErrors.set(branch,'BRANCH_SOURCE_INCOMPLETE');}
   const incomplete=pendingCount||missing.size||this.fullErrors.has(branch);
   const result={state:incomplete?'retrying':'healthy',...(incomplete?{code:this.fullErrors.get(branch)||'BRANCH_SOURCE_INCOMPLETE'}:{}),receiptCount,lineCount,written,pendingCount,missingCustomerCount:missing.size,profileErrors,fullPending:this.fullErrors.has(branch),durationMs:this.clock()-start,lastFullAt:this.lastFull.get(branch)||null};
   await this.publish(branch,result);return result;
  }catch(error){
   if(full)this.fullErrors.set(branch,failureCode(error));
   await this.publish(branch,{state:'retrying',code:failureCode(error),receiptCount,lineCount,written,durationMs:this.clock()-start,lastFullAt:this.lastFull.get(branch)||null});
   if(source?.closed||/SOURCE_TIMEOUT|SOURCE_PROCESS_ENDED/.test(error.message)){source?.close();if(this.sources.get(branch)===source)this.sources.delete(branch);}
   if(/Connection terminated|connection closed|querying client has encountered/i.test(error.message))throw error;
   return {state:'retrying',code:failureCode(error)};
  }
 }
 close(){for(const source of this.sources.values())source.close();this.sources.clear();}
}
module.exports={BranchHistory,serialDestination};
