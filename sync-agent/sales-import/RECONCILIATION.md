# Reconcile held existing receipts

`reconciliation.cjs` is an explicit administrator tool. It is not imported by
the service and does not weaken the automatic receiver's exact comparison.

Read all eight export/native tables and their 320-column metadata. Match row
keys and counts and compare native binary values, excluding only the existing
receiver's processing/audit fields. Preserve the original queue packet/hash.
Use two stable source observations and fresh HQ evidence before application.

The operator policy distinguishes exact copies, legacy default representations,
blank invoice metadata and unresolved differences. Legacy defaults allow only
an explicit optional-field list: a nullable source value may correspond to an
exact empty varchar or numeric zero at HQ. Owner, document keys, dates, SKU,
sale quantity, price, grand total and other unlisted fields cannot be normalized.
This outcome means `existing_legacy_defaults`, not exact native-copy equality.
Invoice repair only fills NULL HQ approval/full-tax-invoice fields from the
unchanged source. It cannot replace populated fields or change sale amounts.

Application is limited to the marked `AdaAcc` target or the owned
`SCCRM_SalesLab_20261111_000` copy. A batch has at most 50 documents. In one
transaction it rechecks all compared HQ native columns, the original held job
and immutable packet hash before recording the resolution, zero-insert journal,
event and queue completion. Invoice fills additionally verify the complete
header after writing. Evidence expires after ten minutes. Native changes,
changed jobs, duplicate resolutions, unknown methods and unsupported fields
refuse the batch. SQL Server 2008's SHA1 detector is used only for transactional
change detection; durable external source/HQ evidence uses SHA256.

`SCCRM_SalesReviewResolutions` records the job, operator run, method, original
source/HQ evidence hashes, observation/resolution times and native field count.
No customer or point table is accessed or written by the generated operation.
Do not classify unresolved differences as successful to empty a queue.

Before applying, run the policy tests and exercise generated SQL in the owned
SQL Server copy, including concurrent native/job edits, replay, stale evidence,
legacy defaults, blank invoice fill and full header readback. Keep the copy
proof, private snapshots, per-bill plan, applied batch SQL and results outside
Git. Verify the final queue/journal/audit counts and native preservation after
application. Stop starting batches before the user's handoff deadline.
