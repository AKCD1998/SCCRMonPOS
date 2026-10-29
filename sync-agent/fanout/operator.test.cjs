'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {setTargetEnabled}=require('./operator.cjs');
const {MARKER,SCOPE}=require('../member-codes/assignment.cjs');
class AdminFixture{
 constructor({v2=true,mismatch=false,missing=false,foreign=false}={}){this.v2=v2;this.mismatch=mismatch;this.missing=missing;this.foreign=foreign;this.legacy=false;this.assigned=false;this.calls=[];}
 async query(sql,params){this.calls.push(sql);if(sql==='BEGIN'){this.before=[this.legacy,this.assigned];return {rows:[]};}if(sql==='ROLLBACK'){[this.legacy,this.assigned]=this.before;return {rows:[]};}if(sql==='COMMIT')return {rows:[]};
  if(sql.includes('to_regnamespace'))return {rows:[{namespace:this.v2?'sccrm_member_codes':null}]};
  if(sql.startsWith('SELECT marker'))return {rows:[{marker:this.foreign?'foreign':MARKER,scope:SCOPE,schema_version:1}]};
  if(sql.startsWith('UPDATE sccrm_fanout.targets')){this.legacy=params[1];return {rows:[{target_id:params[0],database_identity:params[2],branch_code:'005',enabled:this.legacy}]};}
  if(sql.startsWith('UPDATE sccrm_member_codes.targets')){if(this.mismatch||this.missing)return {rows:[]};this.assigned=params[1];return {rows:[{target_id:params[0]}]};}throw Error('UNEXPECTED_TEST_SQL');
 }
}
const input={targetId:'branch005',enabled:true,databaseIdentity:'branch005/POSSRV.SQLEXPRESS/AdaAcc/owned-marker'};
test('operator enable and disable change both owned queue targets in one transaction',async()=>{
 const admin=new AdminFixture();assert.equal((await setTargetEnabled(admin,input)).memberCodesSynchronized,true);assert.equal(admin.legacy,true);assert.equal(admin.assigned,true);assert.equal(admin.calls.at(-1),'COMMIT');
 await setTargetEnabled(admin,{...input,enabled:false});assert.equal(admin.legacy,false);assert.equal(admin.assigned,false);
});
test('SC-only deployments preserve operator behavior without creating new schema',async()=>{
 const admin=new AdminFixture({v2:false});assert.equal((await setTargetEnabled(admin,input)).memberCodesSynchronized,false);assert.equal(admin.legacy,true);assert.equal(admin.calls.some(sql=>sql.startsWith('UPDATE sccrm_member_codes')),false);
});
test('missing, conflicting or foreign AR targets cannot partially enable SC queue',async()=>{
 for(const option of [{missing:true},{mismatch:true},{foreign:true}]){const admin=new AdminFixture(option);await assert.rejects(setTargetEnabled(admin,input));assert.equal(admin.legacy,false);assert.equal(admin.assigned,false);assert.equal(admin.calls.at(-1),'ROLLBACK');}
});
test('operator refuses malformed branch and implicit enable flags before opening transaction',async()=>{
 for(const changed of [{targetId:'branch002'},{enabled:'true'},{databaseIdentity:''}]){const admin=new AdminFixture();await assert.rejects(setTargetEnabled(admin,{...input,...changed}));assert.equal(admin.calls.length,0);}
});
