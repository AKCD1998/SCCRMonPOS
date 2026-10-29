'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {validate,validateMemberCodes,scanOnce,FIXTURE_ID,catchUpEnabledTargets,createLifecycle,shutdownResources}=require('./worker.cjs');
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

test('optional member codes stay disabled by default and require an explicit valid enable flag',()=>{
 const {config,secret}=fixture();assert.equal(validateMemberCodes(config,secret),false);
 config.memberCodes={enabled:false};assert.equal(validateMemberCodes(config,secret),false);assert.equal(validate(config,secret),config);
 for(const value of [null,true,[],{}, {enabled:'true'},{enabled:1}]){config.memberCodes=value;assert.throws(()=>validateMemberCodes(config,secret),/MEMBER_CODE_OPTION_REFUSED/);}
 config.memberCodes={enabled:true};assert.throws(()=>validateMemberCodes(config,secret),/MEMBER_CODE_SOURCE_CONFIG_REFUSED/);
});
test('explicit member-code enable requires its separate authority secrets at worker validation',()=>{
 const {config,secret}=fixture();const hq=require('../member-codes/service.cjs').HQ_IDENTITY;
 config.memberCodes={enabled:true,scope:'SCCRM-HQ-MEMBER-CODES-V1',hqIdentity:hq,source:{server:'tcp:127.0.0.1,49800',database:'AdaAcc',machine:'SERVER',branchCode:'000',user:'sccrm_member_codes_source',hqIdentity:hq,targetIdentity:hq},targets:config.targets.map(t=>({...t,authorityUser:'sccrm_member_code_authority_'+t.branchCode}))};
 assert.throws(()=>validate(config,secret),/AUTHORITY_CONFIG_REFUSED/);
 secret.memberCodes={authorityPgUrl:secret.pgUrl.replace('sccrm_hq_member_fanout','sccrm_hq_member_code_authority'),sourcePassword:'synthetic-code-source',authorityPasswords:{branch005:'synthetic-code-authority'}};
 assert.equal(validate(config,secret),config);assert.equal(validateMemberCodes(config,secret),true);
});
test('pause and resume cover both runtimes once per transition while preserving SC-only mode',async()=>{
 const calls=[];const engine={stopped:true,start(){this.stopped=false;calls.push('sc:start');},async stop(){this.stopped=true;calls.push('sc:stop');}};
 const codes={runtime:{start(){calls.push('ar:start');},async stop(){calls.push('ar:stop');}}};
 const lifecycle=createLifecycle(engine,codes);await lifecycle.sync(true);await lifecycle.sync(false);await lifecycle.sync(false);await lifecycle.sync(true);await lifecycle.sync(true);await lifecycle.sync(false);
 assert.deepEqual(calls,['sc:start','ar:start','sc:stop','ar:stop','sc:start','ar:start']);
 await lifecycle.sync(true);const old=createLifecycle(engine,null);await old.sync(false);await old.sync(true);assert.deepEqual(calls.slice(-2),['sc:start','sc:stop']);
});
test('a failing SC pause still requests AR pause before surfacing the failure',async()=>{
 let stopped=false;const engine={stopped:true,start(){this.stopped=false;},async stop(){throw Error('SC_STOP_FAILED');}};
 const lifecycle=createLifecycle(engine,{runtime:{start(){},async stop(){stopped=true;}}});await lifecycle.sync(false);
 await assert.rejects(lifecycle.sync(true),/SC_STOP_FAILED/);assert.equal(stopped,true);
});
test('shutdown closes owned code resources before shared pool, including failure paths',async()=>{
 const events=[];await assert.rejects(shutdownResources({engine:{async stop(){events.push('sc:stop');}},codeResources:{async close(){events.push('ar:closed');throw Error('CODE_CLOSE_FAILED');}},source:{close(){events.push('sc:source');}},adapters:{branch005:{close(){events.push('sc:receiver');}}},pool:{async end(){events.push('shared:end');}}}),/CODE_CLOSE_FAILED/);
 assert.deepEqual(events,['sc:stop','ar:closed','sc:source','sc:receiver','shared:end']);
});
