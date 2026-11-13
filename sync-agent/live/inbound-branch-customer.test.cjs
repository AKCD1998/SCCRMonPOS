'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const { readBranchCustomer } = require('./branch-customer.cjs');
const receipt = { branchCode: '003', posCode: '001', receiptNo: 'S2611003001-0000001', adaCode: 'AR003-000001' };
function fixture(change = {}) {
 const admin = { password: 'synthetic-stdin-only' }; let options;
 const packet = { ok: true, branch: '003', nativeSourceId: 'branch003/AdaAcc', productionWrites: 0, pinRead: false,
  customer: { FTCstCode: receipt.adaCode, FTBchCode: '003', FTCstName: 'Synthetic private profile' },
  header: { FTCstCode: receipt.adaCode, FTBchCode: '003', FTPosCode: '001', FTShdDocNo: receipt.receiptNo, FTShdDocType: '1', FTShdStaPaid: '3' }, ...change };
 return { admin, get options() { return options; }, run: () => readBranchCustomer('003', receipt, {
  readAdmin: () => admin, spawnSync: (_file, _args, opts) => { options = opts; return { status: 0, stdout: JSON.stringify(packet) }; }
 }) };
}
test('operator branch read pins the exact original owner and uses stdin for bootstrap credentials', () => {
 const f = fixture(), result = f.run();
 assert.equal(result.customer.FTCstCode, receipt.adaCode); assert.equal(f.admin.password, '');
 assert.equal(JSON.parse(f.options.input).admin.password, 'synthetic-stdin-only');
 assert.equal(f.options.windowsHide, true);
});
test('wrong native acknowledgement refuses the profile and clears the credential reference', () => {
 for (const change of [{ branch: '004' }, { pinRead: true }, { productionWrites: 1 }, { customer: { FTCstCode: 'AR003-000002', FTBchCode: '003' } }]) {
  const f = fixture(change); assert.throws(f.run, /BRANCH_PROFILE_ACK_REFUSED/); assert.equal(f.admin.password, '');
 }
});
test('out-of-scope branches and owner codes fail before any credential read', () => {
 assert.throws(() => readBranchCustomer('000', receipt), /BRANCH_PROFILE_SCOPE_REFUSED/);
 assert.throws(() => readBranchCustomer('003', { ...receipt, adaCode: 'AR004-000001' }), /BRANCH_PROFILE_SCOPE_REFUSED/);
});
