'use strict';
// Explicit operator action only. The CLI is a read-only preview; a background
// worker must never infer these assignments or fan out the legacy customer base.
const crypto = require('node:crypto');
const { isAdaArCode, legacyScmCodeFor, assignmentHash, MARKER, SCOPE } = require('./assignment.cjs');
const { normalizeProfile, profileHash, safeCode } = require('../fanout/engine.cjs');
const { record } = require('../history/model.cjs');
const { tuple } = require('./queue.cjs');
const { persistAuthority } = require('./runtime.cjs');
const { AUTHORITY_ROLE } = require('./pg-runtime.cjs');
const SOURCE = 'hq000/AdaAcc';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function requireValue(ok, code) { if (!ok) throw Object.assign(new Error(code), { code }); }
function eventId(value) {
  const h = digest(value); return h.slice(0,8) + '-' + h.slice(8,12) + '-5' + h.slice(13,16) + '-a' + h.slice(17,20) + '-' + h.slice(20,32);
}
function manifest(rows) {
  return rows.map(r => [r.memberId, r.currentCode, r.adaCode, r.state, r.code || null,
    r.approvalHash || null, r.nativeHash || null, r.profileHash || null]);
}
function validateOptions({ db, readNative, mode = 'Copy', limit = 10, memberIds }) {
  requireValue(db && typeof db.query === 'function' && typeof readNative === 'function', 'ADOPTION_READERS_REQUIRED');
  requireValue(['Live','Copy'].includes(mode) && Number.isInteger(limit) && limit >= 1 && limit <= 10, 'ADOPTION_SCOPE_REFUSED');
  if (memberIds) requireValue(Array.isArray(memberIds) && memberIds.length > 0 && memberIds.length <= limit
    && new Set(memberIds).size === memberIds.length && memberIds.every(id => UUID.test(id)), 'ADOPTION_MEMBER_SCOPE_REFUSED');
  return { mode, limit };
}
async function planExisting(options) {
  const { db, readNative, memberIds } = options, { mode, limit } = validateOptions(options);
  const rows = (await db.query(`SELECT u.id member_id,m.member_code,
    count(l.member_id)::int link_count,min(l.source_id) source_id,min(l.ada_code) ada_code,
    min(l.approval_reference) approval_reference
    FROM public.users u JOIN public.member_profiles m ON m.user_id=u.id
    LEFT JOIN ada_history.member_links l ON l.member_id=u.id
    WHERE m.is_active=true AND (($1::uuid[] IS NOT NULL AND u.id=ANY($1)) OR
      ($1::uuid[] IS NULL AND m.member_code='SCM-'||upper(left(replace(u.id::text,'-',''),8))
        AND EXISTS(SELECT 1 FROM ada_history.member_links x WHERE x.member_id=u.id
          AND x.source_id=$2 AND x.ada_code ~ '^AR(000|001|003|004|005)-[0-9]{6}$')))
    GROUP BY u.id,m.member_code ORDER BY u.id LIMIT $3`, [memberIds || null, SOURCE, limit + 1])).rows;
  requireValue(rows.length <= limit, 'ADOPTION_COHORT_BOUND_EXCEEDED');
  if (memberIds) requireValue(rows.length === memberIds.length, 'ADOPTION_MEMBER_MISSING_OR_INACTIVE');
  const candidates = [];
  for (const row of rows) {
    const item = { memberId: row.member_id, currentCode: row.member_code, adaCode: row.ada_code, state: 'review' };
    try {
      requireValue(UUID.test(item.memberId) && row.link_count === 1 && row.source_id === SOURCE
        && isAdaArCode(row.ada_code) && typeof row.approval_reference === 'string'
        && row.approval_reference.trim().length > 0, 'ADOPTION_EXACT_APPROVED_LINK_REQUIRED');
      requireValue(item.currentCode === legacyScmCodeFor(item.memberId) || (memberIds && item.currentCode === item.adaCode), 'ADOPTION_CURRENT_CODE_REFUSED');
      const native = await readNative('customer', '000', item.adaCode, mode);
      requireValue(Array.isArray(native) && native.length === 1 && native[0].FTCstCode === item.adaCode,
        'ADOPTION_NATIVE_CUSTOMER_NOT_UNIQUE');
      requireValue(Object.keys(native[0]).length === 101 && !Object.keys(native[0]).some(k => /pin|password|secret|token/i.test(k)), 'ADOPTION_NATIVE_PROJECTION_REFUSED');
      const profile = normalizeProfile({ name: native[0].FTCstName, phone: native[0].FTCstTel, email: native[0].FTCstEmail || '' });
      requireValue(profile.name === native[0].FTCstName && profile.phone === native[0].FTCstTel
        && profile.email === (native[0].FTCstEmail || ''), 'ADOPTION_NATIVE_PROFILE_NOT_CANONICAL');
      const r = record('customers', native[0]);
      Object.assign(item, { state: 'ready', approvalHash: digest(row.approval_reference),
        profile, profileHash: profileHash(profile), nativeHash: r.payloadHash,
        nativeRecord: { source_key: r.key, owner_code: r.owner, parent_key: r.parent, payload_hash: r.payloadHash, payload: r.payload } });
    } catch (error) { item.code = safeCode(error); }
    candidates.push(item);
  }
  return { scope: 'SCCRM-EXISTING-AR-ADOPTION-PLAN-V1', mode, rows: candidates,
    fingerprint: digest([mode, manifest(candidates)]), nativeWrites: 0 };
}
function publicPlan(plan) {
  return { scope: plan.scope, mode: plan.mode, fingerprint: plan.fingerprint, nativeWrites: 0,
    rows: plan.rows.map(({ memberId, currentCode, adaCode, state, code }) => ({ memberId, currentCode, adaCode, state, ...(code ? { code } : {}) })) };
}
async function audit(pool, item, assignment, phase, reference) {
  const migration = eventId(['existing-approved-ada-link', item.memberId, item.adaCode]);
  const id = eventId([migration, assignment.assignmentId, phase]);
  const approval = JSON.stringify({ source: 'pre-existing approved HQ link', code: item.adaCode,
    linkApprovalHash: item.approvalHash, operatorReference: reference });
  requireValue(approval.length <= 500, 'ADOPTION_APPROVAL_REFERENCE_TOO_LONG');
  await pool.query(`INSERT INTO sccrm_member_codes.migration_events(event_id,migration_id,assignment_id,member_id,phase,target_identity,authority_reference)
    VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(event_id) DO NOTHING`,
  [id, migration, assignment.assignmentId, assignment.memberId, phase, assignment.hqIdentity, approval]);
  requireValue((await pool.query(`SELECT 1 FROM sccrm_member_codes.migration_events
    WHERE event_id=$1 AND assignment_id=$2 AND member_id=$3 AND phase=$4 AND authority_reference=$5`,
  [id, assignment.assignmentId, assignment.memberId, phase, approval])).rowCount === 1, 'ADOPTION_AUDIT_IDENTITY_COLLISION');
}
async function adoptExisting({ db, authorityPool, readNative, expectedHqIdentity, approvedPlan, approvalReference, mode = 'Copy' }) {
  requireValue(approvedPlan && approvedPlan.scope === 'SCCRM-EXISTING-AR-ADOPTION-PLAN-V1'
    && approvedPlan.mode === mode && Array.isArray(approvedPlan.rows) && approvedPlan.rows.length > 0
    && approvedPlan.rows.length <= 10 && approvedPlan.rows.every(r => r.state === 'ready')
    && approvedPlan.fingerprint === digest([mode, manifest(approvedPlan.rows)]), 'EXPLICIT_READY_ADOPTION_PLAN_REQUIRED');
  requireValue(typeof approvalReference === 'string' && approvalReference.trim() === approvalReference
    && approvalReference.length > 0 && approvalReference.length <= 180, 'ADOPTION_OPERATOR_APPROVAL_REQUIRED');
  requireValue(authorityPool && typeof authorityPool.query === 'function', 'ADOPTION_AUTHORITY_REQUIRED');
  const actor = (await authorityPool.query(`SELECT current_user actor,session_user session_actor,
    current_database() database,host(inet_server_addr()) host,inet_server_port() port`)).rows[0];
  requireValue(actor?.actor === AUTHORITY_ROLE && actor.session_actor === AUTHORITY_ROLE, 'ADOPTION_AUTHORITY_ACTOR_REFUSED');
  if (mode === 'Copy') requireValue(/^sccrm_fanout_test_[a-z0-9_]+$/.test(actor.database)
    && ['127.0.0.1','::1'].includes(actor.host) && actor.port !== 5432, 'ADOPTION_COPY_DATABASE_REQUIRED');
  else requireValue(mode === 'Live' && actor.database === 'postgres'
    && expectedHqIdentity === 'hq000/SERVER.SQLEXPRESS/AdaAcc/64fa3170-80ae-45ee-b9f3-7478b2a46e34', 'ADOPTION_LIVE_DATABASE_REQUIRED');
  const ids = approvedPlan.rows.map(r => r.memberId);
  const fresh = await planExisting({ db, readNative, mode, memberIds: ids, limit: ids.length });
  for (const item of fresh.rows) {
    const approved = approvedPlan.rows.find(r => r.memberId === item.memberId);
    requireValue(item.state === 'ready' && item.adaCode === approved.adaCode
      && item.approvalHash === approved.approvalHash && item.nativeHash === approved.nativeHash
      && item.profileHash === approved.profileHash, 'ADOPTION_PLAN_CHANGED_REVIEW_REQUIRED');
  }
  const meta = (await authorityPool.query('SELECT marker,scope,schema_version,expected_hq_identity FROM sccrm_member_codes.meta')).rows;
  requireValue(meta.length === 1 && meta[0].marker === MARKER && meta[0].scope === SCOPE
    && meta[0].schema_version === 1 && meta[0].expected_hq_identity === expectedHqIdentity, 'CODE_AUTHORITY_SCHEMA_NOT_OWNED');
  const conflicts = (await authorityPool.query('SELECT code,member_id FROM sccrm_member_codes.aliases WHERE code=ANY($1::text[])',
    [ids.map(legacyScmCodeFor)])).rows;
  requireValue(conflicts.every(a => fresh.rows.some(r => r.memberId === a.member_id
    && legacyScmCodeFor(r.memberId) === a.code)), 'ADOPTION_ALIAS_OWNER_CONFLICT');
  const publicCodes = (await db.query('SELECT user_id,member_code FROM public.member_profiles WHERE member_code=ANY($1::text[])',
    [fresh.rows.map(r => r.adaCode)])).rows;
  requireValue(publicCodes.every(m => fresh.rows.some(r => r.memberId === m.user_id && r.adaCode === m.member_code)), 'ADOPTION_CANONICAL_OWNER_CONFLICT');
  const results = [];
  for (const item of fresh.rows) {
    try {
      const existing = (await authorityPool.query('SELECT * FROM sccrm_member_codes.assignments WHERE member_id=$1 OR ada_code=$2', [item.memberId, item.adaCode])).rows;
      requireValue(existing.length <= 1, 'ADOPTION_AUTHORITY_CONFLICT');
      let assignment;
      if (existing.length) {
        const row = existing[0];
        requireValue(row.member_id === item.memberId && row.ada_code === item.adaCode
          && row.kind === 'approved_existing' && row.deliver_to_branches === false
          && row.hq_identity === expectedHqIdentity && row.profile_hash === item.profileHash,
        'ADOPTION_AUTHORITY_CONFLICT');
        assignment = tuple(row);
      } else {
        requireValue(item.currentCode === legacyScmCodeFor(item.memberId), 'ADOPTION_EXISTING_CANONICAL_AUTHORITY_REQUIRED');
        assignment = { version: 1, assignmentId: crypto.randomUUID(), memberId: item.memberId, adaCode: item.adaCode,
          assignedAt: new Date().toISOString(), kind: 'approved_existing', hqIdentity: expectedHqIdentity, profileHash: item.profileHash };
      }
      await persistAuthority(authorityPool, { assignment, profile: item.profile, deliverToBranches: false,
        previousNativeCode: null, assignmentHash: assignmentHash(assignment, { expectedHqIdentity, allowApprovedExisting: true }) }, expectedHqIdentity,
      { authorityReference: JSON.stringify({ source: 'pre-existing approved HQ link', code: item.adaCode,
        linkApprovalHash: item.approvalHash, operatorReference: approvalReference }) });
      await audit(authorityPool, item, assignment, 'prepared', approvalReference);
      await authorityPool.query('SELECT sccrm_member_codes.refresh_assigned_customer($1,$2::jsonb,$3)',
        [assignment.assignmentId, JSON.stringify(item.nativeRecord), crypto.randomUUID()]);
      const published = (await authorityPool.query('SELECT * FROM sccrm_member_codes.publish_member_code($1)', [assignment.assignmentId])).rows[0];
      requireValue(published && ['published','already-published'].includes(published.state)
        && published.member_id === item.memberId && published.member_code === item.adaCode, 'ADOPTION_PUBLICATION_ACK_REQUIRED');
      await audit(authorityPool, item, assignment, 'published', approvalReference);
      results.push({ memberId: item.memberId, adaCode: item.adaCode, state: published.state, assignmentId: assignment.assignmentId });
    } catch (error) { results.push({ memberId: item.memberId, adaCode: item.adaCode, state: 'review', code: safeCode(error) }); }
  }
  return { ok: results.every(r => r.state !== 'review'), scope: 'SCCRM-EXISTING-AR-ADOPTION-V1', mode,
    results, nativeWrites: 0, branchDeliveryRequested: false };
}
if (require.main === module) (async () => {
  requireValue(!process.argv[2] || process.argv[2] === 'plan', 'READ_ONLY_ADOPTION_PREVIEW_ONLY');
  const { Client } = require('pg'), { pgAdmin } = require('../fanout/operator.cjs');
  const { readNative } = require('./operator.cjs');
  const config = pgAdmin(), db = new Client({ connectionString: config.url.href,
    ssl: { ca: config.ca, rejectUnauthorized: true }, connectionTimeoutMillis: 8000,
    query_timeout: 10000, application_name: 'SCCRM-ExistingAR-Preview-ReadOnly' });
  try {
    await db.connect(); await db.query('BEGIN READ ONLY');
    await db.query("SET LOCAL lock_timeout='1s';SET LOCAL statement_timeout='8s'");
    console.log(JSON.stringify(publicPlan(await planExisting({ db, readNative, mode: 'Live' }))));
    await db.query('COMMIT');
  } finally { await db.end(); }
})().catch(error => { console.error(JSON.stringify({ ok: false, code: safeCode(error) })); process.exitCode = 1; });
module.exports = { SOURCE, planExisting, publicPlan, adoptExisting };
