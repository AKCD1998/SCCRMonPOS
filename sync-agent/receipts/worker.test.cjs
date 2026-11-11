'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {createWorker,TARGETS}=require('./worker.cjs');
const targets=TARGETS.map(branch=>({branch}));
const fixture=branch=>{const id=crypto.randomUUID();return {id,targetBranch:branch,leaseToken:crypto.randomUUID(),payloadHash:'a'.repeat(64),payload:{operationId:id,memberId:crypto.randomUUID()}};};
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
 for(const [code,state] of [['RECEIPT_SOURCE_UNAVAILABLE','retry'],['RECEIPT_OTHER_MEMBER','review']]){
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
