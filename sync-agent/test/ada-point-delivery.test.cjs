'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const delivery=require('../points/delivery.cjs');
const sources=()=>delivery.BRANCHES.map(branchCode=>({branchCode,databaseIdentity:'copy-'+branchCode,observedAt:new Date().toISOString()}));
test('delivery point amounts keep signed 64-bit precision and never coerce fractions or unsafe numbers',()=>{
 for(const value of ['9223372036854775807','-9223372036854775808','9007199254740993'])assert.equal(delivery.integer(value),value);
 assert.equal(delivery.integer('00010.00000000000000000'),'10');assert.equal(delivery.integer(-0),'0');
 for(const value of ['9223372036854775808','-9223372036854775809','1.01',null,undefined,NaN,Infinity,Number.MAX_SAFE_INTEGER+1,{},'1e2'])assert.throws(()=>delivery.integer(value),/POINT_DELIVERY_INTEGER_INVALID/);
});
test('delivery operation IDs are stable and fence database, native code, generation and version',()=>{
 const v='a'.repeat(64),id=delivery.operationId('copy-db','AR000-000001','01',v);
 assert.equal(id,delivery.operationId('copy-db','AR000-000001',1n,v));assert.match(id,/^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
 assert.equal(new Set([id,delivery.operationId('other-copy','AR000-000001',1,v),delivery.operationId('copy-db','AR000-000002',1,v),delivery.operationId('copy-db','AR000-000001',2,v),delivery.operationId('copy-db','AR000-000001',1,'b'.repeat(64))]).size,5);
 assert.throws(()=>delivery.operationId('copy-db','AR000-000001',0,v),/GENERATION_INVALID/);
});
test('freshness requires exactly the five reviewed sources and a bounded age',()=>{
 const f=delivery.normalizeFreshness({sources:sources()});assert.equal(f.maxAgeMs,90000);assert.deepEqual(f.sources.map(s=>s.branch_code),delivery.BRANCHES);
 assert.throws(()=>delivery.normalizeFreshness({sources:sources().slice(1)}),/ALL_FRESH_SOURCES_REQUIRED/);
 const duplicate=sources();duplicate[0]=duplicate[1];assert.throws(()=>delivery.normalizeFreshness({sources:duplicate}),/ALL_FRESH_SOURCES_REQUIRED/);
 assert.throws(()=>delivery.normalizeFreshness({sources:sources(),maxAgeMs:120001}),/FRESHNESS_BOUND_INVALID/);
 const invalid=sources();invalid[0].observedAt='not a time';assert.throws(()=>delivery.normalizeFreshness({sources:invalid}),/SOURCE_TIME_INVALID/);
});
test('only recognized transient failures retry; source movement waits for fresh evidence',()=>{
 for(const code of ['ECONNRESET','ECONNREFUSED','SQL_BUSY','NATIVE_OFFLINE','POINT_RECEIVER_BUSY','POINT_NATIVE_TIMEOUT'])assert.deepEqual(delivery.classifyFailure({code}),{state:'retry',code,waitFresh:false});
 assert.deepEqual(delivery.classifyFailure({code:'POINT_RECEIVER_SOURCE_MOVED_RETRY'}),{state:'retry',code:'SOURCE_MOVED_RETRY',waitFresh:true});
 assert.equal(delivery.classifyFailure({code:'POINT_NATIVE_OPERATION_FAILED',sqlNumber:1222}).state,'retry');
 for(const code of ['POINT_RECEIVER_OPERATION_REUSED','POINT_RECEIVER_OWNED_ROW_CHANGED','NATIVE_ACK_IDENTITY_MISMATCH'])assert.equal(delivery.classifyFailure({code}).state,'review');
 assert.deepEqual(delivery.classifyFailure({message:'secret password value',code:'Error with secret'}),{state:'review',code:'NATIVE_FAILURE_REVIEW',waitFresh:false});
});
