'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { MARKER, SCOPE } = require('./assignment.cjs');
const { MARKER: FANOUT_MARKER } = require('../fanout/engine.cjs');
const AUTHORITY_ROLE = 'sccrm_hq_member_code_authority';
const DELIVERY_ROLE = 'sccrm_hq_member_fanout';
const TABLES = Object.freeze(['meta', 'assignments', 'canonical_codes', 'aliases', 'migration_events',
  'publication_events', 'targets', 'jobs', 'mappings', 'events', 'source_checkpoint']);
const AUTHORITY_INSERT = new Set(['assignments', 'canonical_codes', 'aliases', 'migration_events']);
const DELIVERY_INSERT = new Set(['jobs', 'mappings', 'events']);
const DELIVERY_UPDATE = Object.freeze({
  targets: ['lease_token', 'lease_owner', 'lease_until'],
  jobs: ['state', 'attempt_count', 'next_attempt_at', 'lease_token', 'lease_owner', 'lease_until',
    'last_code', 'updated_at', 'completed_at'],
  source_checkpoint: ['created_at', 'assignment_id', 'updated_at'],
});
const AUTHORITY_FUNCTIONS = Object.freeze(['publish_member_code(uuid)', 'refresh_assigned_customer(uuid,jsonb,uuid)']);
const COMMENTS = Object.freeze({
  [AUTHORITY_ROLE]: 'SCCRM dedicated member code authority ' + MARKER,
  [DELIVERY_ROLE]: 'SCCRM dedicated member fanout ' + FANOUT_MARKER,
});
function fail(code) { throw Object.assign(new Error(code), { code }); }
function identifier(value) {
  if (typeof value !== 'string' || !/^[a-z_][a-z0-9_]{0,62}$/.test(value)) fail('CODE_ROLE_IDENTIFIER_REFUSED');
  return '"' + value + '"';
}
async function connection(admin) {
  if (!admin || typeof admin.query !== 'function') fail('CODE_ROLE_ADMIN_REQUIRED');
  // Pin a Pool transaction to one client. Already checked-out clients remain
  // caller-owned; no pool or service is closed by this module.
  if (typeof admin.totalCount === 'number' && typeof admin.connect === 'function') {
    const client = await admin.connect(); return { client, release: () => client.release() };
  }
  return { client: admin, release() {} };
}
async function ownedRole(admin, role, { password, mayCreate = false } = {}) {
  const name = identifier(role);
  const row = (await admin.query(`SELECT r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolreplication,r.rolbypassrls,
    r.rolinherit,r.rolcanlogin,r.rolconnlimit,shobj_description(r.oid,'pg_authid') description,
    EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid) has_membership
    FROM pg_roles r WHERE r.rolname=$1`, [role])).rows[0];
  if (row) {
    if (row.description !== COMMENTS[role]) fail('CODE_ROLE_OWNERSHIP_COLLISION');
    if (row.rolsuper || row.rolcreatedb || row.rolcreaterole || row.rolreplication || row.rolbypassrls
      || row.rolinherit || !row.rolcanlogin || row.has_membership
      || row.rolconnlimit !== (role === AUTHORITY_ROLE ? 6 : 8)) fail('CODE_ROLE_ATTRIBUTES_REFUSED');
    // In particular, do not rotate the existing delivery or authority secret:
    // these cluster-wide identities may already be used by another database.
    return false;
  }
  if (!mayCreate || role !== AUTHORITY_ROLE) fail('OWNED_DELIVERY_ROLE_REQUIRED');
  await admin.query(`CREATE ROLE ${name} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
    NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 6 PASSWORD '${password}'`);
  await admin.query(`COMMENT ON ROLE ${name} IS '${COMMENTS[role]}'`);
  await admin.query(`ALTER ROLE ${name} SET statement_timeout='8s';
    ALTER ROLE ${name} SET lock_timeout='1s';
    ALTER ROLE ${name} SET idle_in_transaction_session_timeout='15s'`);
  return true;
}
async function policy(admin, table, role, operation) {
  const name = 'member_codes_' + (role === AUTHORITY_ROLE ? 'authority_' : 'delivery_') + operation.toLowerCase();
  const previous = (await admin.query(`SELECT cmd,roles::text[] roles,qual,with_check FROM pg_policies
    WHERE schemaname='sccrm_member_codes' AND tablename=$1 AND policyname=$2`, [table, name])).rows[0];
  const update = operation === 'UPDATE', insert = operation === 'INSERT';
  if (previous) {
    if (previous.cmd !== operation || previous.roles.length !== 1 || previous.roles[0] !== role
      || previous.qual !== (insert ? null : 'true')
      || previous.with_check !== (insert || update ? 'true' : null)) fail('CODE_ROLE_POLICY_COLLISION');
    return;
  }
  await admin.query(`CREATE POLICY ${identifier(name)} ON sccrm_member_codes.${identifier(table)}
    FOR ${operation} TO ${identifier(role)} ${insert ? '' : 'USING(true)'}
    ${insert || update ? 'WITH CHECK(true)' : ''}`);
}
async function provisionCodeRoles(admin, { authorityPassword, expectedHqIdentity } = {}) {
  if (typeof authorityPassword !== 'string' || !/^[a-f0-9]{64}$/.test(authorityPassword)) fail('CODE_AUTHORITY_PASSWORD_FORMAT_REFUSED');
  if (typeof expectedHqIdentity !== 'string' || !expectedHqIdentity.length || expectedHqIdentity.length > 160
    || expectedHqIdentity.trim() !== expectedHqIdentity || /[\x00-\x1f\x7f]/.test(expectedHqIdentity)) fail('HQ_AUTHORITY_CONFIG_REQUIRED');
  const { client: c, release } = await connection(admin);
  try {
    await c.query('BEGIN');
    await c.query("SET LOCAL lock_timeout='1s';SET LOCAL statement_timeout='15s'");
    const previousSchema = (await c.query("SELECT to_regnamespace('sccrm_member_codes') IS NOT NULL present")).rows[0].present;
    await ownedRole(c, DELIVERY_ROLE);
    const created = await ownedRole(c, AUTHORITY_ROLE, { password: authorityPassword, mayCreate: true });
    await c.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
    const meta = (await c.query('SELECT marker,scope,schema_version,expected_hq_identity FROM sccrm_member_codes.meta')).rows;
    if (meta.length !== 1 || meta[0].marker !== MARKER || meta[0].scope !== SCOPE || meta[0].schema_version !== 1) fail('CODE_AUTHORITY_SCHEMA_NOT_OWNED');
    if (meta[0].expected_hq_identity !== expectedHqIdentity) {
      if (previousSchema || (await c.query('SELECT 1 FROM sccrm_member_codes.assignments LIMIT 1')).rowCount) fail('CODE_AUTHORITY_HQ_IDENTITY_COLLISION');
      await c.query('UPDATE sccrm_member_codes.meta SET expected_hq_identity=$1 WHERE singleton=true', [expectedHqIdentity]);
    }
    const tables = (await c.query("SELECT tablename FROM pg_tables WHERE schemaname='sccrm_member_codes' ORDER BY tablename")).rows.map(r => r.tablename);
    if (tables.join(',') !== [...TABLES].sort().join(',')) fail('CODE_AUTHORITY_TABLE_SCOPE_REFUSED');
    const roles = [AUTHORITY_ROLE, DELIVERY_ROLE].map(identifier).join(',');
    await c.query(`REVOKE ALL ON SCHEMA sccrm_member_codes FROM ${roles};
      REVOKE ALL ON ALL TABLES IN SCHEMA sccrm_member_codes FROM ${roles};
      REVOKE ALL ON ALL SEQUENCES IN SCHEMA sccrm_member_codes FROM ${roles};
      REVOKE ALL ON ALL FUNCTIONS IN SCHEMA sccrm_member_codes FROM ${roles};
      GRANT USAGE ON SCHEMA sccrm_member_codes TO ${roles}`);
    for (const table of TABLES) {
      const columns = (await c.query(`SELECT a.attname FROM pg_attribute a
        WHERE a.attrelid=$1::regclass AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`, ['sccrm_member_codes.' + table])).rows.map(r => identifier(r.attname)).join(',');
      await c.query(`REVOKE ALL (${columns}) ON sccrm_member_codes.${identifier(table)} FROM ${roles};
        GRANT SELECT ON sccrm_member_codes.${identifier(table)} TO ${roles};
        ALTER TABLE sccrm_member_codes.${identifier(table)} ENABLE ROW LEVEL SECURITY`);
      for (const role of [AUTHORITY_ROLE, DELIVERY_ROLE]) {
        await policy(c, table, role, 'SELECT');
        if ((role === AUTHORITY_ROLE ? AUTHORITY_INSERT : DELIVERY_INSERT).has(table)) {
          await c.query(`GRANT INSERT ON sccrm_member_codes.${identifier(table)} TO ${identifier(role)}`);
          await policy(c, table, role, 'INSERT');
        }
      }
      if (DELIVERY_UPDATE[table]) {
        await c.query(`GRANT UPDATE(${DELIVERY_UPDATE[table].map(identifier).join(',')})
          ON sccrm_member_codes.${identifier(table)} TO ${identifier(DELIVERY_ROLE)}`);
        await policy(c, table, DELIVERY_ROLE, 'UPDATE');
      }
    }
    await c.query(`GRANT USAGE ON SEQUENCE sccrm_member_codes.jobs_id_seq,sccrm_member_codes.events_id_seq TO ${identifier(DELIVERY_ROLE)};
      GRANT EXECUTE ON FUNCTION ${AUTHORITY_FUNCTIONS.map(f => 'sccrm_member_codes.' + f).join(',')}
      TO ${identifier(AUTHORITY_ROLE)}`);
    await c.query('COMMIT');
    return { ok: true, marker: MARKER, authorityRole: AUTHORITY_ROLE, deliveryRole: DELIVERY_ROLE,
      authorityCreated: created, existingPasswordsChanged: false, privateTables: TABLES.length,
      expectedHqIdentity, customerDataWrites: 0 };
  } catch (error) {
    await c.query('ROLLBACK').catch(() => {});
    if (/^(CODE_|HQ_AUTHORITY_|OWNED_DELIVERY_)/.test(error.code || '')) throw error;
    throw Object.assign(new Error('CODE_ROLE_PROVISION_FAILED'), { code: 'CODE_ROLE_PROVISION_FAILED',
      databaseCode: /^[A-Z0-9]{5}$/.test(error.code || '') ? error.code : undefined });
  } finally { release(); }
}

