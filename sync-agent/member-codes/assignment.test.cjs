'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateAssignment, assignmentBytes, assignmentHash, validateDeliveryBinding,
  validateAlias, isAdaArCode, legacyScCodeFor, legacyScmCodeFor } = require('./assignment.cjs');
const MEMBER = 'aabbccdd-1111-4222-8333-000000000001';
const OTHER = '12345678-1111-4222-8333-000000000002';
const ID = '11223344-1111-4222-8333-000000000003';
const HQ = 'hq000/SERVER.SQLEXPRESS/AdaAcc/owned-test-marker';
const HASH = 'a'.repeat(64);
const options = { expectedHqIdentity: HQ };
const fixture = change => ({ version: 1, assignmentId: ID, memberId: MEMBER, adaCode: 'AR000-000013',
  hqIdentity: HQ, profileHash: HASH, assignedAt: '2026-10-29T06:46:00.000Z', kind: 'hq_create', ...change });
const job = change => ({ member_id: MEMBER, hq_code: 'AR000-000013', profile_hash: HASH, ...change });

test('accepts exact HQ-created tuple and normalizes only UUID/time representation', () => {
  const actual = validateAssignment(fixture({ memberId: MEMBER.toUpperCase(), assignedAt: '2026-10-29T06:46:00Z' }), options);
  assert.equal(actual.memberId, MEMBER); assert.equal(actual.assignedAt, '2026-10-29T06:46:00.000Z');
  assert.equal(Object.isFrozen(actual), true);
});
test('authority identity must be supplied out of band and match exactly', () => {
  assert.throws(() => validateAssignment(fixture()), /HQ_AUTHORITY_CONFIG_REQUIRED/);
  assert.throws(() => validateAssignment(fixture({ hqIdentity: HQ + '-other' }), options), /HQ_AUTHORITY_IDENTITY_MISMATCH/);
  assert.throws(() => validateAssignment(fixture(), { expectedHqIdentity: ' ' + HQ }), /HQ_AUTHORITY_CONFIG_REQUIRED/);
});
test('tuple rejects unknown keys including PIN and embedded profile', () => {
  for (const extra of [{ pin: 'never read' }, { profile: { name: 'not part of tuple' } }, { arbitraryCode: true }]) {
    assert.throws(() => validateAssignment(fixture(extra), options), /ASSIGNMENT_FIELDS_REFUSED/);
  }
  const incomplete = fixture(); delete incomplete.profileHash;
  assert.throws(() => validateAssignment(incomplete, options), /ASSIGNMENT_FIELDS_REFUSED/);
});
test('strict UUID, version and profile digest checks', () => {
  for (const invalid of [{ memberId: 'phone-is-not-an-id' }, { assignmentId: '13' }, { version: 2 },
    { version: '1' }, { profileHash: 'A'.repeat(64) }, { profileHash: 'a'.repeat(63) }]) {
    assert.throws(() => validateAssignment(fixture(invalid), options));
  }
});
test('new creation requires literal HQ AR000-hyphen-six-digit native format', () => {
  for (const code of ['AR000000013', 'AR000-000000', 'AR000-13', 'AR001-000013', 'AR002-000013',
    'AR000-000013 ', 'ar000-000013', 'AR000-000013\n', legacyScCodeFor(MEMBER)]) {
    assert.throws(() => validateAssignment(fixture({ adaCode: code }), options));
  }
});
test('approved legacy branch AR links require explicit approval mode', () => {
  for (const branch of ['000', '001', '003', '004', '005']) {
    const row = fixture({ adaCode: 'AR' + branch + '-000095', kind: 'approved_existing' });
    assert.throws(() => validateAssignment(row, options), /EXISTING_CODE_APPROVAL_REQUIRED/);
    assert.equal(validateAssignment(row, { ...options, allowApprovedExisting: true }).adaCode, row.adaCode);
  }
  assert.equal(isAdaArCode('AR002-000001'), false);
  assert.throws(() => validateAssignment(fixture({ kind: 'caller_claimed' }), { ...options, allowApprovedExisting: true }));
});
test('identity and profile expected values cannot be substituted', () => {
  assert.throws(() => validateAssignment(fixture(), { ...options, expectedMemberId: OTHER }), /ASSIGNMENT_MEMBER_MISMATCH/);
  assert.throws(() => validateAssignment(fixture(), { ...options, expectedProfileHash: 'b'.repeat(64) }), /ASSIGNMENT_PROFILE_MISMATCH/);
});
test('timestamps require real UTC calendar values with millisecond precision', () => {
  for (const assignedAt of ['2026-10-29', '2026-02-30T06:46:00Z', '2026-10-29T24:00:00Z',
    '2026-10-29T06:46:00', '2026-10-29T13:46:00+07:00', '2026-10-29T06:46:00.0001Z']) {
    assert.throws(() => validateAssignment(fixture({ assignedAt }), options), /ASSIGNMENT_TIME_REFUSED/);
  }
});
test('audit bytes and digest are stable regardless of object key ordering', () => {
  const reordered = Object.fromEntries(Object.entries(fixture()).reverse());
  assert.deepEqual(assignmentBytes(fixture(), options), assignmentBytes(reordered, options));
  assert.equal(assignmentHash(fixture(), options), assignmentHash(reordered, options));
  assert.match(assignmentHash(fixture(), options), /^[a-f0-9]{64}$/);
});
test('every authority tuple field is covered by the canonical audit digest', () => {
  const original = assignmentHash(fixture(), options);
  for (const change of [{ assignmentId: OTHER }, { memberId: OTHER }, { adaCode: 'AR000-000014' },
    { profileHash: 'b'.repeat(64) }, { assignedAt: '2026-10-29T06:46:00.003Z' }, { kind: 'approved_existing' }]) {
    assert.notEqual(assignmentHash(fixture(change), { ...options, allowApprovedExisting: true }), original);
  }
  assert.notEqual(assignmentHash(fixture({ hqIdentity: HQ + '/other' }), { expectedHqIdentity: HQ + '/other' }), original);
});
test('AR delivery requires matching authority UUID, code and profile', () => {
  const bound = validateDeliveryBinding(job(), fixture(), options);
  assert.equal(bound.assignmentId, ID); assert.equal(bound.adaCode, 'AR000-000013');
  assert.equal(bound.assignmentHash, assignmentHash(fixture(), options));
  assert.throws(() => validateDeliveryBinding(job(), undefined, options), /ASSIGNMENT_FIELDS_REFUSED/);
  for (const change of [{ member_id: OTHER }, { hq_code: 'AR000-000014' }, { profile_hash: 'b'.repeat(64) }]) {
    assert.throws(() => validateDeliveryBinding(job(change), fixture(), options));
  }
});
test('legacy SC delivery retains exact UUID-derived code without AR reassignment', () => {
  const before = job({ hq_code: legacyScCodeFor(MEMBER) }); const snapshot = JSON.stringify(before);
  const bound = validateDeliveryBinding(before, null);
  assert.equal(bound.kind, 'legacy_sc'); assert.equal(bound.adaCode, before.hq_code);
  assert.equal(JSON.stringify(before), snapshot);
  assert.throws(() => validateDeliveryBinding(before, fixture(), options), /LEGACY_ASSIGNMENT_CHANGE_REFUSED/);
  assert.throws(() => validateDeliveryBinding(job({ hq_code: legacyScCodeFor(OTHER) }), null));
});
test('SC and SCM aliases are exact UUID bindings and keep canonical assignment', () => {
  for (const [aliasCode, reason] of [[legacyScCodeFor(MEMBER), 'LEGACY_OWNED_ADA_CODE'],
    [legacyScmCodeFor(MEMBER), 'LEGACY_SCCRM_MEMBER_CODE']]) {
    const result = validateAlias({ aliasCode, memberId: MEMBER, assignmentId: ID, reason }, fixture(), options);
    assert.equal(result.memberId, MEMBER); assert.equal(result.assignmentId, ID); assert.equal(result.aliasCode, aliasCode);
  }
});
test('aliases cannot silently cross people, swap authority, or claim ordinary AR codes', () => {
  const alias = { aliasCode: legacyScCodeFor(MEMBER), memberId: MEMBER, assignmentId: ID, reason: 'LEGACY_OWNED_ADA_CODE' };
  for (const change of [{ memberId: OTHER }, { assignmentId: OTHER }, { aliasCode: legacyScCodeFor(OTHER) },
    { aliasCode: 'AR004-000095' }, { reason: 'PHONE_MATCH' }, { pin: 'not allowed' }]) {
    assert.throws(() => validateAlias({ ...alias, ...change }, fixture(), options));
  }
});
