'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { outbound } = require('./worker.cjs');
const { digestMember } = require('./existing-members.cjs');
const id = '11223344-0000-4000-8000-000000000001', requestId = '11223344-0000-4000-8000-000000000002';
function fixture({ enabled = true, changed = false, oldReview = false, approved = true } = {}) {
  const member = { id, full_name: 'Synthetic separate person', phone_number: '0990000001', email: null };
  if (approved) Object.assign(member, { distinct_request_id: requestId, confirmed_profile_hash: changed ? 'a'.repeat(64) : digestMember(member) });
  const calls = [], writes = [], outcomes = [];
  const pg = { async query(sql, values) {
    calls.push(sql);
    if (sql.startsWith('SELECT u.id')) return { rows: [member] };
    if (sql.includes('pending_approved_member_links')) return { rows: [] };
    if (sql.startsWith('SELECT * FROM ada_history.outbound_state')) return { rows: oldReview ? [{ state: 'review', profile_hash: digestMember(member) }] : [] };
    if (sql.includes('existing_member_candidate')) { writes.push('existing-lookup'); return { rows: [] }; }
    if (sql.includes('SELECT member_id FROM ada_history.member_links')) return { rows: [{ member_id: id }] };
    if (sql.includes('apply_batch')) return { rows: [{ n: 1 }] };
    writes.push([sql, values]); return { rows: [] };
  } };
  const source = { async query(action, payload) {
    writes.push([action, payload]);
    if (action === 'createMember') return [{ member_id: id, ada_code: 'AR000-000101' }];
    if (action === 'customer') return [{ FTCstCode: payload.code, FTCstName: member.full_name, FTCstTel: member.phone_number }];
    throw Error('UNEXPECTED_SOURCE_ACTION');
  } };
  return { calls, writes, outcomes, run: () => outbound(pg, source, { registrationConfirmationEnabled: enabled, onOutcome: row => outcomes.push(row) }) };
}
test('shared-contact choice reaches the native protocol with the exact confirmation UUID and never auto-links', async () => {
  const f = fixture(); assert.deepEqual(await f.run(), { created: 1, linked: 0, review: 0 });
  assert.equal(f.writes.find(row => row[0] === 'createMember')[1].distinctRequest, requestId);
  assert.equal(f.writes.includes('existing-lookup'), false); assert.equal(f.outcomes[0].memberId, id);
  assert.ok(f.calls[0].includes('m.contact_phone'));
});
test('a new explicit confirmation can release a previously held same-profile registration', async () => {
  const f = fixture({ oldReview: true }); assert.equal((await f.run()).created, 1);
});
test('edited profile invalidates shared-phone approval and stays held without auto-linking or native writes', async () => {
  const f = fixture({ changed: true }); assert.deepEqual(await f.run(), { created: 0, linked: 0, review: 1 });
  assert.equal(f.writes.some(row => Array.isArray(row) && ['createMember', 'customer'].includes(row[0])), false);
  assert.equal(f.writes.includes('existing-lookup'), false);
  assert.ok(f.writes.some(row => Array.isArray(row) && row[1]?.includes('REGISTRATION_CONFIRMATION_PROFILE_CHANGED')));
});
test('old clients keep existing-customer review and do not receive shared-phone bypass', async () => {
  const f = fixture({ approved: false }); await f.run();
  assert.equal(f.writes.includes('existing-lookup'), true);
  assert.equal(f.writes.find(row => row[0] === 'createMember')[1].distinctRequest, undefined);
});
test('feature remains off without provisioning and does not query new columns or approval tables', async () => {
  const f = fixture({ enabled: false, approved: false }); await f.run();
  assert.ok(f.calls[0].includes('u.phone_number AS phone_number'));
  assert.equal(f.calls[0].includes('sccrm_registration'), false);
  assert.equal(f.calls[0].includes('m.contact_phone'), false);
});
