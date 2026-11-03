'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {Connection}=require('./sql-adapter.cjs');
const {isRetryable}=require('../fanout/engine.cjs');
for(const code of ['TARGET_OFFLINE','SQL_TIMEOUT','CONNECTION_CLOSED'])test(`${code} releases a failed RPC and retries the exact same packet on a new connection`,async()=>{
 const packet={assignmentId:'synthetic-owned-assignment',code:'AR000-999999'},seen=[];let created=0,closed=0;
 const client=new Connection({mode:'copy'},'receiver',()=>{const attempt=++created;return {closed:false,
  async query(action,body){seen.push({action,body});if(attempt===1)throw Object.assign(Error(code),{code});return ['same-assignment-ack'];},
  close(){closed++;this.closed=true;}};});
 await assert.rejects(client.query('receive',packet),{code});
 assert.equal(isRetryable(code),true);assert.equal(closed,1);
 assert.deepEqual(await client.query('receive',packet),['same-assignment-ack']);
 assert.equal(created,2);assert.deepEqual(seen,[{action:'receive',body:packet},{action:'receive',body:packet}]);client.close();
});
for(const code of ['MEMBER_CODES_APPROVAL_COLLISION_REVIEW','MEMBER_CODES_PROFILE_MISMATCH','SQL_ERROR_18456','SQL_ERROR_229','SQL_ERROR_2627','CODE_OPERATION_REVIEW'])
 test(`${code} stays held and never becomes an automatic transport retry`,()=>assert.equal(isRetryable(code),false));
