'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const { AssignmentQueue, registerTarget, validateDeliveryJob, validateAssignedAck } = require('./queue.cjs');
const { assignmentHash, legacyScCodeFor, legacyScmCodeFor } = require('./assignment.cjs');
const { profileHash } = require('../fanout/engine.cjs');
const { record } = require('../history/model.cjs');
const raw = process.env.SCCRM_MEMBER_CODES_TEST_DATABASE_URL || process.env.SCCRM_FANOUT_TEST_DATABASE_URL;

test('parallel AR queue and scoped publication on an isolated real PostgreSQL database', { skip: !raw }, async t => {
  const configured = new URL(raw);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(configured.hostname));
  assert.match(configured.pathname.slice(1), /^sccrm_fanout_test_[a-z0-9_]+$/);
  assert.ok(configured.port && configured.port !== '5432');
  const nonce = crypto.randomBytes(5).toString('hex');
  const database = 'sccrm_fanout_test_codes_' + nonce;
  const bootstrap = new Pool({ connectionString: raw, ssl: false });
  await bootstrap.query('CREATE DATABASE ' + database);
  await bootstrap.end();
  configured.pathname = '/' + database;
  const admin = new Pool({ connectionString: configured.toString(), ssl: false, max: 5 });
  const role = 'sccrm_codes_delivery_' + nonce;
  const password = crypto.randomBytes(24).toString('hex');
  const hq = 'hq000/SERVER.SQLEXPRESS/AdaAcc/64fa3170-80ae-45ee-b9f3-7478b2a46e34';
  let runtime, authority, queue, number = 0;
  async function source({ kind = 'hq_create', previous = false, deliver = true, branch = '000' } = {}) {
    number++;
    const memberId = crypto.randomUUID(), assignmentId = crypto.randomUUID();
    const profile = { name: 'Synthetic COPY member ' + nonce + '-' + number, phone: '099' + String(number).padStart(7, '0'), email: 'copy-' + number + '@example.invalid' };
    const assignment = { version: 1, assignmentId, memberId, adaCode: 'AR' + branch + '-' + String(number).padStart(6, '0'),
      hqIdentity: hq, profileHash: profileHash(profile), assignedAt: new Date(Date.UTC(2026, 9, 29, 6, 46, number)).toISOString(), kind };
    const hash = assignmentHash(assignment, { expectedHqIdentity: hq, allowApprovedExisting: true });
    await admin.query(`INSERT INTO sccrm_member_codes.assignments(assignment_id,member_id,ada_code,hq_identity,profile_hash,profile,assigned_at,version,kind,assignment_hash,authority_reference,deliver_to_branches)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,1,$8,$9,'owned local test fixture',$10)`, [assignmentId, memberId, assignment.adaCode, hq, assignment.profileHash, JSON.stringify(profile), assignment.assignedAt, kind, hash, deliver]);
    await admin.query(`INSERT INTO sccrm_member_codes.canonical_codes(member_id,assignment_id,canonical_code,previous_native_code,publication_reference)
      VALUES($1,$2,$3,$4,'owned local test fixture')`, [memberId, assignmentId, assignment.adaCode, previous ? legacyScCodeFor(memberId) : null]);
    return { assignment, profile, hash };
  }
  function ack(job, change = {}) { return { memberId: job.member_id, assignmentId: job.assignment_id,
    assignmentHash: job.assignment_hash, hqCode: job.hq_code, adaCode: job.hq_code, targetIdentity: job.database_identity,
    profile: job.profile, profileHash: job.profile_hash, outcome: 'created', ...change }; }
  async function ready(id) { await admin.query("UPDATE sccrm_member_codes.jobs SET next_attempt_at=now()-interval '1s' WHERE assignment_id=$1", [id]); }
  function serialized(item, extra = {}) {
    const payload = { FTCstCode: item.assignment.adaCode, FTCstName: item.profile.name, FTCstTel: item.profile.phone,
      FTCstEmail: item.profile.email, FTBchCode: '000', FTCstStaActive: '1', ...extra };
    const r = record('customers', payload); return { source_key: r.key, owner_code: r.owner, parent_key: r.parent, payload_hash: r.payloadHash, payload };
  }
  async function publish(item) { return authority.query('SELECT * FROM sccrm_member_codes.publish_member_code($1)', [item.assignment.assignmentId]); }
  async function refresh(item, payload = serialized(item)) {
    return authority.query('SELECT sccrm_member_codes.refresh_assigned_customer($1,$2::jsonb,$3)', [item.assignment.assignmentId, JSON.stringify(payload), crypto.randomUUID()]);
  }
  try {
    await admin.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
    // Real mirror implementation, restricted to its customer path in this test.
    const history = fs.readFileSync(path.join(__dirname, '../live/schema.sql'), 'utf8').split('CREATE OR REPLACE VIEW ada_history.directory AS')[0];
    await admin.query(history);
    await admin.query("INSERT INTO ada_history.meta VALUES('ef76cc14-1b6b-49c9-8da7-1bfaea3dd92b','LIVE-HQ000-ADAACC')");
    await admin.query('CREATE TABLE public.member_profiles(user_id uuid PRIMARY KEY,member_code varchar(50) NOT NULL UNIQUE,is_active boolean DEFAULT true,unchanged_marker text DEFAULT \'preserve\'); CREATE TABLE public.original_customers(code text PRIMARY KEY,name text,phone text,points integer); INSERT INTO public.original_customers VALUES(\'AR004-000095\',\'Original profile\',\'0980000000\',12)');
    await admin.query(`CREATE ROLE ${role} LOGIN NOINHERIT PASSWORD '${password}'`);
    const exists = (await admin.query("SELECT 1 FROM pg_roles WHERE rolname='sccrm_hq_member_code_authority'")).rowCount;
    if (!exists) await admin.query('CREATE ROLE sccrm_hq_member_code_authority NOLOGIN NOINHERIT');
    await admin.query(`GRANT USAGE ON SCHEMA sccrm_member_codes TO ${role},sccrm_hq_member_code_authority;GRANT SELECT ON ALL TABLES IN SCHEMA sccrm_member_codes TO ${role};GRANT USAGE ON ALL SEQUENCES IN SCHEMA sccrm_member_codes TO ${role};
      GRANT INSERT ON sccrm_member_codes.jobs,sccrm_member_codes.mappings,sccrm_member_codes.events TO ${role};
      GRANT UPDATE(lease_token,lease_owner,lease_until) ON sccrm_member_codes.targets TO ${role};
      GRANT UPDATE(state,attempt_count,next_attempt_at,lease_token,lease_owner,lease_until,last_code,updated_at,completed_at) ON sccrm_member_codes.jobs TO ${role};
      GRANT UPDATE(created_at,assignment_id,updated_at) ON sccrm_member_codes.source_checkpoint TO ${role};
      GRANT EXECUTE ON FUNCTION sccrm_member_codes.publish_member_code(uuid),sccrm_member_codes.refresh_assigned_customer(uuid,jsonb,uuid) TO sccrm_hq_member_code_authority`);
    const tables = (await admin.query("SELECT tablename FROM pg_tables WHERE schemaname='sccrm_member_codes'")).rows;
    for (const row of tables) await admin.query(`CREATE POLICY dedicated_test_delivery ON sccrm_member_codes.${row.tablename} TO ${role} USING(true) WITH CHECK(true)`);
    const runtimeUrl = new URL(configured); runtimeUrl.username = role; runtimeUrl.password = password;
    runtime = new Pool({ connectionString: runtimeUrl.toString(), ssl: false, max: 5 });
    authority = await admin.connect(); await authority.query('SET SESSION AUTHORIZATION sccrm_hq_member_code_authority');
    queue = new AssignmentQueue(runtime, { expectedHqIdentity: hq }); await queue.guard();
    for (const branch of ['005', '001']) {
      await registerTarget(admin, { targetId: 'branch' + branch, branchCode: branch, databaseIdentity: 'owned-copy/' + branch });
      await admin.query('UPDATE sccrm_member_codes.targets SET enabled=true WHERE target_id=$1', ['branch' + branch]);
    }
    await t.test('runtime cannot create authority, change aliases/mapping identities, publish, or touch old data', async () => {
      const rights = (await runtime.query(`SELECT has_table_privilege(current_user,'sccrm_member_codes.assignments','INSERT') assignment_insert,
        has_table_privilege(current_user,'sccrm_member_codes.canonical_codes','INSERT') canonical_insert,
        has_table_privilege(current_user,'sccrm_member_codes.aliases','UPDATE') alias_update,
        has_table_privilege(current_user,'public.member_profiles','UPDATE') profile_update,
        has_function_privilege(current_user,'sccrm_member_codes.publish_member_code(uuid)','EXECUTE') publish,
        has_function_privilege(current_user,'sccrm_member_codes.refresh_assigned_customer(uuid,jsonb,uuid)','EXECUTE') refresh`)).rows[0];
      assert.ok(Object.values(rights).every(value => value === false));
      const exposed = (await admin.query("SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='sccrm_member_codes' AND c.relkind='r' AND NOT c.relrowsecurity")).rows;
      assert.equal(exposed.length, 0);
    });
    await t.test('authority-backed new assignment delivers twice without duplicate mapping or jobs', async () => {
      const item = await source(); await queue.enqueueAssignment(item.assignment.assignmentId); await queue.enqueueAssignment(item.assignment.assignmentId);
      for (const target of ['branch005', 'branch001']) { const job = await queue.lease(target, crypto.randomUUID()); validateDeliveryJob(job, { expectedHqIdentity: hq }); assert.equal(await queue.succeeded(job, ack(job)), true); }
      assert.equal((await admin.query('SELECT count(*)::int n FROM sccrm_member_codes.jobs WHERE assignment_id=$1', [item.assignment.assignmentId])).rows[0].n, 2);
      assert.equal((await admin.query('SELECT count(*)::int n FROM sccrm_member_codes.mappings WHERE assignment_id=$1', [item.assignment.assignmentId])).rows[0].n, 2);
    });
    await t.test('unapproved and swapped assignment ACK cannot settle another identity', async () => {
      const item = await source(); await queue.enqueueAssignment(item.assignment.assignmentId, ['branch005']); const job = await queue.lease('branch005', crypto.randomUUID());
      for (const change of [{ assignmentId: crypto.randomUUID() }, { assignmentHash: 'f'.repeat(64) }, { memberId: crypto.randomUUID() }, { adaCode: 'AR000-999999' }, { targetIdentity: 'other' }, { profileHash: 'f'.repeat(64) }]) {
        assert.throws(() => validateAssignedAck(job, ack(job, change), { expectedHqIdentity: hq }));
      }
      assert.equal(await queue.succeeded(job, ack(job)), true);
      await assert.rejects(queue.enqueueAssignment(crypto.randomUUID()), /ASSIGNMENT_AUTHORITY_NOT_FOUND/);
    });
    await t.test('lost ACK and fresh connection restart persist one final mapping', async () => {
      const item = await source(); await queue.enqueueAssignment(item.assignment.assignmentId, ['branch005']);
      const first = await queue.lease('branch005', crypto.randomUUID()); const committed = new Map([[item.assignment.memberId, first.hq_code]]);
      await queue.failed(first, Object.assign(Error('ECONNRESET'), { code: 'ECONNRESET' })); await ready(item.assignment.assignmentId);
      await runtime.end(); runtime = new Pool({ connectionString: runtimeUrl.toString(), ssl: false, max: 5 }); queue = new AssignmentQueue(runtime, { expectedHqIdentity: hq });
      const retried = await queue.lease('branch005', crypto.randomUUID()); assert.equal(retried.attempt_count, 2); assert.equal(committed.get(retried.member_id), retried.hq_code);
      assert.equal(await queue.succeeded(retried, ack(retried, { outcome: 'already_delivered' })), true);
      assert.equal((await admin.query('SELECT count(*)::int n FROM sccrm_member_codes.mappings WHERE assignment_id=$1', [item.assignment.assignmentId])).rows[0].n, 1);
    });
    await t.test('offline target cannot block online target and reconnect retains same code', async () => {
      const item = await source(); await queue.enqueueAssignment(item.assignment.assignmentId);
      const offline = await queue.lease('branch001', crypto.randomUUID()); await queue.failed(offline, Object.assign(Error('TARGET_OFFLINE'), { code: 'TARGET_OFFLINE' }));
      const online = await queue.lease('branch005', crypto.randomUUID()); await queue.succeeded(online, ack(online));
      await ready(item.assignment.assignmentId); const recovered = await queue.lease('branch001', crypto.randomUUID()); await queue.succeeded(recovered, ack(recovered));
      assert.equal(online.hq_code, recovered.hq_code);
    });
    await t.test('expired leases are fenced against delayed acknowledgements', async () => {
      const item = await source(); await queue.enqueueAssignment(item.assignment.assignmentId, ['branch005']);
      const stale = await queue.lease('branch005', crypto.randomUUID(), 2000);
      await admin.query("UPDATE sccrm_member_codes.jobs SET lease_until=now()-interval '1s' WHERE id=$1", [stale.id]);
      await admin.query("UPDATE sccrm_member_codes.targets SET lease_until=now()-interval '1s' WHERE target_id='branch005'");
      const owner = await queue.lease('branch005', crypto.randomUUID()); assert.notEqual(stale.lease_token, owner.lease_token);
      assert.equal(await queue.succeeded(stale, ack(stale)), false); assert.equal(await queue.succeeded(owner, ack(owner)), true);
    });
    await t.test('conflicts are held and never automatically retried', async () => {
      const item = await source({ previous: true, kind: 'approved_existing' }); await queue.enqueueAssignment(item.assignment.assignmentId, ['branch005']);
      const job = await queue.lease('branch005', crypto.randomUUID()); assert.equal(job.previous_native_code, legacyScCodeFor(job.member_id));
      await queue.failed(job, Object.assign(Error('AR_NATIVE_CODE_COLLISION_REVIEW'), { code: 'AR_NATIVE_CODE_COLLISION_REVIEW' }));
      assert.equal(await queue.lease('branch005', crypto.randomUUID()), null);
    });
    await t.test('publish-only approved legacy customer can never enter branch jobs', async () => {
      const item = await source({ kind: 'approved_existing', branch: '004', deliver: false });
      assert.deepEqual(await queue.enqueueAssignment(item.assignment.assignmentId), []);
      await queue.enqueueExistingForTarget('branch001');
      assert.equal((await admin.query('SELECT count(*)::int n FROM sccrm_member_codes.jobs WHERE assignment_id=$1', [item.assignment.assignmentId])).rows[0].n, 0);
    });
    await t.test('disabled branch backfill, bounded repeat and independent checkpoint survive restart', async () => {
      await admin.query("UPDATE sccrm_member_codes.targets SET enabled=false WHERE target_id='branch001'");
      const item = await source(); await queue.enqueueAssignment(item.assignment.assignmentId);
      await queue.advanceSourceCheckpoint({ createdAt: item.assignment.assignedAt, assignmentId: item.assignment.assignmentId });
      assert.deepEqual(await queue.getSourceCheckpoint(), { createdAt: item.assignment.assignedAt, assignmentId: item.assignment.assignmentId });
      await assert.rejects(queue.advanceSourceCheckpoint({ createdAt: item.assignment.assignedAt, assignmentId: crypto.randomUUID() }), /CURSOR_NOT_PERSISTED/);
      await admin.query("UPDATE sccrm_member_codes.targets SET enabled=true WHERE target_id='branch001'");
      await queue.enqueueExistingForTarget('branch001', { limit: 1 }); await queue.enqueueExistingForTarget('branch001');
      assert.deepEqual(await queue.enqueueExistingForTarget('branch001'), []);
      assert.equal((await admin.query("SELECT count(*)::int n FROM sccrm_member_codes.jobs WHERE target_id='branch001' AND assignment_id=$1", [item.assignment.assignmentId])).rows[0].n, 1);
    });
    await t.test('public code remains pending until exact native mirror ownership exists', async () => {
      const item = await source({ deliver: false }); const old = legacyScmCodeFor(item.assignment.memberId);
      await admin.query('INSERT INTO public.member_profiles(user_id,member_code) VALUES($1,$2)', [item.assignment.memberId, old]);
      assert.equal((await publish(item)).rows[0].state, 'pending-native-link');
      assert.equal((await admin.query('SELECT member_code FROM public.member_profiles WHERE user_id=$1', [item.assignment.memberId])).rows[0].member_code, old);
      await refresh(item); assert.equal((await publish(item)).rows[0].state, 'published'); assert.equal((await publish(item)).rows[0].state, 'already-published');
      const profile = (await admin.query('SELECT * FROM public.member_profiles WHERE user_id=$1', [item.assignment.memberId])).rows[0];
      assert.equal(profile.member_code, item.assignment.adaCode); assert.equal(profile.unchanged_marker, 'preserve');
      const alias = (await admin.query('SELECT code,member_id FROM sccrm_member_codes.aliases WHERE code=$1', [old])).rows[0]; assert.equal(alias.member_id, item.assignment.memberId);
    });
    await t.test('targeted mirror wrapper rejects wrong owner, wrong profile, secret/nested payload and a different record kind', async () => {
      const item = await source({ deliver: false });
      for (const extra of [{ FTCstCode: 'AR000-999999' }, { FTCstName: 'Other person' }, { FTCstTel: '0981234567' }, { FTCstPin: 'forbidden fixture' }, { Extra: { hidden: true } }, { Binary: [256] }]) {
        // Never call record() for secret keys: the wrapper must also reject an independently supplied packet.
        const row = serialized(item); Object.assign(row.payload, extra);
        await assert.rejects(refresh(item, row), /ASSIGNED_CUSTOMER_PROFILE_MISMATCH/);
      }
      const row = serialized(item); row.source_key = 'not-a-customer'; await assert.rejects(refresh(item, row), /PROFILE_MISMATCH/);
      const bytePayload = serialized(item, { Binary: [0, 128, 255] }); await refresh(item, bytePayload);
      const id = crypto.randomUUID();
      await admin.query("INSERT INTO ada_history.customers(source_id,ada_code,name,source_payload,payload_hash,source_snapshot) VALUES('hq000/AdaAcc',$1,'other','{}',$2,$3)", ['AR000-999998', 'f'.repeat(64), id]);
      await assert.rejects(runtime.query('SELECT sccrm_member_codes.refresh_assigned_customer($1,$2::jsonb,$3)', [item.assignment.assignmentId, JSON.stringify(serialized(item)), id]), /permission denied/);
    });
    await t.test('authority capability cannot invoke generic mirror DML and owner cannot bypass actor check', async () => {
      const rights = (await admin.query("SELECT has_function_privilege('sccrm_hq_member_code_authority','ada_history.apply_batch(text,text,text,jsonb,uuid,text)','EXECUTE') generic_apply,has_table_privilege('sccrm_hq_member_code_authority','public.member_profiles','UPDATE') profile_update")).rows[0];
      assert.equal(rights.generic_apply, false); assert.equal(rights.profile_update, false);
      await assert.rejects(admin.query('SELECT * FROM sccrm_member_codes.publish_member_code($1)', [crypto.randomUUID()]), /ACTOR_REFUSED/);
    });
    await t.test('existing mirror owner or profile conflict is held without reassignment or overwrite', async () => {
      const item = await source({ deliver: false }); const packet = serialized(item), wrongOwner = crypto.randomUUID();
      await admin.query("SELECT ada_history.apply_batch('ef76cc14-1b6b-49c9-8da7-1bfaea3dd92b','LIVE-HQ000-ADAACC','customers',$1::jsonb,$2,$3)", [JSON.stringify([packet]), crypto.randomUUID(), item.assignment.adaCode]);
      await admin.query("INSERT INTO ada_history.member_links VALUES($1,'hq000/AdaAcc',$2,'deliberate local conflict fixture')", [wrongOwner, item.assignment.adaCode]);
      await assert.rejects(refresh(item), /MIRROR_OWNER_MISMATCH/);
      assert.equal((await admin.query('SELECT member_id FROM ada_history.member_links WHERE ada_code=$1', [item.assignment.adaCode])).rows[0].member_id, wrongOwner);
      const different = await source({ deliver: false });
      const changed = serialized(different, { FTCstName: 'Existing unrelated copied profile' });
      await admin.query("SELECT ada_history.apply_batch('ef76cc14-1b6b-49c9-8da7-1bfaea3dd92b','LIVE-HQ000-ADAACC','customers',$1::jsonb,$2,$3)", [JSON.stringify([changed]), crypto.randomUUID(), different.assignment.adaCode]);
      await assert.rejects(refresh(different), /MIRROR_PROFILE_CONFLICT/);
      assert.equal((await admin.query('SELECT name FROM ada_history.customers WHERE ada_code=$1', [different.assignment.adaCode])).rows[0].name, changed.payload.FTCstName);
    });
    await t.test('public code collision rolls back publication and leaves former code unchanged', async () => {
      const item = await source({ deliver: false }), old = legacyScmCodeFor(item.assignment.memberId);
      await refresh(item); await admin.query('INSERT INTO public.member_profiles(user_id,member_code) VALUES($1,$2),($3,$4)', [item.assignment.memberId, old, crypto.randomUUID(), item.assignment.adaCode]);
      await assert.rejects(publish(item), /CANONICAL_PUBLIC_CODE_COLLISION/);
      assert.equal((await admin.query('SELECT member_code FROM public.member_profiles WHERE user_id=$1', [item.assignment.memberId])).rows[0].member_code, old);
      assert.equal((await admin.query('SELECT count(*)::int n FROM sccrm_member_codes.aliases WHERE member_id=$1', [item.assignment.memberId])).rows[0].n, 0);
    });
    await t.test('authority and legacy data remain immutable across every operation', async () => {
      const item = await source(); await assert.rejects(admin.query('UPDATE sccrm_member_codes.assignments SET deliver_to_branches=false WHERE assignment_id=$1', [item.assignment.assignmentId]), /RECORD_IMMUTABLE/);
      await assert.rejects(admin.query('DELETE FROM sccrm_member_codes.mappings'), /RECORD_IMMUTABLE/);
      assert.deepEqual((await admin.query('SELECT * FROM public.original_customers')).rows, [{ code: 'AR004-000095', name: 'Original profile', phone: '0980000000', points: 12 }]);
      assert.equal((await admin.query("SELECT to_regnamespace('sccrm_fanout') name")).rows[0].name, null);
    });
  } finally {
    if (authority) { await authority.query('RESET SESSION AUTHORIZATION').catch(() => {}); authority.release(); }
    if (runtime) await runtime.end(); await admin.end();
  }
});
