'use strict';
const crypto = require('node:crypto');
const { MARKER, SCOPE, AssignmentError, validateAssignment, assignmentHash,
  legacyScCodeFor } = require('./assignment.cjs');
const { profileHash, normalizeProfile, safeCode, isRetryable, retryDelayMs } = require('../fanout/engine.cjs');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function requireValue(ok, code) { if (!ok) throw new AssignmentError(code); }
function tuple(row) {
  return { version: row.version, assignmentId: row.assignment_id, memberId: row.member_id,
    adaCode: row.ada_code, hqIdentity: row.hq_identity, profileHash: row.profile_hash,
    assignedAt: new Date(row.assigned_at).toISOString(), kind: row.kind };
}
function validateDeliveryJob(job, { expectedHqIdentity } = {}) {
  requireValue(job && typeof job === 'object', 'ASSIGNED_JOB_REQUIRED');
  const assignment = validateAssignment(job.assignment, { expectedHqIdentity,
    allowApprovedExisting: true, expectedMemberId: job.member_id, expectedProfileHash: job.profile_hash });
  requireValue(job.assignment_id === assignment.assignmentId && job.hq_code === assignment.adaCode
    && job.assignment_hash === assignmentHash(assignment, { expectedHqIdentity, allowApprovedExisting: true })
    && typeof job.database_identity === 'string' && job.database_identity.length > 0
    && job.database_identity.length <= 160 && profileHash(job.profile) === assignment.profileHash,
  'ASSIGNED_JOB_BINDING_MISMATCH');
  requireValue(job.previous_native_code == null || (assignment.kind === 'approved_existing'
    && job.previous_native_code === legacyScCodeFor(assignment.memberId)), 'PREVIOUS_NATIVE_CODE_REFUSED');
  return job;
}
function validateAssignedAck(job, ack, options) {
  validateDeliveryJob(job, options);
  requireValue(ack && typeof ack === 'object' && String(ack.memberId || '').toLowerCase() === job.member_id
    && String(ack.assignmentId || '').toLowerCase() === job.assignment_id && ack.assignmentHash === job.assignment_hash
    && ack.hqCode === job.hq_code && ack.adaCode === job.hq_code
    && ack.targetIdentity === job.database_identity, 'ASSIGNED_ACK_IDENTITY_MISMATCH');
  requireValue(['created', 'already_delivered', 'existing_mapped'].includes(ack.outcome), 'ASSIGNED_ACK_OUTCOME_REFUSED');
  requireValue(ack.profileHash === job.profile_hash && profileHash(ack.profile) === job.profile_hash, 'ASSIGNED_ACK_PROFILE_MISMATCH');
  return { memberId: job.member_id, assignmentId: job.assignment_id, assignmentHash: job.assignment_hash,
    hqCode: job.hq_code, adaCode: job.hq_code, targetIdentity: job.database_identity,
    profileHash: job.profile_hash, outcome: ack.outcome };
}
class AssignmentQueue {
  constructor(pool, { expectedHqIdentity } = {}) {
    requireValue(pool && typeof pool.query === 'function' && typeof pool.connect === 'function', 'PG_POOL_REQUIRED');
    requireValue(typeof expectedHqIdentity === 'string' && expectedHqIdentity.length > 0
      && expectedHqIdentity.length <= 160, 'HQ_AUTHORITY_CONFIG_REQUIRED');
    this.pool = pool; this.options = { expectedHqIdentity };
  }
  async tx(fn) {
    const c = await this.pool.connect();
    try { await c.query('BEGIN'); const result = await fn(c); await c.query('COMMIT'); return result; }
    catch (error) { await c.query('ROLLBACK').catch(() => {}); throw error; }
    finally { c.release(); }
  }
  async guard() {
    const r = await this.pool.query('SELECT marker,scope,schema_version,expected_hq_identity FROM sccrm_member_codes.meta');
    requireValue(r.rows.length === 1 && r.rows[0].marker === MARKER && r.rows[0].scope === SCOPE
      && r.rows[0].schema_version === 1 && r.rows[0].expected_hq_identity === this.options.expectedHqIdentity,
    'CODE_AUTHORITY_SCHEMA_NOT_OWNED');
  }
  async targets() { return (await this.pool.query('SELECT target_id,database_identity,branch_code FROM sccrm_member_codes.targets WHERE enabled=true ORDER BY target_id')).rows; }
  async authority(c, assignmentId) {
    requireValue(typeof assignmentId === 'string' && UUID.test(assignmentId), 'ASSIGNMENT_ID_REFUSED');
    const row = (await c.query(`SELECT a.*,c.previous_native_code FROM sccrm_member_codes.assignments a
      JOIN sccrm_member_codes.canonical_codes c USING(assignment_id,member_id)
      WHERE a.assignment_id=$1`, [assignmentId])).rows[0];
    requireValue(row, 'ASSIGNMENT_AUTHORITY_NOT_FOUND');
    const assignment = validateAssignment(tuple(row), { ...this.options, allowApprovedExisting: true });
    requireValue(profileHash(row.profile) === assignment.profileHash
      && row.assignment_hash === assignmentHash(assignment, { ...this.options, allowApprovedExisting: true }), 'ASSIGNMENT_AUTHORITY_HASH_MISMATCH');
    requireValue(row.previous_native_code == null || (assignment.kind === 'approved_existing'
      && row.previous_native_code === legacyScCodeFor(row.member_id)), 'PREVIOUS_NATIVE_CODE_REFUSED');
    return { row, assignment, profile: normalizeProfile(row.profile) };
  }
  async enqueue(c, target, source) {
    const { row, assignment, profile } = source;
    const key = digest([SCOPE, target.database_identity, assignment.assignmentId]);
    const inserted = await c.query(`INSERT INTO sccrm_member_codes.jobs(target_id,assignment_id,member_id,hq_code,assignment_hash,assignment,profile,profile_hash,previous_native_code,hq_created_at,idempotency_key)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11)
      ON CONFLICT(target_id,assignment_id) DO NOTHING RETURNING *`, [target.target_id, assignment.assignmentId,
      assignment.memberId, assignment.adaCode, row.assignment_hash, JSON.stringify(assignment), JSON.stringify(profile),
      assignment.profileHash, row.previous_native_code, assignment.assignedAt, key]);
    if (inserted.rowCount) {
      await c.query("INSERT INTO sccrm_member_codes.events(job_id,attempt,state,code) VALUES($1,0,'pending','HQ_ASSIGNMENT_CONFIRMED')", [inserted.rows[0].id]);
      return inserted.rows[0];
    }
    const previous = (await c.query('SELECT * FROM sccrm_member_codes.jobs WHERE target_id=$1 AND assignment_id=$2', [target.target_id, assignment.assignmentId])).rows[0];
    requireValue(previous && previous.member_id === assignment.memberId && previous.hq_code === assignment.adaCode
      && previous.assignment_hash === row.assignment_hash && previous.profile_hash === assignment.profileHash
      && previous.previous_native_code === (row.previous_native_code ?? null)
      && previous.idempotency_key === key, 'ASSIGNMENT_QUEUED_BASIS_CHANGED');
    return previous;
  }
  async enqueueAssignment(assignmentId, targetIds) {
    if (targetIds !== undefined) requireValue(Array.isArray(targetIds) && targetIds.length <= 100
      && targetIds.every(id => typeof id === 'string'), 'TARGET_SCOPE_REFUSED');
    return this.tx(async c => {
      const source = await this.authority(c, assignmentId);
      if (source.row.deliver_to_branches !== true) return [];
      const targets = (await c.query('SELECT target_id,database_identity FROM sccrm_member_codes.targets WHERE enabled=true AND ($1::text[] IS NULL OR target_id=ANY($1::text[])) ORDER BY target_id', [targetIds ?? null])).rows;
      const jobs = []; for (const target of targets) jobs.push(await this.enqueue(c, target, source)); return jobs;
    });
  }
  async enqueueExistingForTarget(targetId, { limit = 100 } = {}) {
    requireValue(Number.isInteger(limit) && limit >= 1 && limit <= 100, 'CATCHUP_LIMIT_REFUSED');
    return this.tx(async c => {
      const target = (await c.query('SELECT target_id,database_identity FROM sccrm_member_codes.targets WHERE target_id=$1 AND enabled=true', [targetId])).rows[0];
      if (!target) return [];
      const rows = (await c.query(`SELECT a.assignment_id FROM sccrm_member_codes.assignments a
        JOIN sccrm_member_codes.canonical_codes c USING(assignment_id,member_id)
        WHERE a.deliver_to_branches=true AND NOT EXISTS(SELECT 1 FROM sccrm_member_codes.jobs j WHERE j.target_id=$1 AND j.assignment_id=a.assignment_id)
        ORDER BY a.assigned_at,a.assignment_id LIMIT $2`, [targetId, limit])).rows;
      const jobs = []; for (const row of rows) jobs.push(await this.enqueue(c, target, await this.authority(c, row.assignment_id))); return jobs;
    });
  }
  async getSourceCheckpoint() {
    const r = (await this.pool.query('SELECT created_at,assignment_id FROM sccrm_member_codes.source_checkpoint WHERE singleton=true')).rows[0];
    return r?.assignment_id ? { createdAt: new Date(r.created_at).toISOString(), assignmentId: r.assignment_id } : null;
  }
  async advanceSourceCheckpoint({ createdAt, assignmentId }) {
    requireValue(typeof assignmentId === 'string' && UUID.test(assignmentId) && Number.isFinite(new Date(createdAt).getTime()), 'ASSIGNMENT_CURSOR_REFUSED');
    return this.tx(async c => {
      requireValue((await c.query('SELECT 1 FROM sccrm_member_codes.assignments a JOIN sccrm_member_codes.canonical_codes c USING(assignment_id,member_id) WHERE a.assignment_id=$1 AND a.assigned_at=$2', [assignmentId, createdAt])).rowCount === 1, 'ASSIGNMENT_CURSOR_NOT_PERSISTED');
      return (await c.query(`UPDATE sccrm_member_codes.source_checkpoint SET created_at=$1,assignment_id=$2,updated_at=now()
        WHERE singleton=true AND (created_at IS NULL OR (created_at,assignment_id)<($1::timestamptz,$2::uuid)) RETURNING assignment_id`, [createdAt, assignmentId])).rowCount > 0;
    });
  }
  async lease(targetId, owner, leaseMs = 15000) {
    requireValue(UUID.test(owner) && Number.isInteger(leaseMs) && leaseMs >= 2000 && leaseMs <= 300000, 'LEASE_SCOPE_REFUSED');
    return this.tx(async c => {
      const target = (await c.query('SELECT * FROM sccrm_member_codes.targets WHERE target_id=$1 AND enabled=true AND (lease_until IS NULL OR lease_until<=now()) FOR UPDATE SKIP LOCKED', [targetId])).rows[0];
      if (!target) return null;
      const job = (await c.query(`SELECT * FROM sccrm_member_codes.jobs WHERE target_id=$1
        AND ((state IN('pending','retry') AND next_attempt_at<=now()) OR(state='running' AND lease_until<=now()))
        ORDER BY next_attempt_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`, [targetId])).rows[0];
      if (!job) return null;
      const token = crypto.randomUUID();
      await c.query("UPDATE sccrm_member_codes.targets SET lease_token=$2,lease_owner=$3,lease_until=now()+$4::int*interval '1 millisecond' WHERE target_id=$1", [targetId, token, owner, leaseMs]);
      const row = (await c.query("UPDATE sccrm_member_codes.jobs SET state='running',attempt_count=attempt_count+1,lease_token=$2,lease_owner=$3,lease_until=now()+$4::int*interval '1 millisecond',updated_at=now() WHERE id=$1 RETURNING *", [job.id, token, owner, leaseMs])).rows[0];
      await c.query("INSERT INTO sccrm_member_codes.events(job_id,attempt,state,code) VALUES($1,$2,'running','DELIVERY_STARTED')", [job.id, row.attempt_count]);
      return { ...row, database_identity: target.database_identity, branch_code: target.branch_code };
    });
  }
  async settle(job, fn) {
    return this.tx(async c => {
      const target = (await c.query('SELECT target_id FROM sccrm_member_codes.targets WHERE target_id=$1 AND lease_token=$2 FOR UPDATE', [job.target_id, job.lease_token])).rows[0];
      if (!target) return false;
      const owned = (await c.query("SELECT * FROM sccrm_member_codes.jobs WHERE id=$1 AND state='running' AND lease_token=$2 FOR UPDATE", [job.id, job.lease_token])).rows[0];
      if (!owned) return false;
      requireValue(owned.assignment_id === job.assignment_id && owned.assignment_hash === job.assignment_hash
        && owned.member_id === job.member_id && owned.hq_code === job.hq_code && owned.profile_hash === job.profile_hash, 'ASSIGNED_JOB_SETTLE_BASIS_CHANGED');
      await fn(c, owned);
      await c.query('UPDATE sccrm_member_codes.targets SET lease_token=NULL,lease_owner=NULL,lease_until=NULL WHERE target_id=$1 AND lease_token=$2', [job.target_id, job.lease_token]); return true;
    });
  }
  async succeeded(job, ack) {
    const receipt = validateAssignedAck(job, ack, this.options);
    return this.settle(job, async (c, owned) => {
      const previous = (await c.query('SELECT * FROM sccrm_member_codes.mappings WHERE target_id=$1 AND (member_id=$2 OR ada_code=$3 OR assignment_id=$4)', [job.target_id, job.member_id, job.hq_code, job.assignment_id])).rows;
      requireValue(previous.every(row => row.member_id === job.member_id && row.ada_code === job.hq_code
        && row.assignment_id === job.assignment_id && row.assignment_hash === job.assignment_hash
        && row.database_identity === job.database_identity && row.profile_hash === job.profile_hash), 'ASSIGNED_MAPPING_IDENTITY_COLLISION');
      if (!previous.length) await c.query(`INSERT INTO sccrm_member_codes.mappings(target_id,assignment_id,member_id,ada_code,assignment_hash,database_identity,profile_hash,native_receipt)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`, [job.target_id, job.assignment_id, job.member_id, job.hq_code,
        job.assignment_hash, job.database_identity, job.profile_hash, JSON.stringify(receipt)]);
      await c.query("UPDATE sccrm_member_codes.jobs SET state='succeeded',lease_token=NULL,lease_owner=NULL,lease_until=NULL,last_code=NULL,completed_at=COALESCE(completed_at,now()),updated_at=now() WHERE id=$1", [owned.id]);
      await c.query("INSERT INTO sccrm_member_codes.events(job_id,attempt,state,code) VALUES($1,$2,'succeeded','ASSIGNMENT_ACK_VERIFIED')", [owned.id, owned.attempt_count]);
    });
  }
  async failed(job, error) {
    const code = safeCode(error), retry = isRetryable(code), state = retry ? 'retry' : 'review';
    return this.settle(job, async (c, owned) => {
      await c.query("UPDATE sccrm_member_codes.jobs SET state=$2,last_code=$3,next_attempt_at=now()+$4::int*interval '1 millisecond',lease_token=NULL,lease_owner=NULL,lease_until=NULL,updated_at=now() WHERE id=$1", [owned.id, state, code, retry ? retryDelayMs(owned.attempt_count) : 0]);
      await c.query('INSERT INTO sccrm_member_codes.events(job_id,attempt,state,code) VALUES($1,$2,$3,$4)', [owned.id, owned.attempt_count, state, code]);
    });
  }
  async status() {
    return (await this.pool.query(`SELECT t.target_id,t.branch_code,t.database_identity,t.enabled,count(j.id)::int total,
      count(j.id) FILTER(WHERE j.state='succeeded')::int succeeded,count(j.id) FILTER(WHERE j.state='review')::int review,
      count(j.id) FILTER(WHERE j.state IN('pending','retry','running'))::int waiting,max(j.completed_at) last_completed_at
      FROM sccrm_member_codes.targets t LEFT JOIN sccrm_member_codes.jobs j USING(target_id) GROUP BY t.target_id ORDER BY t.target_id`)).rows;
  }
}
async function registerTarget(admin, target) {
  requireValue(/^[a-z0-9_-]{1,100}$/.test(target.targetId) && /^00[1345]$/.test(target.branchCode)
    && typeof target.databaseIdentity === 'string' && target.databaseIdentity.length > 0
    && target.databaseIdentity.length <= 160, 'ASSIGNED_TARGET_REFUSED');
  await admin.query('INSERT INTO sccrm_member_codes.targets(target_id,database_identity,branch_code) VALUES($1,$2,$3) ON CONFLICT(target_id) DO NOTHING', [target.targetId, target.databaseIdentity, target.branchCode]);
  const row = (await admin.query('SELECT * FROM sccrm_member_codes.targets WHERE target_id=$1', [target.targetId])).rows[0];
  requireValue(row.database_identity === target.databaseIdentity && row.branch_code === target.branchCode, 'ASSIGNED_TARGET_IDENTITY_COLLISION'); return row;
}
module.exports = { AssignmentQueue, registerTarget, validateDeliveryJob, validateAssignedAck, tuple };