async function checkRights(pool, { role } = {}) {
  if (![AUTHORITY_ROLE, DELIVERY_ROLE].includes(role)) fail('CODE_RUNTIME_ROLE_REFUSED');
  const errors = [], requireRight = (ok, label) => { if (!ok) errors.push(label); };
  let checks = 0;
  const check = (ok, label) => { checks++; requireRight(ok, label); };
  const actor = (await pool.query(`SELECT current_user actor,r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolreplication,
    r.rolbypassrls,r.rolinherit,r.rolcanlogin,r.rolconnlimit,shobj_description(r.oid,'pg_authid') description,
    EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid) has_membership
    FROM pg_roles r WHERE r.rolname=current_user`)).rows[0];
  check(actor && actor.actor === role && actor.description === COMMENTS[role], 'ROLE_IDENTITY');
  check(actor && !actor.rolsuper && !actor.rolcreatedb && !actor.rolcreaterole && !actor.rolreplication
    && !actor.rolbypassrls && !actor.rolinherit && actor.rolcanlogin && !actor.has_membership
    && actor.rolconnlimit === (role === AUTHORITY_ROLE ? 6 : 8), 'ROLE_ATTRIBUTES');
  const schemaRights = (await pool.query(`SELECT n.nspname,
    has_schema_privilege(current_user,n.oid,'CREATE') can_create,
    has_schema_privilege(current_user,n.oid,'USAGE') can_use
    FROM pg_namespace n WHERE n.nspname IN('public','ada_history','sccrm_member_codes')`)).rows;
  for (const row of schemaRights) {
    check(row.can_create === false, row.nspname + '.CREATE');
    if (row.nspname === 'sccrm_member_codes') check(row.can_use === true, 'PRIVATE_USAGE');
  }
  const tables = (await pool.query(`SELECT c.oid,c.relname,c.relrowsecurity,
    has_table_privilege(current_user,c.oid,'SELECT') can_select,
    has_table_privilege(current_user,c.oid,'INSERT') can_insert,
    has_any_column_privilege(current_user,c.oid,'INSERT') can_insert_columns,
    has_table_privilege(current_user,c.oid,'DELETE') can_delete,
    has_table_privilege(current_user,c.oid,'TRUNCATE') can_truncate,
    has_table_privilege(current_user,c.oid,'TRIGGER') can_trigger,
    has_table_privilege(current_user,c.oid,'REFERENCES') can_reference,
    c.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) owns_table
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='sccrm_member_codes' AND c.relkind='r' ORDER BY c.relname`)).rows;
  check(tables.map(t => t.relname).join(',') === [...TABLES].sort().join(','), 'PRIVATE_TABLE_SCOPE');
  const allowedInsert = role === AUTHORITY_ROLE ? AUTHORITY_INSERT : DELIVERY_INSERT;
  for (const row of tables) {
    check(row.relrowsecurity && !row.owns_table, row.relname + '.RLS_OWNER');
    check(row.can_select && row.can_insert === allowedInsert.has(row.relname)
      && row.can_insert_columns === allowedInsert.has(row.relname)
      && !row.can_delete && !row.can_truncate && !row.can_trigger && !row.can_reference, row.relname + '.TABLE_DML');
  }
  const columns = (await pool.query(`SELECT c.relname,a.attname,
    has_column_privilege(current_user,c.oid,a.attname,'UPDATE') can_update
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
    WHERE n.nspname='sccrm_member_codes' AND c.relkind='r'`)).rows;
  for (const row of columns) check(row.can_update === (role === DELIVERY_ROLE
    && (DELIVERY_UPDATE[row.relname] || []).includes(row.attname)), row.relname + '.' + row.attname + '.UPDATE');
  const sequences = (await pool.query(`SELECT c.relname,has_sequence_privilege(current_user,c.oid,'USAGE') can_use,
    has_sequence_privilege(current_user,c.oid,'SELECT') can_select,
    has_sequence_privilege(current_user,c.oid,'UPDATE') can_update
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='sccrm_member_codes' AND c.relkind='S'`)).rows;
  for (const row of sequences) check(row.can_use === (role === DELIVERY_ROLE && ['jobs_id_seq','events_id_seq'].includes(row.relname))
    && !row.can_select && !row.can_update, row.relname + '.SEQUENCE');
  const functions = (await pool.query(`SELECT p.proname,oidvectortypes(p.proargtypes) args,
    has_function_privilege(current_user,p.oid,'EXECUTE') can_execute
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='sccrm_member_codes'`)).rows;
  for (const row of functions) check(row.can_execute === (role === AUTHORITY_ROLE
    && AUTHORITY_FUNCTIONS.includes(row.proname + '(' + row.args.replaceAll(' ', '') + ')')), row.proname + '.EXECUTE');
  const policies = (await pool.query(`SELECT tablename,policyname,cmd,roles::text[] roles,qual,with_check
    FROM pg_policies WHERE schemaname='sccrm_member_codes'`)).rows;
  for (const table of TABLES) {
    const commands = ['SELECT', ...(allowedInsert.has(table) ? ['INSERT'] : []),
      ...(role === DELIVERY_ROLE && DELIVERY_UPDATE[table] ? ['UPDATE'] : [])];
    for (const cmd of commands) {
      const name = 'member_codes_' + (role === AUTHORITY_ROLE ? 'authority_' : 'delivery_') + cmd.toLowerCase();
      const found = policies.find(p => p.tablename === table && p.policyname === name);
      check(found && found.cmd === cmd && found.roles.length === 1 && found.roles[0] === role
        && found.qual === (cmd === 'INSERT' ? null : 'true')
        && found.with_check === (cmd === 'SELECT' ? null : 'true'), table + '.' + cmd + '.POLICY');
    }
  }
  const external = (await pool.query(`SELECT n.nspname,c.relname,
    has_table_privilege(current_user,c.oid,'INSERT') can_insert,
    has_any_column_privilege(current_user,c.oid,'UPDATE') can_update,
    has_table_privilege(current_user,c.oid,'DELETE') can_delete,
    has_table_privilege(current_user,c.oid,'TRUNCATE') can_truncate
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE c.relkind IN('r','p') AND (n.nspname='ada_history'
      OR(n.nspname='public' AND c.relname IN('users','member_profiles')))`)).rows;
  for (const row of external) check(!row.can_insert && !row.can_update && !row.can_delete && !row.can_truncate,
    row.nspname + '.' + row.relname + '.DIRECT_DML');
  const generic = (await pool.query(`SELECT has_function_privilege(current_user,p.oid,'EXECUTE') can_execute
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='ada_history' AND p.proname='apply_batch'`)).rows;
  check(generic.every(row => !row.can_execute), 'GENERIC_HISTORY_APPLY_BATCH');
  const oldTargets = (await pool.query(`SELECT has_column_privilege(current_user,c.oid,'enabled','UPDATE') can_enable
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='sccrm_fanout' AND c.relname='targets'`)).rows;
  check(oldTargets.every(row => !row.can_enable), 'LEGACY_TARGET_ENABLE');
  if (errors.length) throw Object.assign(new Error('CODE_RUNTIME_RIGHTS_EXCESSIVE'), {
    code: 'CODE_RUNTIME_RIGHTS_EXCESSIVE', violations: errors,
  });
  return { ok: true, role, marker: MARKER, checks, privateTables: tables.length, privateFunctions: functions.length,
    genericApplyBatch: false, directHistoryProfileDml: false, canEnableTargets: false,
    legacyPublicRpcAudit: 'not_assessed' };
}
module.exports = { AUTHORITY_ROLE, DELIVERY_ROLE, TABLES, provisionCodeRoles, checkRights };
