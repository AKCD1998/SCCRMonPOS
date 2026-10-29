'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');
const { planExisting, publicPlan, adoptExisting } = require('./adopt-existing.cjs');
const { legacyScmCodeFor } = require('./assignment.cjs');
const { record } = require('../history/model.cjs');
const { provisionCodeRoles, checkRights, AUTHORITY_ROLE, DELIVERY_ROLE } = require('./pg-runtime.cjs');
const legacy = require('../fanout/pg-runtime.cjs');
const { AssignmentQueue, registerTarget } = require('./queue.cjs');
const COHORT = [
  ['310b5337-d092-4ccb-bdcc-4decac3a367f','AR004-000095'],
  ['3b6f5506-d848-42c4-a927-f11c24807b93','AR001-000825'],
  ['4035beeb-bdc6-4b31-b3cc-b81f4e547a8d','AR001-000090'],
  ['ad4a451b-39b1-40c5-9936-0e38ba88623e','AR004-000107'],
  ['bb0a6e6c-1952-4b15-aa38-b60519e10846','AR005-000031'],
  ['c105289c-a576-4cd2-8bbb-b065eada7af9','AR001-000662'],
];
const fake = () => ({ query: async () => ({ rows: [{ member_id: COHORT[0][0],
  member_code: legacyScmCodeFor(COHORT[0][0]), link_count: 0, source_id: null, ada_code: null, approval_reference: null }] }) });

test('no explicit approved link means review without native lookup or phone inference', async () => {
  const plan = await planExisting({ db: fake(), memberIds: [COHORT[0][0]], readNative() { throw Error('must not read'); } });
  assert.equal(plan.rows[0].state, 'review');
  assert.equal(plan.rows[0].code, 'ADOPTION_EXACT_APPROVED_LINK_REQUIRED');
});
test('adoption requires an explicit ready plan and operator reference', async () => {
  await assert.rejects(adoptExisting({}), /EXPLICIT_READY_ADOPTION_PLAN_REQUIRED/);
});
test('public preview never includes customer contacts or snapshots', () => {
  const value = publicPlan({ scope: 'preview', mode: 'Copy', fingerprint: 'test', rows: [{ memberId: COHORT[0][0],
    currentCode: 'SCM-TEST', adaCode: COHORT[0][1], state: 'ready', profile: { phone: '0990000001' }, nativeRecord: { secret: 'not output' } }] });
  assert.equal(JSON.stringify(value).includes('0990000001'), false);
  assert.equal(JSON.stringify(value).includes('nativeRecord'), false);
});

