'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const lab=require('./copy-lab.cjs');
test('copy database names are a closed set and cannot select live or arbitrary SQL databases',()=>{
 for(const code of lab.BRANCHES)assert.equal(lab.databaseFor(code),'SCCRM_FanoutCopy_20261029_'+code);
 for(const code of ['AdaAcc','master','005;USE AdaAcc','006','5',5,null])assert.throws(()=>lab.databaseFor(code),/COPY_BRANCH_REFUSED/);
});
test('invalid actions and copy-baseline modes fail before launching a credential-bearing process',()=>{
 assert.throws(()=>lab.run('Drop','005'),/COPY_ACTION_REFUSED/);
 assert.throws(()=>lab.create('005',{copy:true}),/COPY_BASELINE_MODE_REFUSED/);
 assert.throws(()=>lab.snapshot('005',{copy:'true'}),/COPY_BASELINE_MODE_REFUSED/);
});
test('malformed SQL query packets and parameter identifiers are rejected without an SQL connection',()=>{
 assert.throws(()=>lab.query('005',''),/COPY_QUERY_PACKET_REFUSED/);
 assert.throws(()=>lab.query('005','x'.repeat(1048577)),/COPY_QUERY_PACKET_REFUSED/);
 assert.throws(()=>lab.query('005','SELECT @a',{['x;USE AdaAcc']:1}),/COPY_PARAMETER_REFUSED/);
 assert.throws(()=>lab.query('005','SELECT @a',[]),/COPY_PARAMETER_REFUSED/);
});
test('baseline tags cannot escape the owned private runtime directory',()=>{
 for(const tag of ['../outside','..\\outside','x/y','a'.repeat(49),''])assert.throws(()=>lab.snapshot('005',{baselineTag:tag}),/COPY_BASELINE_TAG_REFUSED/);
});
