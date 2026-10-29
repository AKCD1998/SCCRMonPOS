'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {validate,scanOnce,FIXTURE_ID,catchUpEnabledTargets}=require('./worker.cjs');
const {MARKER,SCOPE}=require('./engine.cjs');
function fixture(){return {config:{scope:SCOPE,marker:MARKER,mode:'live',pgHost:'test.pooler.supabase.com',source:{machine:'SERVER',database:'AdaAcc',user:'sccrm_member_fanout_source',server:'tcp:127.0.0.1,49800'},targets:[{targetId:'branch005',branchCode:'005',database:'AdaAcc',machine:'POSSRV',server:'100.106.107.80\\SQLEXPRESS',databaseIdentity:'branch005/POSSRV.SQLEXPRESS/AdaAcc/owned-fixture',user:'sccrm_member_fanout_005'}],heldSourceIds:{[FIXTURE_ID]:'SYNTHETIC_SOURCE_FIXTURE_HELD'}},secret:{pgUrl:'postgresql://sccrm_hq_member_fanout.fixture:synthetic@'+ 'test.pooler.supabase.com:5432/postgres',targetPasswords:{branch005:'synthetic-receiver-fixture'}}};}
test('service config binds the real source, queue role, destination and known fixture hold',()=>{const {config,secret}=fixture();assert.equal(validate(config,secret),config);for(const mutate of [c=>c.scope='other',c=>c.source.user='sa',c=>c.source.server='tcp:100.1.2.3,49800',c=>delete c.heldSourceIds[FIXTURE_ID],c=>c.targets[0].server='100.77.101.94\\SQLEXPRESS',c=>c.targets[0].machine='SC_001',c=>c.targets[0].database='other',c=>c.targets[0].databaseIdentity='branch003/POSSRV.SQLEXPRESS/AdaAcc/other']){const changed=structuredClone(config);mutate(changed);assert.throws(()=>validate(changed,secret));}});
test('a committed source is persisted before its cursor can advance',async()=>{const e={memberId:'11111111-1111-4111-8111-111111111111',hqConfirmedAt:'2026-10-29T03:00:00Z'};const steps=[];const q={getSourceCheckpoint:async()=>null,enqueueConfirmed:async r=>steps.push(['persist',r.memberId]),advanceSourceCheckpoint:async r=>steps.push(['cursor',r.memberId])};assert.deepEqual(await scanOnce({read:async()=>[e]},q),{observed:1,enqueued:1,held:0});assert.deepEqual(steps,[['persist',e.memberId],['cursor',e.memberId]]);});
test('an enqueue failure cannot skip an acknowledged HQ creation',async()=>{let advanced=false;const q={getSourceCheckpoint:async()=>null,enqueueConfirmed:async()=>{throw Error('unavailable')},advanceSourceCheckpoint:async()=>{advanced=true}};await assert.rejects(scanOnce({read:async()=>[{memberId:'11111111-1111-4111-8111-111111111111'}]},q));assert.equal(advanced,false);});
test('known synthetic source is held durably and never enqueued to a destination',async()=>{let queued=false;const held=[];const q={getSourceCheckpoint:async()=>null,enqueueConfirmed:async()=>{queued=true},holdConfirmed:async(r,reason)=>held.push({id:r.memberId,reason}),advanceSourceCheckpoint:async()=>{}};const result=await scanOnce({read:async()=>[{memberId:FIXTURE_ID,hqConfirmedAt:'2026-10-24T12:13:34.563Z'}]},q,{[FIXTURE_ID]:'SYNTHETIC_SOURCE_FIXTURE_HELD'});assert.equal(queued,false);assert.equal(result.held,1);assert.deepEqual(held,[{id:FIXTURE_ID,reason:'SYNTHETIC_SOURCE_FIXTURE_HELD'}]);});
// Scheduler regression only: source/job durability and receiver identity are
// covered by the real PostgreSQL/native-copy suites. No remote connection here.
class QueueFixture{
 constructor(){this.enabled=new Map([['branch005',true]]);this.sources=[];this.jobs=new Set();this.calls=[];}
 source(id){this.sources.push(id);}
 async targets(){return [...this.enabled].filter(([,yes])=>yes).map(([target_id])=>({target_id}));}
 async enqueueExistingForTarget(target,{limit}){this.calls.push({target,limit});const missing=this.sources.filter(id=>!this.jobs.has(target+':'+id)).slice(0,limit);for(const id of missing)this.jobs.add(target+':'+id);return missing;}
}
test('re-enabling a target catches envelopes ingested during its observed disabled interval',async()=>{
 const q=new QueueFixture();q.source('11111111-1111-4111-8111-111111111111');await catchUpEnabledTargets(q);
 q.enabled.set('branch005',false);q.source('22222222-2222-4222-8222-222222222222');assert.equal((await catchUpEnabledTargets(q)).targets,0);assert.equal(q.jobs.size,1);
 q.enabled.set('branch005',true);assert.equal((await catchUpEnabledTargets(q)).enqueued,1);assert.equal(q.jobs.size,2);assert.equal((await catchUpEnabledTargets(q)).enqueued,0);
});
test('disable and re-enable entirely between polls cannot hide a missing delivery job',async()=>{
 const q=new QueueFixture();q.source('11111111-1111-4111-8111-111111111111');await catchUpEnabledTargets(q);
 q.enabled.set('branch005',false);q.source('22222222-2222-4222-8222-222222222222');q.enabled.set('branch005',true);
 assert.equal((await catchUpEnabledTargets(q)).enqueued,1);assert.equal(q.jobs.size,2);assert.equal((await catchUpEnabledTargets(q)).enqueued,0);
});
test('catchup stays bounded per database, drains a larger backlog, and never duplicates jobs',async()=>{
 const q=new QueueFixture();q.enabled.set('branch001',true);for(let i=0;i<205;i++)q.source(String(i).padStart(8,'0')+'-0000-4000-8000-000000000000');
 assert.equal((await catchUpEnabledTargets(q)).enqueued,200);assert.equal((await catchUpEnabledTargets(q)).enqueued,200);assert.equal((await catchUpEnabledTargets(q)).enqueued,10);assert.equal((await catchUpEnabledTargets(q)).enqueued,0);
 assert.equal(q.jobs.size,410);assert.ok(q.calls.every(c=>c.limit===100));
});
test('disabled targets are never reconciled or enabled as a side effect',async()=>{
 const q=new QueueFixture();q.enabled.set('branch005',false);q.enabled.set('branch004',true);q.source('11111111-1111-4111-8111-111111111111');
 const result=await catchUpEnabledTargets(q);assert.equal(result.targets,1);assert.equal(result.enqueued,1);assert.deepEqual(q.calls.map(c=>c.target),['branch004']);assert.equal(q.enabled.get('branch005'),false);
});
