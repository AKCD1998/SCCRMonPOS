'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { Pool } = require('pg');
const { AssignmentQueue, registerTarget } = require('./queue.cjs');
const { assignmentHash, legacyScCodeFor, legacyScmCodeFor } = require('./assignment.cjs');
const { profileHash } = require('../fanout/engine.cjs');
const { persistAuthority, ingestOnce, publishPendingOnce, newAssignmentRuntime } = require('./runtime.cjs');
const url = process.env.SCCRM_MEMBER_CODES_TEST_DATABASE_URL || process.env.SCCRM_FANOUT_TEST_DATABASE_URL;
test('assignment runtime orchestration with isolated real PostgreSQL and native-shaped fixtures', { skip: !url }, async t => {
  const configured = new URL(url);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(configured.hostname));
  assert.match(configured.pathname.slice(1), /^sccrm_fanout_test_[a-z0-9_]+$/); assert.ok(configured.port && configured.port !== '5432');
  const nonce = crypto.randomBytes(5).toString('hex'), database = 'sccrm_fanout_test_runtime_' + nonce;
  const boot = new Pool({ connectionString: url, ssl: false }); await boot.query('CREATE DATABASE ' + database); await boot.end();
  configured.pathname = '/' + database;
  const config = { connectionString: configured.toString(), ssl: false, max: 5 };
  const admin = new Pool(config), deliveryPool = new Pool(config), authorityPool = new Pool(config);
  const hq = 'copy000/SERVER.SQLEXPRESS/SCCRM_FanoutCopy_20261029_000/64fa3170-80ae-45ee-b9f3-7478b2a46e34';
  let sequence = 0; const entries = [], snapshots = new Map(), failingSnapshots = new Set(), runtimes = new Set();
  const source = { async read(checkpoint) { return entries.filter(row => !checkpoint || row.assignment.assignedAt > checkpoint.createdAt
    || (row.assignment.assignedAt === checkpoint.createdAt && row.assignment.assignmentId > checkpoint.assignmentId)); },
  async snapshot(id) { if (failingSnapshots.has(id)) throw Object.assign(Error('RPC_TIMEOUT'), { code: 'RPC_TIMEOUT' }); return snapshots.get(id); } };
  async function make({ kind = 'hq_create', previous = false } = {}) {
    const n = ++sequence, memberId = crypto.randomUUID(), assignmentId = crypto.randomUUID();
    const profile = { name: 'COPY runtime ' + nonce + '-' + n, phone: '099' + String(n).padStart(7, '0'), email: n + '@example.invalid' };
    const assignment = { version: 1, assignmentId, memberId, adaCode: 'AR000-' + String(n).padStart(6, '0'),
      hqIdentity: hq, profileHash: profileHash(profile), assignedAt: new Date(Date.UTC(2026, 9, 29, 7, 0, n)).toISOString(), kind };
    const item = { assignment, profile, assignmentHash: assignmentHash(assignment, { expectedHqIdentity: hq, allowApprovedExisting: true }), previousNativeCode: previous ? legacyScCodeFor(memberId) : null };
    snapshots.set(assignmentId, { FTCstCode: assignment.adaCode, FTCstName: profile.name, FTCstTel: profile.phone,
      FTCstEmail: profile.email, FTBchCode: '000', FTCstStaActive: '1' });
    await admin.query('INSERT INTO public.member_profiles(user_id,member_code) VALUES($1,$2)', [memberId, legacyScmCodeFor(memberId)]);
    entries.push(item); return item;
  }
  const acknowledge = job => ({ memberId: job.member_id, assignmentId: job.assignment_id, assignmentHash: job.assignment_hash,
    hqCode: job.hq_code, adaCode: job.hq_code, targetIdentity: job.database_identity, profile: job.profile,
    profileHash: job.profile_hash, outcome: 'created' });
  function runtime(options = {}) {
    const r = newAssignmentRuntime({ deliveryPool, authorityPool, source, expectedHqIdentity: hq, publishEnabled: false,
      adapters: { branch005: { receive: async job => acknowledge(job) } }, ...options }); runtimes.add(r); return r;
  }
  async function waitFor(predicate) {
    const until = Date.now() + 3000; while (!(await predicate())) { if (Date.now() > until) throw Error('TEST_TIMEOUT'); await new Promise(resolve => setTimeout(resolve, 10)); }
  }
  try {
    await admin.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
    await admin.query('UPDATE sccrm_member_codes.meta SET expected_hq_identity=$1', [hq]);
    await admin.query(fs.readFileSync(path.join(__dirname, '../live/schema.sql'), 'utf8').split('CREATE OR REPLACE VIEW ada_history.directory AS')[0]);
    await admin.query("INSERT INTO ada_history.meta VALUES('ef76cc14-1b6b-49c9-8da7-1bfaea3dd92b','LIVE-HQ000-ADAACC');CREATE TABLE public.member_profiles(user_id uuid PRIMARY KEY,member_code varchar(50) UNIQUE NOT NULL,stable text DEFAULT 'unchanged')");
    if (!(await admin.query("SELECT 1 FROM pg_roles WHERE rolname='sccrm_hq_member_code_authority'")).rowCount) await admin.query('CREATE ROLE sccrm_hq_member_code_authority NOLOGIN NOINHERIT');
    await admin.query('GRANT USAGE ON SCHEMA sccrm_member_codes TO sccrm_hq_member_code_authority;GRANT SELECT ON ALL TABLES IN SCHEMA sccrm_member_codes TO sccrm_hq_member_code_authority;GRANT INSERT ON sccrm_member_codes.assignments,sccrm_member_codes.canonical_codes,sccrm_member_codes.aliases TO sccrm_hq_member_code_authority;GRANT EXECUTE ON FUNCTION sccrm_member_codes.refresh_assigned_customer(uuid,jsonb,uuid),sccrm_member_codes.publish_member_code(uuid) TO sccrm_hq_member_code_authority');
    for (const table of ['meta', 'assignments', 'canonical_codes', 'aliases', 'publication_events']) await admin.query(`CREATE POLICY runtime_test_authority ON sccrm_member_codes.${table} TO sccrm_hq_member_code_authority USING(true) WITH CHECK(true)`);
    authorityPool.on('connect', client => { client.query('SET SESSION AUTHORIZATION sccrm_hq_member_code_authority').catch(() => {}); });
    assert.equal((await authorityPool.query('SELECT session_user actor')).rows[0].actor, 'sccrm_hq_member_code_authority');
    await registerTarget(admin, { targetId: 'branch005', branchCode: '005', databaseIdentity: 'runtime-copy/005' });
    await admin.query("UPDATE sccrm_member_codes.targets SET enabled=true WHERE target_id='branch005'");
    const q = new AssignmentQueue(deliveryPool, { expectedHqIdentity: hq }); await q.guard();
    await t.test('owned source persistence, queue and checkpoint survive replay without UPDATE', async () => {
      const item = await make(); const result = await ingestOnce({ authorityPool, source, queue: q, expectedHqIdentity: hq });
      assert.equal(result.persisted, 1); assert.equal(result.enqueued, 1);
      await persistAuthority(authorityPool, item, hq);
      assert.equal((await admin.query('SELECT count(*)::int n FROM sccrm_member_codes.assignments')).rows[0].n, 1);
      assert.equal((await ingestOnce({ authorityPool, source, queue: q, expectedHqIdentity: hq })).observed, 0);
    });
    await t.test('crash after immutable persistence but before enqueue never advances cursor or loses event', async () => {
      const item = await make(), before = await q.getSourceCheckpoint();
      const failQueue = { getSourceCheckpoint: () => q.getSourceCheckpoint(), enqueueAssignment: async () => { throw Error('SIMULATED_CRASH'); }, advanceSourceCheckpoint: () => assert.fail('cursor must not advance') };
      await assert.rejects(ingestOnce({ authorityPool, source, queue: failQueue, expectedHqIdentity: hq }), /SIMULATED_CRASH/);
      assert.deepEqual(await q.getSourceCheckpoint(), before);
      assert.equal((await admin.query('SELECT count(*)::int n FROM sccrm_member_codes.assignments WHERE assignment_id=$1', [item.assignment.assignmentId])).rows[0].n, 1);
      await ingestOnce({ authorityPool, source, queue: q, expectedHqIdentity: hq });
      assert.equal((await q.getSourceCheckpoint()).assignmentId, item.assignment.assignmentId);
    });
    await t.test('same assignment cannot change profile, previous native code, delivery scope or member', async () => {
      const item = entries[0];
      for (const change of [{ assignmentHash: 'f'.repeat(64) }, { previousNativeCode: legacyScCodeFor(item.assignment.memberId) },
        { deliverToBranches: false }, { profile: { ...item.profile, name: 'Different person' } }]) {
        await assert.rejects(persistAuthority(authorityPool, { ...item, ...change }, hq));
      }
      assert.equal((await admin.query('SELECT profile FROM sccrm_member_codes.assignments WHERE assignment_id=$1', [item.assignment.assignmentId])).rows[0].profile.name, item.profile.name);
    });
    await t.test('approved SC migration preserves old native alias while leaving v1 schema absent', async () => {
      const item = await make({ kind: 'approved_existing', previous: true }); await ingestOnce({ authorityPool, source, queue: q, expectedHqIdentity: hq });
      const alias = (await admin.query('SELECT code,member_id FROM sccrm_member_codes.aliases WHERE code=$1', [item.previousNativeCode])).rows[0];
      assert.equal(alias.member_id, item.assignment.memberId); assert.equal((await admin.query("SELECT to_regnamespace('sccrm_fanout') name")).rows[0].name, null);
    });
    await t.test('real engine optional validator dispatches AR queue after source read error', async () => {
      const failingSource = { read: async () => { throw Object.assign(Error('TARGET_OFFLINE'), { code: 'TARGET_OFFLINE' }); } };
      const r = runtime({ source: failingSource });
      for (let i = 0; i < entries.length + 1; i++) { await r.tick(); await new Promise(resolve => setTimeout(resolve, 15)); }
      await waitFor(async () => (await q.status())[0].waiting === 0);
      assert.equal((await r.status()).lastSourceError, 'TARGET_OFFLINE');
      assert.equal((await admin.query('SELECT count(*)::int n FROM sccrm_member_codes.mappings')).rows[0].n, entries.length); await r.stop();
    });
    await t.test('publication pending survives restart, progresses past failed snapshot and never rereads success', async () => {
      const first = entries[0]; failingSnapshots.add(first.assignment.assignmentId);
      let after = null, published = 0;
      for (let i = 0; i < entries.length + 1; i++) {
        const result = await publishPendingOnce({ authorityPool, source, expectedHqIdentity: hq, after });
        if (result.length) after = result.at(-1).cursor; published += result.filter(row => row.state === 'published').length;
      }
      assert.equal(published, entries.length - 1);
      failingSnapshots.delete(first.assignment.assignmentId);
      const result = await publishPendingOnce({ authorityPool, source, expectedHqIdentity: hq }); assert.equal(result[0].state, 'published');
      const neverSnapshot = { snapshot: async () => assert.fail('published native profile must not be refreshed again') };
      assert.deepEqual(await publishPendingOnce({ authorityPool, source: neverSnapshot, expectedHqIdentity: hq }), []);
      assert.equal((await admin.query("SELECT count(*)::int n FROM public.member_profiles WHERE member_code LIKE 'AR000-%' AND stable='unchanged'")).rows[0].n, entries.length);
    });
    await t.test('slow publication never blocks next ingest, dispatch or caller-owned pools on stop', async () => {
      const item = await make(); let releaseSnapshot, started = false;
      const slow = { snapshot: () => { started = true; return new Promise(resolve => { releaseSnapshot = () => resolve(snapshots.get(item.assignment.assignmentId)); }); } };
      const r = runtime({ publishEnabled: true, snapshotSource: slow }); await r.tick(); await waitFor(() => started);
      const next = await make(); await r.tick();
      assert.equal((await q.getSourceCheckpoint()).assignmentId, next.assignment.assignmentId);
      releaseSnapshot(); await waitFor(async () => !(await r.status()).publicationRunning); await r.stop();
      assert.equal((await deliveryPool.query('SELECT 1 n')).rows[0].n, 1);
      assert.equal((await r.tick()), false);
    });
    await t.test('wrong configured HQ identity fails before dispatch', async () => {
      const wrong = new AssignmentQueue(deliveryPool, { expectedHqIdentity: 'wrong-owned-marker' });
      await assert.rejects(wrong.guard(), /SCHEMA_NOT_OWNED/);
    });
    await t.test('out-of-order source page is rejected before any authority write or cursor advance', async () => {
      const one = await make(), two = await make(); const before = await q.getSourceCheckpoint();
      const count = (await admin.query('SELECT count(*)::int n FROM sccrm_member_codes.assignments')).rows[0].n;
      await assert.rejects(ingestOnce({ authorityPool, queue: q, source: { read: async () => [two, one] }, expectedHqIdentity: hq }), /SOURCE_ASSIGNMENT_ORDER_REFUSED/);
      assert.equal((await admin.query('SELECT count(*)::int n FROM sccrm_member_codes.assignments')).rows[0].n, count);
      assert.deepEqual(await q.getSourceCheckpoint(), before);
    });
  } finally {
    for (const r of runtimes) await r.stop({ waitMs: 100 });
    await authorityPool.end(); await deliveryPool.end(); await admin.end();
  }
});
