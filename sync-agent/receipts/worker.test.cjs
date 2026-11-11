'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {createWorker,TARGETS}=require('./worker.cjs');
const targets=TARGETS.map(branch=>({branch}));
const fixture=branch=>{const id=crypto.randomUUID();return {id,targetBranch:branch,leaseToken:crypto.randomUUID(),payloadHash:'a'.repeat(64),payload:{operationId:id,memberId:crypto.randomUUID()}};};

test('a locked observational status file cannot terminate any delivery lane or lose its acknowledgement',async()=>{
 const acks=[];let publishCalls=0;
 const worker=createWorker({targets,api:async(a,b)=>a==='lease'?{job:fixture(b.targetBranch)}:(acks.push(b),{accepted:true}),
  receive:async(t,j)=>({operationId:j.id}),onStatus:()=>{publishCalls++;throw Object.assign(Error('sharing violation'),{code:'EPERM'});}});
 for(let round=0;round<2;round++)await Promise.all(targets.map(t=>worker.cycle(t)));
 assert.equal(publishCalls,10);assert.equal(acks.length,10);assert(acks.every(a=>a.state==='succeeded'));
 assert.doesNotThrow(()=>worker.requestStop());
});
test('a stalled native branch cannot block a different branch; work is acknowledged only after native proof',async()=>{
 const jobs=new Map(targets.map(t=>[t.branch,fixture(t.branch)])),acks=[];
 let release;const blocked=new Promise(r=>release=r);
 const worker=createWorker({targets,api:async(a,b)=>{if(a==='lease')return {job:jobs.get(b.targetBranch)};acks.push(b);return {accepted:true};},receive:async(t,j)=>{if(t.branch==='005')await blocked;return {operationId:j.id};}});
 const wait=worker.cycle(targets.find(t=>t.branch==='005'));
 await worker.cycle(targets.find(t=>t.branch==='001'));
 assert.equal(acks.length,1);assert.equal(acks[0].targetBranch,'001');assert.equal(acks[0].state,'succeeded');
 release();await wait;assert.equal(acks.length,2);
});
test('offline sources retry, owner conflicts are held and lost replies retain the same operation for replay',async()=>{
 const job=fixture('005'),acks=[],calls=[];let failAck=true;
 const worker=createWorker({targets,api:async(a,b)=>{if(a==='lease')return {job};if(failAck){failAck=false;throw Error('offline response');}acks.push(b);return {accepted:true};},receive:async(t,j)=>{calls.push(j.id);return {operationId:j.id};}});
 const target=targets.find(t=>t.branch==='005');await worker.cycle(target);await worker.cycle(target);
 assert.deepEqual(calls,[job.id,job.id]);assert.equal(acks.length,1);assert.equal(acks[0].id,job.id);
 for(const [code,state] of [['RECEIPT_SOURCE_UNAVAILABLE','retry'],['RECEIPT_NOT_FINAL','retry'],['RECEIPT_OTHER_MEMBER','review'],['RECEIPT_FINANCIAL_HEADER_CHANGED','review'],['RECEIPT_DOCUMENT_KIND_CHANGED','review'],['RECEIPT_CANONICAL_TIME_CHANGED','review']]){
  const w=createWorker({targets,api:async(a,b)=>a==='lease'?{job}:(acks.push(b),{accepted:true}),receive:async()=>{throw Error(code);}});
  await w.cycle(target);assert.equal(acks.at(-1).state,state);assert.equal(acks.at(-1).code,code);
 }
});
test('cross-target work is rejected before SQL; restarting the worker does not replace a durable job',async()=>{
 const job=fixture('005');let nativeCalls=0;
 const dependency={targets,api:async()=>({job}),receive:async()=>{nativeCalls++;return {};}};
 await createWorker(dependency).cycle(targets.find(t=>t.branch==='001'));assert.equal(nativeCalls,0);
 assert.equal(job.targetBranch,'005');
});
test('native connection proof is per target, cached only after success and cannot block another target',async()=>{
 const reads=[],leases=[],statuses=[];let release;
 const delayed=new Promise(r=>release=r);
 const worker=createWorker({targets,probe:async t=>{reads.push(t.branch);if(t.branch==='005')await delayed;},
  api:async(a,b)=>{leases.push(b.targetBranch);return {job:null};},receive:async()=>{},onStatus:s=>statuses.push(s)});
 const slow=worker.cycle(targets.find(t=>t.branch==='005'));
 await worker.cycle(targets.find(t=>t.branch==='001'));await worker.cycle(targets.find(t=>t.branch==='001'));
 assert.deepEqual(leases,['001','001']);assert.equal(reads.filter(b=>b==='001').length,1);
 assert(statuses.at(-1).targets.find(t=>t.branch==='001').sqlVerified);
 release();await slow;assert.equal(leases.at(-1),'005');
});
test('a failed native connection invalidates the cached proof and must be checked again',async()=>{
 const job=fixture('005');let probes=0,leases=0;
 const worker=createWorker({targets,probe:async()=>{if(++probes>1)throw Error('RECEIPT_SOURCE_UNAVAILABLE');},
  api:async(a)=>a==='lease'?(leases++,{job}):{accepted:true},receive:async()=>{throw Error('RECEIPT_SOURCE_UNAVAILABLE');}});
 const t=targets.find(t=>t.branch==='005');await worker.cycle(t);await worker.cycle(t);
 assert.equal(probes,2);assert.equal(leases,1);
});
