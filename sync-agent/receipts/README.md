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
- Receiver requires exact member code/profile, branch, POS, receipt, paid sale
  status, total, date/time and every source line's SKU/barcode/unit/quantity/price
  and amount. It only fills an empty `FTCstCode`. Other owners are held for review.
- Each target has durable leased work and immutable payload identity. An
  expired lease is recovered; lost replies replay the same native journal key.
  A failed branch does not block another. HQ's existing copy is linked separately
  when it arrives; no replacement or invented bill is inserted.
- Backdated linking does not retroactively calculate or award Ada points.

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
