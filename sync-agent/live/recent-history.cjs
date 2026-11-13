'use strict';
const crypto = require('node:crypto');
const { record } = require('../history/model.cjs');
const SOURCE = 'hq000/AdaAcc';
// Re-scan a bounded date window rather than advancing a permanent sale cursor:
// a branch can deliver an older bill after a newer one has already arrived.
async function recentHistory({ pg, source, guard, apply, progress = () => {} }) {
 await guard(pg);
 const window = await source.query('historyWindow');
 const floor = window[0]?.floor;
 if (!/^\d{4}-\d{2}-\d{2}T00:00:00(?:\.000)?$/.test(floor || '')) throw Error('RECENT_WINDOW_REFUSED');
 const snapshot = crypto.randomUUID();
 let afterDate = floor, afterDoc = '', receiptCount = 0, lineCount = 0, written = 0, pendingCount = 0, missingCustomerCount = 0;
 async function send(kind, records, cursor) {
  if (!records.length) return;
  const column = { customers: 'ada_code', receipts: 'receipt_key', lines: 'line_key' }[kind];
  const cached = new Map((await pg.query(`SELECT ${column} source_key,payload_hash FROM ada_history.${kind} WHERE source_id=$1 AND ${column}=ANY($2::text[])`, [SOURCE, records.map(r => r.key)])).rows.map(r => [r.source_key.trim(), r.payload_hash]));
  const changed = records.filter(r => cached.get(r.key) !== r.payloadHash);
  for (let i = 0; i < changed.length; i += 100) written += await apply(pg, kind, changed.slice(i, i + 100), snapshot, cursor);
 }
 for (;;) {
  const rows = await source.query('recentReceipts', { floor, afterDate, afterDoc });
  if (!rows.length) break;
  if (rows.length > 100) throw Error('RECENT_PAGE_SCOPE_REFUSED');
  const last = rows.at(-1);
  if (last.FDShdDocDate < afterDate || (last.FDShdDocDate === afterDate && last.FTShdDocNo <= afterDoc)) throw Error('RECENT_CURSOR_NOT_ADVANCING');
  const headers = new Map(rows.map(h => [h.FTShdDocNo, h]));
  if (headers.size !== rows.length) throw Error('RECENT_DUPLICATE_DOCUMENT');
  const lines = await source.query('lines', { docs: [...headers.keys()] });
  // Validate every returned row before any PostgreSQL write. Unknown parents,
  // changed owners and secret-bearing payloads fail closed in the shared model.
  const lineRecords = lines.map(p => record('lines', p, headers));
  const withLines = new Set(lines.map(p => p.FTShdDocNo));
  const ready = rows.filter(h => withLines.has(h.FTShdDocNo));
  pendingCount += rows.length - ready.length;
  const codes = [...new Set(ready.map(h => h.FTCstCode))];
  const customers = codes.length ? await source.query('customersForCodes', { codes }) : [];
  if (customers.some(c => !codes.includes(c.FTCstCode)) || new Set(customers.map(c => c.FTCstCode)).size !== customers.length) throw Error('RECENT_CUSTOMER_SCOPE_REFUSED');
  const missingCodes = codes.filter(code => !customers.some(c => c.FTCstCode === code));
  if (missingCodes.length) {
   const resolved = new Set((await pg.query("SELECT ada_code FROM ada_history.customer_profiles WHERE source_id='hq000/AdaAcc' AND ada_code=ANY($1::text[])", [missingCodes])).rows.map(c => c.ada_code));
   missingCustomerCount += missingCodes.filter(code => !resolved.has(code)).length;
  }
  const customerRecords = customers.map(p => record('customers', p));
  const headerRecords = ready.map(p => record('receipts', p));
  // Never expose a newly imported header without its item snapshot. Source I/O
  // completes first, keeping the destination transaction short.
  await pg.query('BEGIN');
  try {
   await send('customers', customerRecords, last.FTShdDocNo);
   await send('receipts', headerRecords, last.FTShdDocNo);
   await send('lines', lineRecords, last.FTShdDocNo);
   await pg.query('COMMIT');
  } catch (error) { await pg.query('ROLLBACK'); throw error; }
  receiptCount += ready.length; lineCount += lines.length;
  afterDate = last.FDShdDocDate; afterDoc = last.FTShdDocNo;
  progress({ receiptCount, lineCount, pendingCount, missingCustomerCount });
 }
 return { receiptCount, lineCount, written, pendingCount, missingCustomerCount };
}
module.exports = { recentHistory };
