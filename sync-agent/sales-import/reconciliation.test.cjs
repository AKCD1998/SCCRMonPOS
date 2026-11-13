'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {classify,rowHash,buildResolutionSql}=require('./reconciliation.cjs');
const c=(column_name,type_name='varchar',is_nullable=true)=>({table_name:'TPSTSalHD',column_name,type_name,is_nullable});
const d=(column,source,hq)=>({table:'TPSTSalHD',column,source,hq});
test('accepts only absent source optional values materialized as exact empty/zero defaults',()=>{
 assert.equal(classify([d('FTShdRmk',null,'')],[c('FTShdRmk')]),'legacy_defaults');
 assert.equal(classify([d('FCShdDiscGP1',null,'0000000000000000')],[c('FCShdDiscGP1','float')]),'legacy_defaults');
 assert.equal(classify([d('FCShdGrand',null,'0000000000000000')],[c('FCShdGrand','float')]),'review');
 assert.equal(classify([d('FTShdRmk','',null)],[c('FTShdRmk')]),'review');
 assert.equal(classify([d('FTShdRmk',null,'30')],[c('FTShdRmk')]),'review');
 assert.equal(classify([d('FCShdDiscGP1',null,'8000000000000000')],[c('FCShdDiscGP1','float')]),'review');
 assert.equal(classify([d('FCShdDiscGP1',null,'00')],[c('FCShdDiscGP1','datetime')]),'review');
 assert.equal(classify([d('FTShdRmk',null,'')],[c('FTShdRmk','varchar',false)]),'review');
});
test('invoice repair is limited to blank HQ invoice fields and never replaces an existing value',()=>{
 assert.equal(classify([d('FTShdDocVatFull','4142',null)],[c('FTShdDocVatFull')]),'invoice_fill');
 assert.equal(classify([d('FTShdDocVatFull','4142','43')],[c('FTShdDocVatFull')]),'review');
 assert.equal(classify([d('FTCstCode','4142',null)],[c('FTCstCode')]),'review');
});
test('change detector distinguishes NULL, empty, zero and row boundaries',()=>{
 const h=x=>rowHash(x,['a','b']);
 assert.notEqual(h({a:null,b:''}),h({a:'',b:null}));
 assert.notEqual(h({a:'00',b:''}),h({a:'',b:'00'}));
 assert.throws(()=>rowHash({a:'AA'.repeat(8000)},['a']),/HASH_LIMIT/);
});
test('operator SQL rejects databases outside the pinned target and owned copy',()=>{
 assert.throws(()=>buildResolutionSql({database:'master'}),/DATABASE_REFUSED/);
});
