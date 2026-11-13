'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {serialDestination}=require('./branch-history.cjs');
const {configuration}=require('./scheduler.cjs');
test('destination operations stay serial and a failed transaction cannot poison the next branch',async()=>{
 const serial=serialDestination(),events=[];let release;const gate=new Promise(r=>{release=r;});
 const first=serial(async()=>{events.push('first-start');await gate;events.push('first-end');throw Error('FIXTURE_FAILED');});
 const failed=assert.rejects(first,/FIXTURE_FAILED/);
 const second=serial(async()=>{events.push('second');return 2;});
 await Promise.resolve();assert.deepEqual(events,['first-start']);release();await failed;
 assert.equal(await second,2);assert.deepEqual(events,['first-start','first-end','second']);
});
test('branch ingestion is opt-in, source-pinned, and bounded independently of other lanes',()=>{
 assert.equal(configuration({}).branchHistoryEnabled,false);
 assert.deepEqual(configuration({branchHistoryEnabled:true,branchHistoryBranches:['005']}).branchHistoryBranches,['005']);
 for(const c of [{branchHistoryEnabled:'true'},{branchHistoryBranches:[]},{branchHistoryBranches:['000']},{branchHistoryBranches:['005','005']},{branchHistoryPollMs:4999},{branchHistoryFullPollMs:10000}])assert.throws(()=>configuration(c),/LIVE_POLL_CONFIG_REFUSED/);
});
