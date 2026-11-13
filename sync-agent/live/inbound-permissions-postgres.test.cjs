'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { Client } = require('pg');
const { apply, MARKER, SCOPE } = require('./worker.cjs');
const { record } = require('../history/model.cjs');
const raw = process.env.SCCRM_INBOUND_TEST_DATABASE_URL;

test('restricted inbound customer updates survive the private expression-index normalizer', { skip: !raw }, async () => {
 const url = new URL(raw);
 assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Local DB only');
 assert.match(url.pathname, /^\/sccrm_inbound_test_[a-z0-9_]+$/);
 assert.ok(url.port && url.port !== '5432', 'Explicit isolated test port required');
 const admin = new Client({ connectionString: raw, ssl: false });
 const workerUrl = new URL(raw); workerUrl.username = 'sccrm_hq_live_sync'; workerUrl.password = 'inbound-local-fixture';
 const worker = new Client({ connectionString: workerUrl.href, ssl: false });
 try {
  await admin.connect();
  assert.equal((await admin.query("SELECT to_regnamespace('ada_history') n")).rows[0].n, null, 'Fresh database required');
  await admin.query(`CREATE ROLE sccrm_hq_live_sync LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD 'inbound-local-fixture';
   CREATE ROLE inbound_other NOLOGIN;
   CREATE TABLE public.users(id uuid PRIMARY KEY,full_name text,phone_number text);
   CREATE TABLE public.member_profiles(user_id uuid,member_code text,is_active boolean,created_at timestamptz);
   CREATE TABLE public.loyalty_claims(branch_code text,receipt_no text);
   CREATE TABLE public.native_points(member_id uuid,points integer);`);
  await admin.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  const original = fs.readFileSync(path.join(__dirname, '../../supabase/migrations/20261103035705_hq_member_fast_existing_links.sql'), 'utf8');
  await admin.query(original.slice(0, original.indexOf('CREATE FUNCTION ada_history.local_member_phone')));
  await admin.query(`REVOKE ALL ON FUNCTION ada_history.member_name_key(text) FROM PUBLIC;
   CREATE INDEX history_customer_active_name_lookup ON ada_history.customers(source_id,ada_history.member_name_key(name)) WHERE active='1';
   GRANT USAGE ON SCHEMA ada_history TO sccrm_hq_live_sync,inbound_other;
   GRANT SELECT ON ALL TABLES IN SCHEMA ada_history TO sccrm_hq_live_sync;
   GRANT INSERT,UPDATE ON ada_history.customers,ada_history.checkpoints TO sccrm_hq_live_sync;
   GRANT INSERT ON ada_history.change_journal TO sccrm_hq_live_sync;
   GRANT USAGE ON ALL SEQUENCES IN SCHEMA ada_history TO sccrm_hq_live_sync;
   GRANT EXECUTE ON FUNCTION ada_history.apply_batch(text,text,text,jsonb,uuid,text) TO sccrm_hq_live_sync;`);
  await admin.query('INSERT INTO ada_history.meta VALUES($1,$2)', [MARKER, SCOPE]);
  await worker.connect();
  const snapshot = '11223344-0000-4000-8000-000000000001';
  const payload = { FTCstCode: 'AR001-000001', FTCstName: 'Synthetic member', FTCstStaActive: '1', FTBchCode: '001' };
  await assert.rejects(apply(worker, 'customers', [record('customers', payload)], snapshot, payload.FTCstCode), { code: '42501' });
  assert.equal((await admin.query('SELECT count(*)::int n FROM ada_history.customers')).rows[0].n, 0);
  const migration = fs.readFileSync(path.join(__dirname, '../../supabase/migrations/20261113030332_ada_inbound_name_index_permission.sql'), 'utf8');
  await admin.query(migration); await admin.query(migration);
  assert.equal(await apply(worker, 'customers', [record('customers', payload)], snapshot, payload.FTCstCode), 1);
  assert.equal(await apply(worker, 'customers', [record('customers', payload)], snapshot, payload.FTCstCode), 0);
  payload.FTCstName = 'Synthetic renamed member';
  assert.equal(await apply(worker, 'customers', [record('customers', payload)], snapshot, payload.FTCstCode), 1);
  assert.equal((await admin.query('SELECT name FROM ada_history.customers')).rows[0].name, payload.FTCstName);
  assert.deepEqual((await admin.query(`SELECT
   has_function_privilege('sccrm_hq_live_sync','ada_history.member_name_key(text)','EXECUTE') worker,
   has_function_privilege('inbound_other','ada_history.member_name_key(text)','EXECUTE') other,
   has_table_privilege('sccrm_hq_live_sync','public.users','INSERT') users_insert,
   has_table_privilege('sccrm_hq_live_sync','public.native_points','UPDATE') points_update,
   (SELECT prosecdef FROM pg_proc WHERE oid='ada_history.member_name_key(text)'::regprocedure) security_definer`)).rows[0],
   { worker: true, other: false, users_insert: false, points_update: false, security_definer: false });
 } finally { await Promise.allSettled([worker.end(), admin.end()]); }
});
