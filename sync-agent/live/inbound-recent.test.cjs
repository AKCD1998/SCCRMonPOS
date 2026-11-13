'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const { recentHistory } = require('./recent-history.cjs');
const { configuration } = require('./scheduler.cjs');
function fixture({ noLines = false, wrongCustomer = false, failLines = false } = {}) {
 const calls = [], writes = [], transactions = [];
 const header = { FTBchCode: '001', FTPosCode: 'POS001', FTShdDocType: '1', FTShdDocNo: 'S2611001001-0000001', FTCstCode: 'AR001-000001', FTShdStaPaid: '3', FDShdDocDate: '2026-11-13T00:00:00.000', FTShdDocTime: '10:00:00' };
 const line = { FTShdDocNo: header.FTShdDocNo, FNSdtSeqNo: 1, FTBchCode: '001', FCSdtQty: '2.5' };
 const source = { async query(action, params) {
  calls.push([action, params]);
  if (action === 'historyWindow') return [{ floor: '2026-11-11T00:00:00' }];
  if (action === 'recentReceipts') return params.afterDoc ? [] : [header];
  if (action === 'lines') return noLines ? [] : [line];
  if (action === 'customersForCodes') return [{ FTCstCode: wrongCustomer ? 'AR002-000001' : header.FTCstCode, FTCstName: 'Synthetic member' }];
  throw Error('UNEXPECTED_SOURCE_ACTION');
 } };
 const pg = { async query(sql) { transactions.push(sql); return { rows: [] }; } };
 const apply = async (_pg, kind, records) => { writes.push([kind, records]); if (failLines && kind === 'lines') throw Error('FIXTURE_LINE_FAILURE'); return records.length; };
 return { calls, writes, transactions, run: () => recentHistory({ pg, source, guard: async () => {}, apply }) };
}
test('fast inbound gets exact owners and complete items before opening its atomic destination transaction', async () => {
 const f = fixture(); const result = await f.run();
 assert.deepEqual(f.writes.map(w => w[0]), ['customers', 'receipts', 'lines']);
 assert.equal(result.receiptCount, 1); assert.equal(result.lineCount, 1);
 assert.equal(f.writes[2][1][0].owner, 'AR001-000001');
 assert.ok(f.transactions.indexOf('BEGIN') >= 0); assert.equal(f.transactions.at(-1), 'COMMIT');
 assert.equal(f.calls[0][0], 'historyWindow');
 assert.deepEqual(f.calls.find(c => c[0] === 'customersForCodes')[1].codes, ['AR001-000001']);
});
test('a header without items is retried on the next window scan and is never published alone', async () => {
 const f = fixture({ noLines: true }); const result = await f.run();
 assert.equal(result.pendingCount, 1); assert.equal(result.receiptCount, 0);
 assert.equal(f.writes.length, 0);
 assert.equal(f.calls.some(c => c[0] === 'customersForCodes'), false);
});
test('a source customer outside the requested exact owner codes refuses the batch before any transaction', async () => {
 const f = fixture({ wrongCustomer: true }); await assert.rejects(f.run(), /RECENT_CUSTOMER_SCOPE_REFUSED/);
 assert.equal(f.writes.length, 0); assert.equal(f.transactions.includes('BEGIN'), false);
});
test('a failed item import rolls back the header and customer batch', async () => {
 const f = fixture({ failLines: true }); await assert.rejects(f.run(), /FIXTURE_LINE_FAILURE/);
 assert.equal(f.transactions.at(-1), 'ROLLBACK'); assert.equal(f.transactions.includes('COMMIT'), false);
});
test('receipt polling is bounded independently from the slower reconciliation interval', () => {
 assert.equal(configuration({}).receiptPollMs, 10000);
 assert.equal(configuration({}).historyPollMs, 300000);
 for (const receiptPollMs of [0, 4999, 60001, 1.5]) assert.throws(() => configuration({ receiptPollMs }), /LIVE_POLL_CONFIG_REFUSED/);
});
