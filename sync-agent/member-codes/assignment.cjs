'use strict';

// Pure contract helpers. These validate a tuple's binding and representation;
// they do NOT authenticate a caller, read HQ, allocate a code, or verify a
// digital signature. Only an authority importer that has verified the owned HQ
// creation/approved-link journal may persist one. Never grant that INSERT to
// the ordinary fanout receiver or accept assignments from a public client.
const crypto = require('node:crypto');
const MARKER = 'cffb05d6-116a-458d-98ba-52473745c116';
const SCOPE = 'SCCRM-HQ-MEMBER-CODE-AUTHORITY-V1';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const ADA_AR = /^AR(?:000|001|003|004|005)-[0-9]{6}$/;
const HQ_AR = /^AR000-[0-9]{6}$/;
const TUPLE_KEYS = ['adaCode', 'assignedAt', 'assignmentId', 'hqIdentity', 'kind', 'memberId', 'profileHash', 'version'];

class AssignmentError extends Error {
  constructor(code) { super(code); this.code = code; }
}
function requireValue(ok, code) { if (!ok) throw new AssignmentError(code); }
function uuid(value, code) {
  requireValue(typeof value === 'string' && UUID.test(value), code);
  return value.toLowerCase();
}
function exactFields(value, keys, code) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === keys.join(','), code);
}
function legacyScCodeFor(memberId) {
  return 'SC-' + uuid(memberId, 'MEMBER_ID_REFUSED').replaceAll('-', '').slice(0, 16).toUpperCase();
}
function legacyScmCodeFor(memberId) {
  return 'SCM-' + uuid(memberId, 'MEMBER_ID_REFUSED').replaceAll('-', '').slice(0, 8).toUpperCase();
}
function isLegacyScCode(code, memberId) {
  return typeof memberId === 'string' && UUID.test(memberId) && code === legacyScCodeFor(memberId);
}
function isAdaArCode(code) {
  return typeof code === 'string' && ADA_AR.test(code) && code.slice(-6) !== '000000';
}
function utcTime(value) {
  // SQL datetime is represented with at most millisecond precision. Require an
  // explicit UTC suffix; a local date or guessed local offset is not authority.
  requireValue(typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value), 'ASSIGNMENT_TIME_REFUSED');
  const parsed = new Date(value);
  requireValue(Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 19) === value.slice(0, 19), 'ASSIGNMENT_TIME_REFUSED');
  return parsed.toISOString();
}
function validateAssignment(raw, options = {}) {
  exactFields(raw, TUPLE_KEYS, 'ASSIGNMENT_FIELDS_REFUSED');
  requireValue(raw.version === 1, 'ASSIGNMENT_VERSION_REFUSED');
  const assignmentId = uuid(raw.assignmentId, 'ASSIGNMENT_ID_REFUSED');
  const memberId = uuid(raw.memberId, 'MEMBER_ID_REFUSED');
  requireValue(typeof options.expectedHqIdentity === 'string'
    && options.expectedHqIdentity.length > 0 && options.expectedHqIdentity.length <= 160
    && options.expectedHqIdentity.trim() === options.expectedHqIdentity, 'HQ_AUTHORITY_CONFIG_REQUIRED');
  requireValue(raw.hqIdentity === options.expectedHqIdentity, 'HQ_AUTHORITY_IDENTITY_MISMATCH');
  requireValue(typeof raw.profileHash === 'string' && HASH.test(raw.profileHash), 'ASSIGNMENT_PROFILE_HASH_REFUSED');
  requireValue(isAdaArCode(raw.adaCode), 'ASSIGNMENT_AR_CODE_REFUSED');
  if (raw.kind === 'hq_create') {
    requireValue(HQ_AR.test(raw.adaCode), 'HQ_CREATED_CODE_PREFIX_REFUSED');
  } else {
    requireValue(raw.kind === 'approved_existing' && options.allowApprovedExisting === true,
      'EXISTING_CODE_APPROVAL_REQUIRED');
  }
  if (options.expectedMemberId !== undefined) {
    requireValue(memberId === uuid(options.expectedMemberId, 'EXPECTED_MEMBER_ID_REFUSED'), 'ASSIGNMENT_MEMBER_MISMATCH');
  }
  if (options.expectedProfileHash !== undefined) {
    requireValue(HASH.test(options.expectedProfileHash) && raw.profileHash === options.expectedProfileHash,
      'ASSIGNMENT_PROFILE_MISMATCH');
  }
  return Object.freeze({ version: 1, assignmentId, memberId, adaCode: raw.adaCode,
    hqIdentity: raw.hqIdentity, profileHash: raw.profileHash, assignedAt: utcTime(raw.assignedAt), kind: raw.kind });
}
function canonicalBytes(assignment) {
  // A fixed-order, versioned UTF-8 array prevents delimiter or key-order
  // ambiguity. This digest is an audit binding, not a cryptographic signature.
  return Buffer.from(JSON.stringify([SCOPE, assignment.version, assignment.assignmentId,
    assignment.memberId, assignment.adaCode, assignment.hqIdentity,
    assignment.profileHash, assignment.assignedAt, assignment.kind]), 'utf8');
}
function assignmentBytes(raw, options) { return canonicalBytes(validateAssignment(raw, options)); }
function assignmentHash(raw, options) {
  return crypto.createHash('sha256').update(assignmentBytes(raw, options)).digest('hex');
}
function validateDeliveryBinding(job, rawAssignment, options = {}) {
  requireValue(job && typeof job === 'object', 'DELIVERY_BINDING_REQUIRED');
  const memberId = uuid(job.member_id, 'MEMBER_ID_REFUSED');
  requireValue(typeof job.profile_hash === 'string' && HASH.test(job.profile_hash), 'DELIVERY_PROFILE_HASH_REFUSED');
  if (isLegacyScCode(job.hq_code, memberId)) {
    // Preserve old SC envelopes and idempotency byte-for-byte. Never convert an
    // already queued SC job to AR, including after canonical-code publication.
    requireValue(rawAssignment === undefined || rawAssignment === null, 'LEGACY_ASSIGNMENT_CHANGE_REFUSED');
    return Object.freeze({ kind: 'legacy_sc', memberId, adaCode: job.hq_code, assignmentId: null });
  }
  const assignment = validateAssignment(rawAssignment, { ...options,
    expectedMemberId: memberId, expectedProfileHash: job.profile_hash });
  requireValue(job.hq_code === assignment.adaCode, 'DELIVERY_ASSIGNED_CODE_MISMATCH');
  return Object.freeze({ kind: assignment.kind, memberId, adaCode: assignment.adaCode,
    assignmentId: assignment.assignmentId, assignmentHash: crypto.createHash('sha256').update(canonicalBytes(assignment)).digest('hex') });
}
function validateAlias(raw, rawAssignment, options) {
  exactFields(raw, ['aliasCode', 'assignmentId', 'memberId', 'reason'], 'ALIAS_FIELDS_REFUSED');
  const assignment = validateAssignment(rawAssignment, options);
  requireValue(uuid(raw.memberId, 'MEMBER_ID_REFUSED') === assignment.memberId
    && uuid(raw.assignmentId, 'ASSIGNMENT_ID_REFUSED') === assignment.assignmentId, 'ALIAS_IDENTITY_MISMATCH');
  const sc = raw.aliasCode === legacyScCodeFor(assignment.memberId);
  const scm = raw.aliasCode === legacyScmCodeFor(assignment.memberId);
  requireValue((sc && raw.reason === 'LEGACY_OWNED_ADA_CODE')
    || (scm && raw.reason === 'LEGACY_SCCRM_MEMBER_CODE'), 'ALIAS_CODE_REFUSED');
  return Object.freeze({ aliasCode: raw.aliasCode, memberId: assignment.memberId,
    assignmentId: assignment.assignmentId, reason: raw.reason });
}

module.exports = { MARKER, SCOPE, AssignmentError, legacyScCodeFor, legacyScmCodeFor,
  isLegacyScCode, isAdaArCode, validateAssignment, assignmentBytes, assignmentHash,
  validateDeliveryBinding, validateAlias };
