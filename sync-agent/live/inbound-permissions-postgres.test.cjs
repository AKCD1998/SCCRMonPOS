'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { Client } = require('pg');
const { apply, synchronize, MARKER, SCOPE } = require('./worker.cjs');
const { record } = require('../history/model.cjs');
const { recentHistory } = require('./recent-history.cjs');
const raw = process.env.SCCRM_INBOUND_TEST_DATABASE_URL;

test('restricted inbound customer updates survive the private expression-index normalizer', { skip: !raw }, async (t) => {
 const url = new URL(raw);
 assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Local DB only');
 assert.match(url.pathname, /^\/sccrm_inbound_test_[a-z0-9_]+$/);
 assert.ok(url.port && url.port !== '5432', 'Explicit isolated test port required');
 const admin = new Client({ connectionString: raw, ssl: false });
 const workerUrl = new URL(raw); workerUrl.username = 'sccrm_hq_live_sync'; workerUrl.password = 'inbound-local-fixture';
 const worker = new Client({ connectionString: workerUrl.href, ssl: false });
 try {
  await admin.connect();
  assert.equal((await admin.query("SELECT to_regnamespace('ada_history') n")).rows[0].n, null, 'Fresh database required');
  await admin.query(`DO $$ BEGIN CREATE ROLE sccrm_hq_live_sync LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD 'inbound-local-fixture'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
   DO $$ BEGIN CREATE ROLE inbound_other NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
   CREATE TABLE public.users(id uuid PRIMARY KEY,full_name text,phone_number text);
   CREATE TABLE public.member_profiles(user_id uuid,member_code text,is_active boolean,created_at timestamptz);
   CREATE TABLE public.loyalty_claims(branch_code text,receipt_no text,user_id uuid);
   CREATE TABLE public.native_points(member_id uuid,points integer);`);
  await admin.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  const original = fs.readFileSync(path.join(__dirname, '../../supabase/migrations/20261103035705_hq_member_fast_existing_links.sql'), 'utf8');
  await admin.query(original.slice(0, original.indexOf('CREATE FUNCTION ada_history.local_member_phone')));
  await admin.query(`REVOKE ALL ON FUNCTION ada_history.member_name_key(text) FROM PUBLIC;
   CREATE INDEX history_customer_active_name_lookup ON ada_history.customers(source_id,ada_history.member_name_key(name)) WHERE active='1';
   GRANT USAGE ON SCHEMA ada_history TO sccrm_hq_live_sync,inbound_other;
   GRANT SELECT ON ALL TABLES IN SCHEMA ada_history TO sccrm_hq_live_sync;
   GRANT INSERT,UPDATE ON ada_history.customers,ada_history.receipts,ada_history.lines,ada_history.checkpoints TO sccrm_hq_live_sync;
   GRANT INSERT ON ada_history.change_journal TO sccrm_hq_live_sync;
   GRANT USAGE ON ALL SEQUENCES IN SCHEMA ada_history TO sccrm_hq_live_sync;
   GRANT EXECUTE ON FUNCTION ada_history.apply_batch(text,text,text,jsonb,uuid,text) TO sccrm_hq_live_sync;`);
  await admin.query('INSERT INTO ada_history.meta VALUES($1,$2)', [MARKER, SCOPE]);
  await worker.connect();
  const snapshot = '11223344-0000-4000-8000-000000000001';
  const payload = { FTCstCode: 'AR001-000001', FTCstName: 'Synthetic member', FTCstStaActive: '1', FTBchCode: '001' };
  await assert.rejects(apply(worker, 'customers', [record('customers', payload)], snapshot, payload.FTCstCode), { code: '42501' });
  assert.equal((await admin.query('SELECT count(*)::int n FROM ada_history.customers')).rows[0].n, 0);
  const migration = fs.readFileSync(path.join(__dirname, '../../supabase/migrations/20261113030332_ada_inbound_name_index_permission.sql'), 'utf8');
  await admin.query(migration); await admin.query(migration);
  assert.equal(await apply(worker, 'customers', [record('customers', payload)], snapshot, payload.FTCstCode), 1);
  assert.equal(await apply(worker, 'customers', [record('customers', payload)], snapshot, payload.FTCstCode), 0);
  payload.FTCstName = 'Synthetic renamed member';
  assert.equal(await apply(worker, 'customers', [record('customers', payload)], snapshot, payload.FTCstCode), 1);
  assert.equal((await admin.query('SELECT name FROM ada_history.customers')).rows[0].name, payload.FTCstName);
  assert.deepEqual((await admin.query(`SELECT
   has_function_privilege('sccrm_hq_live_sync','ada_history.member_name_key(text)','EXECUTE') worker,
   has_function_privilege('inbound_other','ada_history.member_name_key(text)','EXECUTE') other,
   has_table_privilege('sccrm_hq_live_sync','public.users','INSERT') users_insert,
   has_table_privilege('sccrm_hq_live_sync','public.native_points','UPDATE') points_update,
   (SELECT prosecdef FROM pg_proc WHERE oid='ada_history.member_name_key(text)'::regprocedure) security_definer`)).rows[0],
   { worker: true, other: false, users_insert: false, points_update: false, security_definer: false });
  await t.test('recent replay catches late older bills, returns and item changes without duplicate history', async () => {
   const header = (no, date, type = '1') => ({ FTShdDocNo: no, FDShdDocDate: date, FTShdDocTime: '10:00:00', FTBchCode: '001', FTPosCode: 'POS001', FTShdDocType: type, FTShdStaPaid: '3', FTCstCode: payload.FTCstCode, FCShdGrand: '25.5', FCShdTotal: '30' });
   let headers = [header('S2611001001-0000002', '2026-11-13T00:00:00.000')];
   let qty = '2.5';
   const source = { async query(action, params) {
    if (action === 'historyWindow') return [{ floor: '2026-11-11T00:00:00' }];
    if (action === 'recentReceipts') return headers.filter(h => h.FDShdDocDate > params.afterDate || (h.FDShdDocDate === params.afterDate && h.FTShdDocNo > params.afterDoc)).sort((a, b) => a.FDShdDocDate.localeCompare(b.FDShdDocDate) || a.FTShdDocNo.localeCompare(b.FTShdDocNo)).slice(0, 1);
    if (action === 'customersForCodes') return [payload];
    if (action === 'lines') return params.docs.map(doc => ({ FTShdDocNo: doc, FNSdtSeqNo: 1, FTPdtCode: 'SYNTHETIC-SKU', FTPunCode: 'BOX', FTSdtUnitName: 'Synthetic unit', FCSdtQty: qty, FCSdtSalePrice: '10.2', FCSdtNet: '25.5' }));
    throw Error('UNEXPECTED_SOURCE_ACTION');
   } };
   const run = () => recentHistory({ pg: worker, source, guard: async () => {}, apply });
   assert.equal((await run()).receiptCount, 1);
   assert.equal((await run()).written, 0);
   headers.push(header('S2611001001-0000001', '2026-11-12T00:00:00.000'), header('R2611001001-0000001', '2026-11-13T00:00:00.000', '9'));
   assert.equal((await run()).receiptCount, 3);
   assert.equal((await admin.query('SELECT count(*)::int n FROM ada_history.receipts')).rows[0].n, 3);
   assert.equal((await admin.query('SELECT count(*)::int n FROM ada_history.purchase_claims')).rows[0].n, 3);
   assert.equal(Number((await admin.query("SELECT receipt_total_amount FROM ada_history.purchase_claims WHERE receipt_snapshot->>'documentType'='return'")).rows[0].receipt_total_amount), -25.5);
   qty = '3.5'; assert.equal((await run()).written, 3);
   assert.ok((await admin.query('SELECT quantity,unit_name FROM ada_history.lines')).rows.every(r => Number(r.quantity) === 3.5 && r.unit_name === 'Synthetic unit'));
   assert.equal((await run()).written, 0);
  });
  await t.test('a verified branch-only profile reveals its own orphan bill and yields to the exact HQ profile', async () => {
   await admin.query(fs.readFileSync(path.join(__dirname, '../../supabase/migrations/20261113031659_ada_inbound_branch_customer_profiles.sql'), 'utf8'));
   const branchCustomer = { FTCstCode: 'AR003-000099', FTCstName: 'Synthetic branch-only member', FTCstTel: '0990000099', FTBchCode: '003', FTCstStaActive: '1' };
   const header = { FTShdDocNo: 'S2611003001-0000099', FDShdDocDate: '2026-11-10T00:00:00.000', FTShdDocTime: '14:00:00', FTBchCode: '003', FTPosCode: '001', FTShdDocType: '1', FTShdStaPaid: '3', FTCstCode: branchCustomer.FTCstCode, FCShdGrand: '123.45' };
   const receipt = record('receipts', header);
   await apply(worker, 'receipts', [receipt], snapshot, header.FTShdDocNo);
   assert.equal((await admin.query('SELECT count(*)::int n FROM ada_history.purchase_claims WHERE receipt_no=$1', [header.FTShdDocNo])).rows[0].n, 0);
   const importProfile = (customer = branchCustomer, proof = header) => worker.query('SELECT ada_history.apply_branch_customer_profile($1,$2,$3,$4::jsonb,$5,$6,$7::jsonb) n', [MARKER, SCOPE, '003', JSON.stringify(customer), record('customers', customer).payloadHash, snapshot, JSON.stringify(proof)]);
   await assert.rejects(importProfile(branchCustomer, { ...header, FTCstCode: 'AR003-000098' }), /BRANCH_CUSTOMER_SCOPE_REFUSED/);
   await assert.rejects(importProfile(branchCustomer, { ...header, FCShdGrand: '123.46' }), /BRANCH_RECEIPT_PROOF_REQUIRED/);
   await assert.rejects(importProfile({ ...branchCustomer, FTBchCode: '004' }), /BRANCH_CUSTOMER_SCOPE_REFUSED/);
   assert.equal((await importProfile()).rows[0].n, 1);
   assert.equal((await importProfile()).rows[0].n, 0);
   assert.equal((await admin.query('SELECT count(*)::int n FROM ada_history.customers WHERE ada_code=$1', [branchCustomer.FTCstCode])).rows[0].n, 0);
   const profile = (await worker.query('SELECT directory_id,profile_origin,native_source_id FROM ada_history.customer_profiles WHERE ada_code=$1', [branchCustomer.FTCstCode])).rows[0];
   assert.equal(profile.profile_origin, 'branch'); assert.equal(profile.native_source_id, 'branch003/AdaAcc');
   const claim = (await worker.query('SELECT user_id FROM ada_history.purchase_claims WHERE receipt_no=$1', [header.FTShdDocNo])).rows[0];
   assert.equal(claim.user_id, profile.directory_id);
   assert.equal((await worker.query('SELECT count(*)::int n FROM ada_history.directory WHERE id=$1', [profile.directory_id])).rows[0].n, 1);
   assert.equal((await admin.query('SELECT count(*)::int n FROM ada_history.member_links')).rows[0].n, 0);
   assert.equal((await admin.query('SELECT count(*)::int n FROM public.users')).rows[0].n, 0);
   await apply(worker, 'customers', [record('customers', { ...branchCustomer, FTCstName: 'Synthetic HQ authoritative name' })], snapshot, branchCustomer.FTCstCode);
   assert.equal((await importProfile()).rows[0].n, 0);
   const authoritative = (await worker.query('SELECT directory_id,profile_origin,name FROM ada_history.customer_profiles WHERE ada_code=$1', [branchCustomer.FTCstCode])).rows;
   assert.deepEqual(authoritative, [{ directory_id: profile.directory_id, profile_origin: 'hq', name: 'Synthetic HQ authoritative name' }]);
   assert.equal((await worker.query('SELECT count(*)::int n FROM ada_history.purchase_claims WHERE receipt_no=$1', [header.FTShdDocNo])).rows[0].n, 1);
   assert.equal((await admin.query("SELECT has_table_privilege('inbound_other','ada_history.branch_customer_profiles','SELECT') allowed")).rows[0].allowed, false);
  });
  await t.test('physical branch receipts fill HQ gaps without duplicate history or reassigned public claims', async () => {
   await admin.query(fs.readFileSync(path.join(__dirname, '../../supabase/migrations/20261113035114_ada_inbound_branch_receipts.sql'), 'utf8'));
   const header = { FTShdDocNo: 'S2404003001-0000098', FDShdDocDate: '2024-04-11T00:00:00.000', FTShdDocTime: '14:01:02', FTBchCode: '003', FTPosCode: '001', FTShdDocType: '1', FTShdStaPaid: '3', FTShdStaDoc: '1', FTCstCode: 'AR003-000099', FCShdGrand: '32.5' };
   const branchApply = async (sourceId,kind,records) => Number((await worker.query('SELECT ada_history.apply_source_batch($1,$2,$3,$4,$5::jsonb,$6,$7) n',[sourceId,MARKER,SCOPE,kind,JSON.stringify(records.map(r=>({source_key:r.key,owner_code:r.owner,parent_key:r.parent,payload_hash:r.payloadHash,payload:r.payload}))),snapshot,header.FTShdDocNo])).rows[0].n);
   const receipt = record('receipts',header);
   assert.equal(await branchApply('branch003/AdaAcc','receipts',[receipt]),1);
   const line=record('lines',{FTShdDocNo:header.FTShdDocNo,FTBchCode:'003',FNSdtSeqNo:1,FTPdtCode:'SYNTHETIC-BRANCH-SKU',FTSdtUnitName:'Synthetic box',FCSdtQty:'2.5',FCSdtNet:'32.5'},new Map([[header.FTShdDocNo,header]]));
   assert.equal(await branchApply('branch003/AdaAcc','lines',[line]),1);
   assert.equal(await branchApply('branch003/AdaAcc','receipts',[receipt]),0);
   const read=()=>worker.query('SELECT user_id,receipt_total_amount,receipt_snapshot FROM ada_history.purchase_claims WHERE receipt_no=$1',[header.FTShdDocNo]);
   const before=(await read()).rows;assert.equal(before.length,1);assert.equal(Number(before[0].receipt_total_amount),32.5);
   assert.equal(before[0].receipt_snapshot.items[0].productCode,'SYNTHETIC-BRANCH-SKU');
   await apply(worker,'receipts',[receipt],snapshot,header.FTShdDocNo);
   await apply(worker,'lines',[line],snapshot,header.FTShdDocNo);
   assert.deepEqual((await read()).rows,before);
   assert.equal((await worker.query('SELECT count(*)::int n FROM ada_history.history_receipts WHERE doc_no=$1',[header.FTShdDocNo])).rows[0].n,1);
   await assert.rejects(branchApply('branch003/AdaAcc','receipts',[record('receipts',{...header,FTCstCode:'AR003-000098'})]),/BRANCH_HQ_OWNER_CONFLICT/);
   await assert.rejects(branchApply('unowned/AdaAcc','receipts',[receipt]),/HISTORY_SOURCE_REFUSED/);
   await assert.rejects(branchApply('branch004/AdaAcc','receipts',[receipt]),/BRANCH_HISTORY_SCOPE_REFUSED/);
   await assert.rejects(branchApply('branch003/AdaAcc','customers',[record('customers',payload)]),/BRANCH_HISTORY_KIND_REFUSED/);
   await assert.rejects(branchApply('branch003/AdaAcc','receipts',[record('receipts',{...header,FTShdStaDoc:'0'})]),/BRANCH_HISTORY_NOT_FINAL/);
   const claimed={...header,FTShdDocNo:'S2404003001-0000097'};
   await admin.query('INSERT INTO public.loyalty_claims VALUES($1,$2,$3)',['003',claimed.FTShdDocNo,'11223344-0000-4000-8000-000000000099']);
   await assert.rejects(branchApply('branch003/AdaAcc','receipts',[record('receipts',claimed)]),/BRANCH_CLAIM_OWNER_CONFLICT/);
   assert.equal((await admin.query('SELECT count(*)::int n FROM ada_history.receipts WHERE doc_no=$1',[claimed.FTShdDocNo])).rows[0].n,0);
   await admin.query('UPDATE public.loyalty_claims SET user_id=$1 WHERE receipt_no=$2',[before[0].user_id,claimed.FTShdDocNo]);
   assert.equal(await branchApply('branch003/AdaAcc','receipts',[record('receipts',claimed)]),1);
   assert.equal((await worker.query('SELECT count(*)::int n FROM ada_history.purchase_claims WHERE receipt_no=$1',[claimed.FTShdDocNo])).rows[0].n,0);
   assert.equal((await admin.query("SELECT has_column_privilege('sccrm_hq_live_sync','public.loyalty_claims','user_id','SELECT') allowed")).rows[0].allowed,false);
   assert.equal((await admin.query("SELECT has_function_privilege('inbound_other','ada_history.apply_source_batch(text,text,text,text,jsonb,uuid,text)','EXECUTE') allowed")).rows[0].allowed,false);
   const atomicHeader={...header,FTShdDocNo:'S2404004001-0000099',FTBchCode:'004'};
   const atomicLine={FTShdDocNo:atomicHeader.FTShdDocNo,FTBchCode:'004',FNSdtSeqNo:1,FCSdtQty:'1.5',FCSdtNet:'32.5'};
   const serialize=r=>({source_key:r.key,owner_code:r.owner,parent_key:r.parent,payload_hash:r.payloadHash,payload:r.payload});
   const packet=async lines=>Number((await worker.query('SELECT ada_history.apply_branch_receipt_packet($1,$2,$3,$4::jsonb,$5::jsonb,$6) n',['branch004/AdaAcc',MARKER,SCOPE,JSON.stringify([serialize(record('receipts',atomicHeader))]),JSON.stringify(lines.map(p=>serialize(record('lines',p,new Map([[atomicHeader.FTShdDocNo,atomicHeader]]))))),snapshot])).rows[0].n);
   await assert.rejects(packet([]),/BRANCH_PACKET_SCOPE_REFUSED/);
   await assert.rejects(worker.query('SELECT ada_history.apply_branch_receipt_packet($1,$2,$3,$4::jsonb,$5::jsonb,$6)',['branch004/AdaAcc',MARKER,SCOPE,JSON.stringify([serialize(record('receipts',atomicHeader))]),JSON.stringify([{...serialize(record('lines',atomicLine,new Map([[atomicHeader.FTShdDocNo,atomicHeader]]))),owner_code:'AR003-000098'}]),snapshot]),/LINE_OWNER_OR_IDENTITY_MISMATCH/);
   assert.equal((await admin.query('SELECT count(*)::int n FROM ada_history.receipts WHERE doc_no=$1',[atomicHeader.FTShdDocNo])).rows[0].n,0);
   assert.equal(await packet([atomicLine]),2);assert.equal(await packet([atomicLine]),0);
  });
  await t.test('native legacy codes and later HQ arrivals retain the exact original branch owner',async()=>{
   await admin.query(fs.readFileSync(path.join(__dirname,'../../supabase/migrations/20261113041249_ada_inbound_source_identity_guards.sql'),'utf8'));
   const customer={FTCstCode:'LEGACY_NATIVE_1',FTCstName:'Synthetic native legacy identity',FTBchCode:'004',FTCstStaActive:'1'};
   await apply(worker,'customers',[record('customers',customer)],snapshot,customer.FTCstCode);
   const h={FTShdDocNo:'S2404004001-0000096',FTBchCode:'004',FTPosCode:'001',FTShdDocType:'1',FTShdStaPaid:'3',FTShdStaDoc:'1',FTCstCode:customer.FTCstCode,FDShdDocDate:'2024-04-11T00:00:00.000',FTShdDocTime:'14:01:02',FCShdGrand:'17.5'};
   const rh=record('receipts',h),serialize=r=>({source_key:r.key,owner_code:r.owner,parent_key:r.parent,payload_hash:r.payloadHash,payload:r.payload});
   await worker.query('SELECT ada_history.apply_source_batch($1,$2,$3,$4,$5::jsonb,$6,$7)',['branch004/AdaAcc',MARKER,SCOPE,'receipts',JSON.stringify([serialize(rh)]),snapshot,h.FTShdDocNo]);
   await assert.rejects(apply(worker,'receipts',[record('receipts',{...h,FTCstCode:'AR003-000099'})],snapshot,h.FTShdDocNo),/CROSS_SOURCE_RECEIPT_OWNER_CONFLICT/);
   assert.equal((await worker.query("SELECT count(*)::int n FROM ada_history.receipts WHERE source_id='hq000/AdaAcc' AND doc_no=$1",[h.FTShdDocNo])).rows[0].n,0);
   await apply(worker,'receipts',[rh],snapshot,h.FTShdDocNo);
   assert.equal((await worker.query('SELECT count(*)::int n FROM ada_history.history_receipts WHERE doc_no=$1',[h.FTShdDocNo])).rows[0].n,1);
  });
  await t.test('full HQ reconciliation also rolls back a header when a later item chunk fails',async()=>{
   const h={FTShdDocNo:'S2611003001-0000095',FTBchCode:'003',FTPosCode:'001',FTShdDocType:'1',FTShdStaPaid:'3',FTShdStaDoc:'1',FTCstCode:'AR003-000099',FDShdDocDate:'2026-11-13T00:00:00.000',FTShdDocTime:'14:01:02',FCShdGrand:'12.5'};
   let qty='invalid-number';
   const source={async query(action,params){
    if(action==='customers')return [];
    if(action==='receipts')return params.afterCustomer?[]:[h];
    if(action==='lines')return [{FTShdDocNo:h.FTShdDocNo,FTBchCode:'003',FNSdtSeqNo:1,FCSdtQty:qty,FCSdtNet:'12.5'}];
    throw Error('UNEXPECTED_SOURCE_ACTION');
   }};
   await assert.rejects(synchronize(worker,source,()=>{}),{code:'22P02'});
   assert.equal((await worker.query('SELECT count(*)::int n FROM ada_history.receipts WHERE doc_no=$1',[h.FTShdDocNo])).rows[0].n,0);
   qty='1.5';assert.equal((await synchronize(worker,source,()=>{})).written,2);
   assert.equal((await synchronize(worker,source,()=>{})).written,0);
  });
 } finally { await Promise.allSettled([worker.end(), admin.end()]); }
});
