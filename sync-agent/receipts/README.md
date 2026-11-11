# SCCRM-first receipt delivery

The cashier commits the receipt and its selected member to SCCRM first. Its
immutable outbox is written in that same transaction. The desktop can show the
history immediately while the separate HQ receipt service fills the member
code on an existing Ada sale. This service never creates an Ada sale or points.

The existing member service and assigned-code fanout remain unchanged. They
continue their independent two-second fast lane. Receipt I/O never runs in that
lane or requires AdaFront/AdaSmart to remain open.

## Boundaries

- `SCCRMHQReceiptSync`, LocalService, Session 0, no visible window.
- Folder: `D:\SCCRM-HQ-LiveSync-20261024\receipts` on SERVER / HQ 000.
- API capability: only receipt queue lease/acknowledgement, a separate secret.
- SQL identities: `sccrm_receipt_sync_000/001/003/004/005`; EXECUTE on one owned
  receiver only, denied direct changes to customers, sale tables and points.
- Receiver requires exact member code/profile, branch, POS, receipt, final paid sale
  status, total and every source line's SKU/barcode/unit/quantity/price
  and amount. It only fills an empty `FTCstCode`. Other owners are held for review.
- A literal customer code `0` is also unassigned only when the actual database's
  code-0 profile is exactly ลูกค้าทั่วไป. This exception never guesses ownership:
  an existing cashier-confirmed SCCRM claim supplies the member and frozen bill.
  A real named zero account, other numeric code or another member stays held.
- Under `ada-final-time-v1`, matching final native headers supply the canonical
  closing date/time. The immutable submitted snapshot stays unchanged; each
  native target appends submitted/native observations to `SCCRM_ReceiptTimeAudit`.
  Only the origin branch proof can update the existing SCCRM claim/mirror time.
  No native date/time, financial row or point ledger is rewritten.
- Not-final bills retry. Old `RECEIPT_HEADER_CHANGED` holds are safely rechecked
  once by the upgraded worker; financial/item/profile/owner mismatches stay held.
- Each target has durable leased work and immutable payload identity. An
  expired lease is recovered; lost replies replay the same native journal key.
  A failed branch does not block another. HQ's existing copy is linked separately
  when it arrives; no replacement or invented bill is inserted.
- Backdated linking does not retroactively calculate or award Ada points.
- The receipt connection explicitly enables the SET options required by Ada's
  indexed sale tables, including ARITHABORT. These settings affect only this
  worker connection; database defaults and AdaPos connections are untouched.

## Inspection and stop

Desktop: extra menu → สถานะส่งข้อมูลไป Ada / ลองใหม่. The staff token confines
the log to that branch. StockDay Members has each member's central sync log.

Read `status\service.json` for the headless service heartbeat. It contains job
identifiers and safe status codes, never credentials or customer PINs.

To pause only native receipt delivery, stop **SCCRMHQReceiptSync**. Keep
SCCRMHQMemberSync, SCCRMHQMemberFanout, SCCRMHQPointSync, SQL Server, AdaPos and
Shopee services running. SCCRM saves continue and queued work stays durable.
Restart only SCCRMHQReceiptSync to resume. Do not delete queues/journals or undo
already completed customer/bill links as a software rollback.

## Canonical time upgrade / rollback

Use the isolated `time-copy.cjs` databases and `native-copy.integration.cjs BRANCH
--time-copy`, then `real-time-copy.integration.cjs` for the three approved 004
receipts. Local real payloads, backups and proof live in ignored
`receipts/runtime/canonical-time`; never commit those personal records.

Deploy the compatible official backend first. `upgrade-time.cjs preflight`
backs up the owned receiver definitions and hashes all non-PIN customer fields.
Stop only SCCRMHQReceiptSync, run `upgrade-receivers`, then `stage-worker`, and
start that same service. These commands require committed source and all five
copy proofs; they preserve existing sealed credentials/config and service identity.
`verify-data` compares customers and the three receipts' point rows afterwards.

To roll back software, stop SCCRMHQReceiptSync; restore the four worker files
from `D:\SCCRM-HQ-LiveSync-20261024\receipts\runtime\canonical-time-backup-20261111`
and restore each saved receiver definition/hash from the operator's
`live-before.json` through an administrator-reviewed SQL change. Keep the new
audit table, queues, submitted timestamps and completed member links. Start only
SCCRMHQReceiptSync; the old exact-time receiver safely holds new mismatches.

## Verification

`node --test sync-agent/receipts/worker.test.cjs` checks independent branches,
offline retry, ownership review, lost replies and identity rejection.
`native-copy.integration.cjs <000|001|003|004|005>` uses guarded copies and
transaction rollback, excludes customer PIN columns and compares all 101 other
customer columns plus copied sales before/after. `adapter-copy.integration.cjs`
checks the actual PowerShell/SQL transport, Thai text, dates and outer rollback.

Deployment requires completed copy evidence for all five targets, the reviewed
receiver digest and operator-only provisioning. Default capability is disabled;
enable it only after the new service and private queue are ready. Rollback the
desktop/backend using reviewed releases; keep committed SCCRM history intact.
