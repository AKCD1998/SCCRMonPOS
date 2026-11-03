'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {configuration,runLane,runLanes}=require('../live/scheduler.cjs');
const {resolveExisting,digestMember}=require('../live/existing-members.cjs');
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
test('member polling defaults to 2 seconds; history remains five minutes',()=>{
 assert.deepEqual(configuration({}),{memberPollMs:2000,historyPollMs:300000});
 for(const memberPollMs of [0,999,10001,'2000',NaN])assert.throws(()=>configuration({memberPollMs}),/LIVE_POLL_CONFIG_REFUSED/);
 for(const historyPollMs of [0,299999,3600001,'300000'])assert.throws(()=>configuration({historyPollMs}),/LIVE_POLL_CONFIG_REFUSED/);
});
test('members continue while history is blocked; neither lane overlaps itself',async()=>{
 const history=deferred(),ready=deferred();let stop=false,members=0,histories=0,active=0,max=0;
 const run=runLanes({memberPollMs:1000,historyPollMs:300000,stopping:()=>stop,
  memberCycle:async()=>{active++;max=Math.max(max,active);await Promise.resolve();members++;active--;if(members===4){stop=true;ready.resolve();}},
  historyCycle:async()=>{histories++;await history.promise;},sleep:async()=>{await new Promise(r=>setImmediate(r));}});
 await ready.promise;assert.equal(members,4);assert.equal(histories,1);assert.equal(max,1);history.resolve();await run;
});
test('a failed lane retries independently and stop interrupts long sleep',async()=>{
 let stop=false,calls=0,errors=0,sleeps=0;
 await runLane({intervalMs:300000,stopping:()=>stop,cycle:async()=>{calls++;throw Error('TARGET_OFFLINE');},
  onError:async()=>{errors++;},sleep:async ms=>{assert.ok(ms<=250);sleeps++;stop=true;}});
 assert.equal(calls,1);assert.equal(errors,1);assert.equal(sleeps,1);
});
test('a missing exact candidate never queries or changes Ada',async()=>{
 const pg={query:async()=>({rows:[]})};assert.equal(await resolveExisting(pg,{query(){throw Error('native read forbidden');}},{id:'member'},()=>{throw Error('write forbidden');}),null);
});
test('ambiguous or non-AR candidates cannot be published',async()=>{
 for(const rows of [[{ada_code:'SC-AAAAAAAAAAAAAAAA'}],[{ada_code:'AR001-000001'},{ada_code:'AR001-000002'}]])
 await assert.rejects(resolveExisting({query:async()=>({rows})},{query(){throw Error('must not query');}},{id:'member'},()=>{}),/MEMBER_LINK_CANDIDATE_REFUSED/);
});
test('existing resolution requires a full sanitized native snapshot and exact acknowledgement',async()=>{
 const member={id:'member',full_name:'Member',phone_number:'0990000001',email:null};
 const pg={query:async()=>({rows:[{ada_code:'AR001-000001'}]})};
 await assert.rejects(resolveExisting(pg,{query:async()=>[{FTCstCode:'AR001-000001'}]},member,()=>{}),/MEMBER_LINK_NATIVE_SNAPSHOT_REFUSED/);
 const raw=Object.fromEntries(Array.from({length:100},(_,i)=>['column_'+i,null]));raw.FTCstCode='AR001-000001';raw.customer_pin='forbidden';delete raw.column_0;
 await assert.rejects(resolveExisting(pg,{query:async()=>[raw]},member,()=>{}),/SENSITIVE_SOURCE_FIELD_REFUSED/);
 assert.match(digestMember(member),/^[a-f0-9]{64}$/);
});
