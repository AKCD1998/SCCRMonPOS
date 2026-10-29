'use strict';
const crypto = require('node:crypto');
const { AssignmentQueue, validateDeliveryJob } = require('./queue.cjs');
const { validateAssignment, assignmentHash, legacyScCodeFor, AssignmentError } = require('./assignment.cjs');
const { normalizeProfile, profileHash, safeCode, FanoutEngine } = require('../fanout/engine.cjs');
const { record } = require('../history/model.cjs');
function requireValue(ok, code) { if (!ok) throw new AssignmentError(code); }
function validateSourceRecord(raw, expectedHqIdentity) {
  requireValue(raw && typeof raw === 'object', 'SOURCE_ASSIGNMENT_REQUIRED');
  const profile = normalizeProfile(raw.profile);
  const assignment = validateAssignment(raw.assignment, { expectedHqIdentity,
    expectedProfileHash: profileHash(profile), allowApprovedExisting: true });
  const hash = assignmentHash(assignment, { expectedHqIdentity, allowApprovedExisting: true });
  requireValue(raw.assignmentHash === hash, 'SOURCE_ASSIGNMENT_HASH_MISMATCH');
  const previousNativeCode = raw.previousNativeCode ?? null;
  requireValue(previousNativeCode === null || (assignment.kind === 'approved_existing'
    && previousNativeCode === legacyScCodeFor(assignment.memberId)), 'PREVIOUS_NATIVE_CODE_REFUSED');
  requireValue(raw.deliverToBranches === undefined || typeof raw.deliverToBranches === 'boolean', 'ASSIGNMENT_DELIVERY_SCOPE_REFUSED');
  return { assignment, profile, assignmentHash: hash, previousNativeCode,
    deliverToBranches: raw.deliverToBranches ?? true };
}
async function persistAuthority(authorityPool, raw, expectedHqIdentity, { authorityReference } = {}) {
  const input = validateSourceRecord(raw, expectedHqIdentity), a = input.assignment;
  const reference = authorityReference ?? 'owned HQ journal ' + a.assignmentId;
  requireValue(typeof reference === 'string' && reference.length > 0 && reference.length <= 500,
    'AUTHORITY_AUDIT_REFERENCE_REFUSED');
  const c = await authorityPool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`INSERT INTO sccrm_member_codes.assignments(assignment_id,member_id,ada_code,hq_identity,profile_hash,profile,assigned_at,version,kind,assignment_hash,authority_reference,deliver_to_branches)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12) ON CONFLICT(assignment_id) DO NOTHING`,
    [a.assignmentId, a.memberId, a.adaCode, a.hqIdentity, a.profileHash, JSON.stringify(input.profile), a.assignedAt,
      a.version, a.kind, input.assignmentHash, reference, input.deliverToBranches]);
    const row = (await c.query('SELECT * FROM sccrm_member_codes.assignments WHERE assignment_id=$1', [a.assignmentId])).rows[0];
    requireValue(row && row.member_id === a.memberId && row.ada_code === a.adaCode && row.hq_identity === a.hqIdentity
      && row.profile_hash === a.profileHash && profileHash(row.profile) === a.profileHash
      && row.assignment_hash === input.assignmentHash && row.kind === a.kind && row.version === a.version
      && new Date(row.assigned_at).toISOString() === a.assignedAt
      && row.deliver_to_branches === input.deliverToBranches, 'ASSIGNMENT_AUTHORITY_IDENTITY_COLLISION');
    await c.query(`INSERT INTO sccrm_member_codes.canonical_codes(member_id,assignment_id,canonical_code,previous_native_code,publication_reference)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(member_id) DO NOTHING`,
    [a.memberId, a.assignmentId, a.adaCode, input.previousNativeCode, reference]);
    const canonical = (await c.query('SELECT * FROM sccrm_member_codes.canonical_codes WHERE member_id=$1', [a.memberId])).rows[0];
    requireValue(canonical && canonical.assignment_id === a.assignmentId && canonical.canonical_code === a.adaCode
      && canonical.previous_native_code === input.previousNativeCode, 'CANONICAL_AUTHORITY_IDENTITY_COLLISION');
    if (input.previousNativeCode) {
      await c.query(`INSERT INTO sccrm_member_codes.aliases(code,member_id,assignment_id,reason,approval_reference)
        VALUES($1,$2,$3,'LEGACY_OWNED_ADA_CODE',$4) ON CONFLICT(code) DO NOTHING`,
      [input.previousNativeCode, a.memberId, a.assignmentId, 'owned HQ migration ' + a.assignmentId]);
      requireValue((await c.query('SELECT 1 FROM sccrm_member_codes.aliases WHERE code=$1 AND member_id=$2 AND assignment_id=$3',
        [input.previousNativeCode, a.memberId, a.assignmentId])).rowCount === 1, 'ALIAS_IDENTITY_COLLISION');
    }
    await c.query('COMMIT'); return input;
  } catch (error) {
    await c.query('ROLLBACK').catch(() => {});
    if (error.code === '23505') throw new AssignmentError('ASSIGNMENT_AUTHORITY_IDENTITY_COLLISION');
    throw error;
  } finally { c.release(); }
}
async function ingestOnce({ authorityPool, source, queue, expectedHqIdentity }) {
  const checkpoint = await queue.getSourceCheckpoint();
  const records = await source.read(checkpoint);
  requireValue(Array.isArray(records) && records.length <= 100, 'SOURCE_ASSIGNMENT_PAGE_REFUSED');
  const inputs = records.map(raw => validateSourceRecord(raw, expectedHqIdentity));
  let preceding = checkpoint;
  for (const input of inputs) {
    const a = input.assignment;
    requireValue(!preceding || a.assignedAt > preceding.createdAt
      || (a.assignedAt === preceding.createdAt && a.assignmentId > preceding.assignmentId), 'SOURCE_ASSIGNMENT_ORDER_REFUSED');
    preceding = { createdAt: a.assignedAt, assignmentId: a.assignmentId };
  }
  let persisted = 0, enqueued = 0;
  for (const raw of inputs) {
    const input = await persistAuthority(authorityPool, raw, expectedHqIdentity);
    // No checkpoint until both immutable authority state and durable jobs have
    // committed. On restart the same tuple is re-read and inserted only once.
    enqueued += (await queue.enqueueAssignment(input.assignment.assignmentId)).length;
    await queue.advanceSourceCheckpoint({ createdAt: input.assignment.assignedAt,
      assignmentId: input.assignment.assignmentId }); persisted++;
  }
  return { observed: records.length, persisted, enqueued };
}
async function catchUpOnly(queue) {
  const targets = await queue.targets(); let enqueued = 0;
  for (const target of targets) enqueued += (await queue.enqueueExistingForTarget(target.target_id, { limit: 100 })).length;
  return { targets: targets.length, enqueued, limitPerTarget: 100 };
}
async function publishPendingOnce({ authorityPool, source, expectedHqIdentity, limit = 1, after = null }) {
  requireValue(Number.isInteger(limit) && limit >= 1 && limit <= 10, 'PUBLICATION_PAGE_REFUSED');
  const query = async cursor => (await authorityPool.query(`SELECT a.assignment_id,a.assigned_at FROM sccrm_member_codes.assignments a
    JOIN sccrm_member_codes.canonical_codes c USING(assignment_id,member_id)
    WHERE a.hq_identity=$1 AND NOT EXISTS(SELECT 1 FROM sccrm_member_codes.publication_events p WHERE p.assignment_id=a.assignment_id)
      AND($2::timestamptz IS NULL OR(a.assigned_at,a.assignment_id)>($2::timestamptz,$3::uuid))
    ORDER BY a.assigned_at,a.assignment_id LIMIT $4`, [expectedHqIdentity, cursor?.createdAt ?? null, cursor?.assignmentId ?? null, limit])).rows;
  let pending = await query(after);
  if (!pending.length && after) pending = await query(null);
  const results = [];
  for (const row of pending) {
    try {
      const raw = await source.snapshot(row.assignment_id);
      const r = record('customers', raw);
      const serialized = { source_key: r.key, owner_code: r.owner, parent_key: r.parent,
        payload_hash: r.payloadHash, payload: r.payload };
      await authorityPool.query('SELECT sccrm_member_codes.refresh_assigned_customer($1,$2::jsonb,$3)',
        [row.assignment_id, JSON.stringify(serialized), crypto.randomUUID()]);
      const published = (await authorityPool.query('SELECT * FROM sccrm_member_codes.publish_member_code($1)', [row.assignment_id])).rows[0];
      requireValue(published && ['published', 'already-published', 'pending-native-link'].includes(published.state), 'PUBLICATION_ACK_REQUIRED');
      results.push({ assignmentId: row.assignment_id, state: published.state,
        cursor: { createdAt: new Date(row.assigned_at).toISOString(), assignmentId: row.assignment_id } });
    } catch (error) { results.push({ assignmentId: row.assignment_id, state: 'pending', code: safeCode(error),
      cursor: { createdAt: new Date(row.assigned_at).toISOString(), assignmentId: row.assignment_id } }); }
  }
  return results;
}
function newAssignmentRuntime({ deliveryPool, authorityPool, source, adapters, expectedHqIdentity,
  pollMs = 1000, leaseMs = 15000, timeoutMs = 7500, publishEnabled = true,
  snapshotSource = source, onError = () => {} }) {
  requireValue(authorityPool && typeof authorityPool.query === 'function' && typeof authorityPool.connect === 'function'
    && source && typeof source.read === 'function' && (!publishEnabled || typeof snapshotSource?.snapshot === 'function')
    && Number.isInteger(pollMs) && pollMs >= 100, 'ASSIGNMENT_RUNTIME_CONFIG_REFUSED');
  const queue = new AssignmentQueue(deliveryPool, { expectedHqIdentity });
  let stopped = true, stopRequested = false, ticking = false, timer, publication, guardPromise, publicationCursor = null;
  const state = { lastScan: null, lastCatchup: null, lastPublication: [], lastSourceError: null,
    lastError: null, lastTickAt: null };
  const engine = new FanoutEngine({ queue, adapters, pollMs, leaseMs, timeoutMs,
    jobValidator: job => validateDeliveryJob(job, { expectedHqIdentity }),
    onError: error => { state.lastError = error; onError(error); } });
  const guard = () => (guardPromise ||= queue.guard().catch(error => { guardPromise = null; throw error; }));
  async function tick() {
    if (ticking || stopRequested) return false; ticking = true;
    try {
      await guard();
      try { state.lastScan = await ingestOnce({ authorityPool, source, queue, expectedHqIdentity }); state.lastSourceError = null; }
      catch (error) { state.lastSourceError = safeCode(error); onError({ code: state.lastSourceError, phase: 'ingest' }); }
      if (stopRequested) return false;
      try { state.lastCatchup = await catchUpOnly(queue); }
      catch (error) { state.lastError = { phase: 'catchup', code: safeCode(error) }; onError(state.lastError); }
      await engine.tick();
      // Publication is independently durable (absence of a success event) and
      // asynchronous. A slow customer snapshot never gates branch dispatch or
      // the next HQ journal scan. A separate snapshotSource can isolate RPCs.
      if (publishEnabled && !publication) {
        publication = publishPendingOnce({ authorityPool, source: snapshotSource, expectedHqIdentity, after: publicationCursor })
          .then(results => { state.lastPublication = results; if (results.length) publicationCursor = results.at(-1).cursor; })
          .catch(error => { state.lastError = { phase: 'publication', code: safeCode(error) }; onError(state.lastError); })
          .finally(() => { publication = null; });
      }
      state.lastTickAt = new Date().toISOString(); return true;
    } finally { ticking = false; }
  }
  function start() {
    requireValue(stopped, 'ASSIGNMENT_RUNTIME_ALREADY_STARTED'); stopped = false; stopRequested = false;
    const pulse = () => guard().then(() => { if (!stopped && engine.stopped) engine.start(); return tick(); })
      .catch(error => { state.lastError = { phase: 'runtime', code: safeCode(error) }; onError(state.lastError); });
    void pulse(); timer = setInterval(pulse, pollMs); return api;
  }
  async function stop({ waitMs = 10000 } = {}) {
    stopped = true; stopRequested = true; clearInterval(timer); await engine.stop({ waitMs });
    const until = Date.now() + waitMs;
    while (ticking && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
    // Pools/source/adapters belong to the caller. In particular do not end a
    // pool shared with the existing SC worker or stop any Windows service.
    if (publication) { let deadline; await Promise.race([publication, new Promise(resolve => { deadline = setTimeout(resolve, waitMs); })]); clearTimeout(deadline); }
  }
  async function status() {
    const pending = (await deliveryPool.query(`SELECT count(*)::int count FROM sccrm_member_codes.assignments a
      JOIN sccrm_member_codes.canonical_codes c USING(assignment_id,member_id)
      WHERE NOT EXISTS(SELECT 1 FROM sccrm_member_codes.publication_events p WHERE p.assignment_id=a.assignment_id)`)).rows[0].count;
    return { stopped, ticking, publicationRunning: !!publication, pendingPublication: pending,
      ...state, targets: await queue.status(), sourceCheckpoint: await queue.getSourceCheckpoint() };
  }
  const api = { queue, tick, start, stop, status }; return api;
}
module.exports = { validateSourceRecord, persistAuthority, ingestOnce, catchUpOnly,
  publishPendingOnce, newAssignmentRuntime };