const raw = process.env.SCCRM_MEMBER_CODES_ADOPTION_TEST_DATABASE_URL;
test('adopt six existing real native customers on isolated PostgreSQL with authority role',
  { skip: !raw || process.env.SCCRM_MEMBER_CODES_ADOPTION_NATIVE_COPY !== '1' }, async t => {
  const url = new URL(raw);
  assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname));
  assert.equal(url.port, '55446');
  assert.match(url.pathname, /^\/sccrm_fanout_test_[a-z0-9_]+$/);
  fs.writeFileSync(__dirname+'/runtime/adopt-existing-copy-result.json',JSON.stringify({ok:false,state:'running',nativeWrites:0}));
  const { readNative } = require('./operator.cjs');
  const before = new Map(), snapshots = new Map();
  for (const [, code] of COHORT) {
    const rows = readNative('customer', '000', code, 'Copy');
    assert.equal(rows.length, 1); assert.equal(Object.keys(rows[0]).length, 101);
    before.set(code, structuredClone(rows[0])); snapshots.set(code, structuredClone(rows[0]));
  }
  const database = 'sccrm_fanout_test_adoption_' + crypto.randomBytes(5).toString('hex');
  const bootstrap = new Pool({ connectionString: raw, ssl: false });
  await bootstrap.query('CREATE DATABASE ' + database); await bootstrap.end();
  url.pathname = '/' + database;
  const admin = new Pool({ connectionString: url.href, ssl: false, max: 1 });
  const authorityUrl = new URL(url); authorityUrl.username = AUTHORITY_ROLE;
  const deliveryUrl = new URL(url); deliveryUrl.username = DELIVERY_ROLE;
  let authority, delivery;
  let failedSubtests = 0;
  async function subtest(name, run) {
    await t.test(name, async () => { try { await run(); } catch (error) { failedSubtests++; throw error; } });
  }
  const hq = 'copy/hq000/adopt-existing/' + crypto.randomUUID();
  const copyReader = async (action, branch, code, mode) => {
    assert.equal(action, 'customer'); assert.equal(branch, '000'); assert.equal(mode, 'Copy');
    return snapshots.has(code) ? [structuredClone(snapshots.get(code))] : [];
  };
  async function seed(memberId, code, { linked = true } = {}) {
    const native = snapshots.get(code);
    await admin.query('INSERT INTO public.users(id,full_name,phone_number,email) VALUES($1,$2,$3,$4)',
      [memberId, native.FTCstName, native.FTCstTel, native.FTCstEmail]);
    await admin.query('INSERT INTO public.member_profiles(user_id,member_code) VALUES($1,$2)', [memberId, legacyScmCodeFor(memberId)]);
    await admin.query('INSERT INTO public.point_ledger VALUES($1,$2,17)', [crypto.randomUUID(), memberId]);
    await admin.query('INSERT INTO public.loyalty_claims VALUES($1,$2,$3)', [crypto.randomUUID(), memberId, 'COPY-ONLY-' + memberId]);
    if (linked) {
      const r = record('customers', native), envelope = { source_key: r.key, owner_code: r.owner,
        parent_key: r.parent, payload_hash: r.payloadHash, payload: r.payload };
      await admin.query("SELECT ada_history.apply_batch('ef76cc14-1b6b-49c9-8da7-1bfaea3dd92b','LIVE-HQ000-ADAACC','customers',$1::jsonb,$2,$3)",
        [JSON.stringify([envelope]), crypto.randomUUID(), code]);
      await admin.query("INSERT INTO ada_history.member_links VALUES($1,'hq000/AdaAcc',$2,'copy of explicit approved link')", [memberId, code]);
    }
  }
  async function preserved() {
    return (await admin.query(`SELECT
      (SELECT jsonb_agg(to_jsonb(u) ORDER BY id) FROM public.users u WHERE id=ANY($1::uuid[])) users,
      (SELECT jsonb_agg(to_jsonb(m)-'member_code' ORDER BY user_id) FROM public.member_profiles m WHERE user_id=ANY($1::uuid[])) profiles,
      (SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.point_ledger p WHERE user_id=ANY($1::uuid[])) points,
      (SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM public.loyalty_claims c WHERE user_id=ANY($1::uuid[])) claims`, [COHORT.map(x => x[0])])).rows[0];
  }
  try {
    await admin.query(fs.readFileSync(__dirname + '/../live/schema.sql','utf8').split('CREATE OR REPLACE VIEW ada_history.directory AS')[0]);
    await admin.query("INSERT INTO ada_history.meta VALUES('ef76cc14-1b6b-49c9-8da7-1bfaea3dd92b','LIVE-HQ000-ADAACC')");
    await admin.query(`CREATE TABLE public.users(id uuid PRIMARY KEY,full_name text,phone_number text,email text);
      CREATE TABLE public.member_profiles(user_id uuid PRIMARY KEY,member_code varchar(50) UNIQUE NOT NULL,is_active boolean DEFAULT true,remark text DEFAULT 'preserve');
      CREATE TABLE public.point_ledger(id uuid PRIMARY KEY,user_id uuid,amount integer);
      CREATE TABLE public.loyalty_claims(id uuid PRIMARY KEY,user_id uuid,receipt_no text)`);
    await legacy.provisionQueue(admin,{password:crypto.randomBytes(32).toString('hex')});
    await provisionCodeRoles(admin,{authorityPassword:crypto.randomBytes(32).toString('hex'),expectedHqIdentity:hq});
    for (const branch of ['005','001','003','004']) {
      const target = { targetId: 'branch' + branch, branchCode: branch, databaseIdentity: 'copy/adoption/' + branch };
      await registerTarget(admin,target); await legacy.registerTarget(admin,target);
      await admin.query('UPDATE sccrm_member_codes.targets SET enabled=true WHERE target_id=$1',[target.targetId]);
      await admin.query('UPDATE sccrm_fanout.targets SET enabled=true WHERE target_id=$1',[target.targetId]);
    }
    authority = new Pool({ connectionString: authorityUrl.href, ssl: false, max: 2 });
    delivery = new Pool({ connectionString: deliveryUrl.href, ssl: false, max: 2 });
    await checkRights(authority,{role:AUTHORITY_ROLE}); await checkRights(delivery,{role:DELIVERY_ROLE});
    for (const [id,code] of COHORT) await seed(id,code);
    const baseline = await preserved();
    const plan = await planExisting({db:admin,readNative:copyReader});
    assert.equal(plan.rows.length,6); assert.ok(plan.rows.every(r => r.state==='ready'));
    const args = {db:admin,authorityPool:authority,readNative:copyReader,expectedHqIdentity:hq,
      approvedPlan:plan,approvalReference:'COPY ONLY explicit existing-link adoption acceptance'};
    await subtest('six canonical AR codes publish with original UUIDs and one old-code alias each',async()=>{
      const result = await adoptExisting(args); assert.equal(result.ok,true); assert.equal(result.branchDeliveryRequested,false);
      for (const [memberId,code] of COHORT) {
        assert.equal((await admin.query('SELECT member_code FROM public.member_profiles WHERE user_id=$1',[memberId])).rows[0].member_code,code);
        assert.equal((await admin.query('SELECT member_id FROM sccrm_member_codes.aliases WHERE code=$1',[legacyScmCodeFor(memberId)])).rows[0].member_id,memberId);
      }
      assert.deepEqual(await preserved(),baseline);
    });
    await subtest('repeat application creates no duplicate assignments or aliases',async()=>{
      const again=await adoptExisting(args);assert.equal(again.ok,true);assert.ok(again.results.every(r=>r.state==='already-published'));
      for(const table of ['assignments','canonical_codes','aliases']) assert.equal((await admin.query('SELECT count(*)::int n FROM sccrm_member_codes.'+table)).rows[0].n,6);
      assert.equal((await admin.query('SELECT count(*)::int n FROM sccrm_member_codes.migration_events')).rows[0].n,12);
    });
    await subtest('legacy and AR queues stay empty even when all branch targets are enabled',async()=>{
      const queue=new AssignmentQueue(delivery,{expectedHqIdentity:hq});
      for(const row of (await admin.query('SELECT assignment_id,deliver_to_branches,authority_reference FROM sccrm_member_codes.assignments')).rows){
        assert.equal(row.deliver_to_branches,false);assert.match(row.authority_reference,/pre-existing approved HQ link/);
        assert.deepEqual(await queue.enqueueAssignment(row.assignment_id),[]);
      }
      for(const branch of ['005','001','003','004']) assert.deepEqual(await queue.enqueueExistingForTarget('branch'+branch),[]);
      assert.equal((await admin.query('SELECT count(*)::int n FROM sccrm_member_codes.jobs')).rows[0].n,0);
      assert.equal((await admin.query('SELECT count(*)::int n FROM sccrm_fanout.jobs')).rows[0].n,0);
      assert.ok((await admin.query('SELECT previous_native_code FROM sccrm_member_codes.canonical_codes')).rows.every(r=>r.previous_native_code===null));
    });
    await subtest('missing native rows and multiple explicit links are held before publishing',async()=>{
      const missing=await planExisting({db:admin,memberIds:[COHORT[0][0]],readNative:()=>[]});assert.equal(missing.rows[0].code,'ADOPTION_NATIVE_CUSTOMER_NOT_UNIQUE');
      await admin.query("UPDATE ada_history.member_links SET member_id=$1 WHERE source_id='hq000/AdaAcc' AND ada_code=$2",[COHORT[0][0],COHORT[1][1]]);
      try{const duplicate=await planExisting({db:admin,memberIds:[COHORT[0][0]],readNative(){throw Error('must not read');}});
        assert.equal(duplicate.rows[0].code,'ADOPTION_EXACT_APPROVED_LINK_REQUIRED');
      }finally{await admin.query("UPDATE ada_history.member_links SET member_id=$1 WHERE source_id='hq000/AdaAcc' AND ada_code=$2",[COHORT[1][0],COHORT[1][1]]);}
      await assert.rejects(adoptExisting({...args,approvedPlan:{...plan,fingerprint:'tampered'}}),/EXPLICIT_READY_ADOPTION_PLAN_REQUIRED/);
    });
    await subtest('a conflicting current canonical owner cannot be reassigned',async()=>{
      const other=crypto.randomUUID(),code=COHORT[0][1];await seed(other,code,{linked:false});
      await admin.query("UPDATE ada_history.member_links SET member_id=$1 WHERE source_id='hq000/AdaAcc' AND ada_code=$2",[other,code]);
      try{const candidate=await planExisting({db:admin,memberIds:[other],readNative:copyReader});assert.equal(candidate.rows[0].state,'ready');
        await assert.rejects(adoptExisting({...args,approvedPlan:candidate}),/ADOPTION_CANONICAL_OWNER_CONFLICT/);
      }finally{await admin.query("UPDATE ada_history.member_links SET member_id=$1 WHERE source_id='hq000/AdaAcc' AND ada_code=$2",[COHORT[0][0],code]);}
    });
    await subtest('a duplicate old-code alias owned by another UUID cannot be adopted',async()=>{
      const other=COHORT[0][0].slice(0,8)+crypto.randomUUID().slice(8),code='AR000-999999';
      snapshots.set(code,{...structuredClone(before.get(COHORT[0][1])),FTCstCode:code});await seed(other,code);
      const candidate=await planExisting({db:admin,memberIds:[other],readNative:copyReader});assert.equal(candidate.rows[0].state,'ready');
      await assert.rejects(adoptExisting({...args,approvedPlan:candidate}),/ADOPTION_ALIAS_OWNER_CONFLICT/);
      assert.equal((await admin.query('SELECT count(*)::int n FROM sccrm_member_codes.assignments')).rows[0].n,6);
    });
    assert.equal(failedSubtests,0,'All adoption subtests must pass before recording success');
    assert.deepEqual(await preserved(),baseline);
    for(const [,code] of COHORT) assert.deepEqual(readNative('customer','000',code,'Copy'),[before.get(code)]);
    const proof={ok:true,database,host:'127.0.0.1',port:55446,realCustomers:6,nativeColumnsChecked:101,
      nativeRowsUnchanged:6,uuidsHistoryPointsUnchanged:true,assignedRows:6,aliases:6,queuedLegacy:0,queuedAr:0,nativeWrites:0};
    fs.writeFileSync(__dirname+'/runtime/adopt-existing-copy-result.json',JSON.stringify(proof,null,2));
    console.log(JSON.stringify(proof));
  }finally{await Promise.allSettled([authority?.end(),delivery?.end(),admin.end()].filter(Boolean));}
});
