'use strict';
// Pure guards only: no credentials are loaded, child process spawned, service
// changed, or native/Supabase write made by these tests.
const test=require('node:test'),assert=require('node:assert/strict');
const {IDS,validateCohort,validateTargets,configFor,runtimeSecret}=require('./operator.cjs');
const {legacyScCodeFor}=require('./assignment.cjs');
function fixture(){
 const peers={'001':{ip:'100.81.137.41',machine:'SC_001'},'003':{ip:'100.77.101.94',machine:'POSSRV'},'004':{ip:'100.113.59.42',machine:'SERVER004'},'005':{ip:'100.106.107.80',machine:'POSSRV'}};
 const targets=Object.fromEntries(Object.entries(peers).map(([branch,p])=>[branch,{targetId:'branch'+branch,branchCode:branch,server:p.ip+'\\SQLEXPRESS',machine:p.machine,database:'AdaAcc',databaseIdentity:'branch'+branch+'/'+p.machine+'.SQLEXPRESS/AdaAcc/owned-fixture',user:'sccrm_member_fanout_'+branch}]));
 return {live:{pgUrl:'postgresql://sccrm_hq_member_fanout.fixture:synthetic@test.pooler.supabase.com:5432/postgres',targets,targetPasswords:Object.fromEntries(Object.keys(targets).map(b=>['branch'+b,'synthetic-delivery-'+b]))},memberCodes:{authorityPgUrl:'postgresql://sccrm_hq_member_code_authority.fixture:synthetic@test.pooler.supabase.com:5432/postgres',sourcePassword:'synthetic-source',authorityPasswords:{'000':'DO_NOT_TRANSFER_HQ_000_FIXTURE','001':'synthetic-001','003':'synthetic-003','004':'synthetic-004','005':'synthetic-005'},cohort:IDS.map((id,n)=>({memberId:id,previousCode:legacyScCodeFor(id),name:'Synthetic approved fixture '+n,phone:'099000000'+n,email:n+'@example.invalid'}))}};
}
test('migration admission requires the exact two unique authorized UUIDs and their old SC codes',()=>{
 const s=fixture(),rows=s.memberCodes.cohort;assert.equal(validateCohort(rows),rows);assert.equal(validateCohort([...rows].reverse()).length,2);
 for(const bad of [null,[],[rows[0]],[rows[0],rows[0]],[...rows,rows[0]],[{...rows[0],memberId:'11111111-1111-4111-8111-111111111111'},rows[1]],[{...rows[0],previousCode:rows[1].previousCode},rows[1]],[{...rows[0],name:''},rows[1]],[{...rows[0],phone:'not-a-phone'},rows[1]]])assert.throws(()=>validateCohort(bad),/EXACT_APPROVED_MIGRATION_COHORT_REQUIRED/);
});
test('operator targets require all four approved databases, excluding HQ as a destination',()=>{
 const s=fixture();assert.equal(validateTargets(s).length,4);
 for(const mutate of [x=>delete x.live.targets['004'],x=>{x.live.targets['000']=x.live.targets['004'];delete x.live.targets['004'];},x=>x.live.targets['005'].targetId='branch000',x=>x.live.targets['005'].branchCode='003',x=>x.live.targets['005'].server=x.live.targets['003'].server,x=>x.live.targets['001'].user='sa',x=>x.live.targets['001'].database='another',x=>x.live.targets['001'].databaseIdentity='branch005/wrong']){
  const altered=structuredClone(s);mutate(altered);assert.throws(()=>validateTargets(altered));
 }
});
test('runtime secret contains only source/PG and four branch authorities, never HQ migration authority',()=>{
 const s=fixture(),out=runtimeSecret(s);
 assert.deepEqual(Object.keys(out).sort(),['authorityPasswords','authorityPgUrl','sourcePassword']);
 assert.deepEqual(Object.keys(out.authorityPasswords).sort(),['branch001','branch003','branch004','branch005']);
 assert.ok(!JSON.stringify(out).includes('DO_NOT_TRANSFER_HQ_000_FIXTURE'));
 assert.ok(!JSON.stringify(out).includes('cohort'));assert.ok(!JSON.stringify(configFor(s)).includes('synthetic-source'));
});
test('transfer helper rejects injected HQ target and missing branch authority credential',()=>{
 const s=fixture();s.live.targets['000']=s.live.targets['005'];delete s.live.targets['005'];assert.throws(()=>runtimeSecret(s));
 const missing=fixture();delete missing.memberCodes.authorityPasswords['005'];assert.throws(()=>runtimeSecret(missing),/MEMBER_CODE_TARGET_BINDING_REFUSED/);
});
