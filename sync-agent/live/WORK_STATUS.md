# HQ000 live launch — 24 October 2026

## Inbound history recovery — 13 November 2026

- Runtime code `75ebc990643b52ffb7f667687db25cd3c1758395` is installed on the
  owned `SCCRMHQMemberSync` service. Members, HQ recent receipts and full HQ
  history remain independent. Direct 001/003/004/005 readers are enabled with
  ten-second pauses and five-minute replays from the existing export floor.
- Restored the restricted role's EXECUTE on the pure name-index normalizer.
  A failed customer update had been stopping inbound reconciliation while the
  outgoing member heartbeat still appeared healthy.
- Backfilled 179 verified branch receipts and 532 items under their original
  physical sources. Of these, 171 had no HQ copy; eight HQ copies had an empty
  or general-customer code. Native HQ sales/customer records were preserved.
- The 12:19 Bangkok audit covered 2,671 retained paid member receipts across
  all four branches, including their daily POS001/POS002 tables. Every key,
  original owner, sale date/time, header amount (currency cents) and item count
  matched the canonical mirror. Missing/mismatched receipts: zero.
- Canonical history at that checkpoint: 4,859 receipts. A real branch-born
  member and its new purchase arrived automatically during the pilot, before
  the native HQ customer profile existed. Its receipt and all three items were
  verified through the signed-in StockDay admin UI.
- All four branch readers completed full scans, then healthy zero-write
  replays. Missing profiles, pending items and profile-source errors were zero.
  Runtime uses four destination sessions. An offline source does not hold the
  shared destination queue during network reads.
- Qualified the six-field native profile capability on an owned synthetic SQL
  Server copy for all four home branches. Runtime has view SELECT, denied raw
  customer/PIN reads and denied customer UPDATE. Existing read-only sources
  remain machine-sealed; no administrator credential enters the runtime.
- Thirty inbound/registration tests, crypto-envelope checks and existing
  member-fanout CI passed. The separate official-backend refinement passed
  117 focused tests and its full CI; that PR is still a draft, not deployed.
- The 90-second native settlement interval remains. Ten seconds is a pause
  after a scan, not an unconditional end-to-end delivery guarantee. Historical
  changes before the existing export floor use the bounded operator reader.

Deployment backups and per-file digests are in the owned live service's
`release-backups` directory. Restore code/config to roll back; retain completed
history, native source rows, approved links and point records.

The original October launch evidence below is retained as historical evidence.

User explicitly authorized production integration with the existing Supabase,
without deleting/overwriting Ada customers or interfering with Shopee.

- Initial real import complete: 1,438 Ada customer codes; 4,075 sales; 21 returns;
  12,491 lines. No mass auth-account creation or retrospective points awards.
- Restricted roles provisioned in both databases; native direct customer/sale/
  line UPDATE/DELETE and direct INSERT denied. Only the owned native create
  procedure can add a customer. No PIN access.
- Service `SCCRMHQMemberSync` installed at
  `D:\SCCRM-HQ-LiveSync-20261024` on SERVER; LocalService; delayed automatic;
  hidden worker and own Node runtime. Existing sandbox service left running.
- First healthy cycle 12:13:35Z: created one eligible SCCRM member in Ada;
  three existing-phone conflicts held for review. Customer mirror now 1,439.
- Restarted only this new service after adding one-second SQL lock wait and low
  deadlock priority. Second full replay healthy with zero data changes.
- Live verification 12:17:12Z: 9/9 checks passed; all original 1,438 customers
  match all 101 non-PIN source columns, all original headers/lines complete,
  acknowledged native-create retry returns the same code without overwrite,
  and the original seven online accounts remain seven.
- Worker credentials transferred using RSA encryption; private key protected by
  HQ machine DPAPI and restricted runtime-folder ACL. No plaintext secret file.
- Website adapter PR97 merged as `49c4c2777c1511af442137360df7148850cc3434`;
  feature flag enabled on the official backend only. Render deployment
  `dep-dbea5qcegpmc73bd8ja0` became live at 12:23:56Z. Existing web/POS API
  contracts retained. Backend 51/51 tests passed;
  GitHub's full Backend CI is green; copy adapter 12/12 and unit guards 21/21.
- Live API verification 12:28:12Z: 187 checks passed. The directory contains
  1,442 rows (native codes and existing online members with approved links);
  all original 1,438 source identities are present. Five sampled member
  histories, 61 bills and 157 lines match source owners, SKU, unit code/name,
  quantity, header totals and Bangkok sale timestamps. Anonymous directory
  and customer-history reads still return 401.
- Worker source PR13 merged as `9f7b952882e523e5ee584ceb9aa7a4bfb2fa55e3`.
  Current non-secret launch evidence is on HQ at
  `live\status\launch-summary.json`; detailed development reports remain in
  ignored `live/runtime`. The private development PostgreSQL copy was stopped;
  the HQ live and original sandbox services were left running.

Runtime reports and raw source data are ignored/private. Do not add them to Git.
This release reads native points into the mirror but does not enable two-way
point adjustments or overwrite existing native customer profiles.
