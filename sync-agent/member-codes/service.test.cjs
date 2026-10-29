'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {HQ_IDENTITY,validateServiceConfig,checkTargetBindings,createCodeResources}=require('./service.cjs');
function fixture(){
 const target={targetId:'branch005',branchCode:'005',databaseIdentity:'branch005/POSSRV.SQLEXPRESS/AdaAcc/owned-marker',database:'AdaAcc',machine:'POSSRV',server:'tcp:100.106.107.80,49711',user:'sccrm_member_fanout_005'};
 return {config:{enabled:true,scope:'SCCRM-HQ-MEMBER-CODES-V1',hqIdentity:HQ_IDENTITY,source:{server:'tcp:127.0.0.1,49800',database:'AdaAcc',machine:'SERVER',branchCode:'000',user:'sccrm_member_codes_source',hqIdentity:HQ_IDENTITY,targetIdentity:HQ_IDENTITY},targets:[{...target,authorityUser:'sccrm_member_code_authority_005'}]},secrets:{authorityPgUrl:'postgresql://sccrm_hq_member_code_authority.fixture:synthetic@test.pooler.supabase.com:5432/postgres',sourcePassword:'synthetic-source',authorityPasswords:{branch005:'synthetic-authority'}},context:{pgHost:'test.pooler.supabase.com',targets:[target]},deliveryPasswords:{branch005:'synthetic-receiver'}};
}
test('enabled service binds dedicated authority/source and all destinations to reviewed SC targets',()=>{
 const {config,secrets,context}=fixture();assert.equal(validateServiceConfig(config,secrets,context),config);
 const changes=[c=>c.enabled=false,c=>c.scope='other',c=>c.hqIdentity='other',c=>c.source.user='sa',c=>c.source.branchCode='005',c=>c.source.server='tcp:100.90.166.72,49800',c=>c.targets[0].branchCode='003',c=>c.targets[0].authorityUser='sccrm_member_code_authority_003',c=>c.targets[0].databaseIdentity='other',c=>c.targets.push(c.targets[0])];
 for(const change of changes){const altered=structuredClone(config);change(altered);assert.throws(()=>validateServiceConfig(altered,secrets,context));}
});
test('missing or misplaced secrets fail before constructing any resource',()=>{
 const {config,secrets,context}=fixture();
 for(const altered of [undefined,{}, {...secrets,sourcePassword:''},{...secrets,authorityPasswords:{}},{...secrets,authorityPgUrl:secrets.authorityPgUrl.replace('sccrm_hq_member_code_authority','sccrm_hq_member_fanout')},{...secrets,authorityPgUrl:'not a URL'},{...secrets,authorityPgUrl:secrets.authorityPgUrl.replace('test.pooler','other.pooler')}])assert.throws(()=>validateServiceConfig(config,altered,context));
 assert.throws(()=>createCodeResources({config,secrets,...context,deliveryPasswords:{}}),/DELIVERY_CREDENTIAL_REQUIRED/);
});
test('read-only bootstrap check requires both database identities and enable states to match',async()=>{
 const {context}=fixture(),t=context.targets[0];
 const row={target_id:t.targetId,legacy_identity:t.databaseIdentity,assigned_identity:t.databaseIdentity,legacy_branch:'005',assigned_branch:'005',legacy_enabled:true,assigned_enabled:true};
 const pool=rows=>({query:async sql=>{assert.ok(sql.startsWith('SELECT'));assert.ok(!/UPDATE|INSERT|DELETE/.test(sql));return {rows};}});
 assert.deepEqual(await checkTargetBindings(pool([row]),context.targets),{matched:1});
 for(const rows of [[],[{...row,assigned_identity:null}],[{...row,assigned_enabled:false}],[{...row,assigned_branch:'003'}]])await assert.rejects(checkTargetBindings(pool(rows),context.targets),/TARGET_STATE_MISMATCH/);
});
test('wiring separates principals, propagates cancellation and closes owned resources once',async()=>{
 const {config,secrets,context,deliveryPasswords}=fixture();const events=[],instances=[];let runtimeOptions;
 class FakePool{constructor(options){assert.equal(options.ssl.rejectUnauthorized,true);this.options=options;}on(){}async end(){events.push('authority:pool:end');}}
 class FakeSource{constructor(options){this.options=options;instances.push(this);}close(){events.push('source:close');}}
 class FakeAuthority{constructor(options){this.options=options;instances.push(this);}async approve(record,signal){events.push('approve');assert.equal(signal.token,'owned');assert.equal(record.assignmentHash,'fixture-hash');}close(){events.push('authority:close');}}
 class FakeReceiver{constructor(options){this.options=options;instances.push(this);}async receive(job,{signal}){events.push('receive');assert.equal(signal.token,'owned');return {memberId:job.member_id};}close(){events.push('receiver:close');}}
 const runtime={async stop(){events.push('runtime:stop');},async status(){return {stopped:false,targets:[]};}};
 const resources=createCodeResources({config,secrets,...context,deliveryPool:{owned:'shared'},deliveryPasswords,ca:'synthetic-ca'},{Pool:FakePool,AssignmentSource:FakeSource,AssignmentAuthority:FakeAuthority,AssignedReceiver:FakeReceiver,newAssignmentRuntime:options=>{runtimeOptions=options;return runtime;}});
 assert.notEqual(runtimeOptions.source,runtimeOptions.snapshotSource);assert.equal(runtimeOptions.expectedHqIdentity,HQ_IDENTITY);
 const authority=instances.find(r=>r instanceof FakeAuthority),receiver=instances.find(r=>r instanceof FakeReceiver);
 assert.equal(authority.options.connection.user,'sccrm_member_code_authority_005');assert.equal(receiver.options.connection.user,'sccrm_member_fanout_005');
 assert.deepEqual(await runtimeOptions.adapters.branch005.receive({member_id:'fixture-id',assignment:{},assignment_hash:'fixture-hash',profile:{},previous_native_code:null},{signal:{token:'owned'}}),{memberId:'fixture-id'});
 assert.deepEqual(events.slice(0,2),['approve','receive']);await resources.close();await resources.close();
 assert.equal(events.filter(e=>e==='runtime:stop').length,1);assert.equal(events.filter(e=>e==='authority:pool:end').length,1);
 assert.equal(events.at(-1),'authority:pool:end');assert.ok(!JSON.stringify(await resources.runtime.status()).includes('synthetic-'));
});
test('owned RPCs and authority pool still close if runtime stop rejects',async()=>{
 const {config,secrets,context,deliveryPasswords}=fixture(),events=[];
 class Pool{on(){}async end(){events.push('pool:end');}}
 class Rpc{close(){events.push('rpc:close');}}
 const resources=createCodeResources({config,secrets,...context,deliveryPasswords},{Pool,AssignmentSource:Rpc,AssignmentAuthority:Rpc,AssignedReceiver:Rpc,newAssignmentRuntime:()=>({async stop(){throw Error('STOP_FAILED');}})});
 await assert.rejects(resources.close(),/STOP_FAILED/);await assert.rejects(resources.close(),/STOP_FAILED/);
 assert.equal(events.filter(e=>e==='rpc:close').length,4);assert.equal(events.filter(e=>e==='pool:end').length,1);
});
