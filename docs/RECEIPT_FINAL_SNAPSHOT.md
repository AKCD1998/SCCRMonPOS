# Refresh the settled Ada receipt before saving

The old watcher accepted a positive header and one detail row. A membership form
could retain that preview while Ada added items or applied checkout discounts.
Confirming later reused the old preview. Eight inspected receipts had exactly
matching saved prefix rows but fifteen missing suffix rows. Two also had later
receipt discounts. A ninth receipt independently exhibited the same cached-preview
problem even though staff confirmed it after the payment row existed.

## Read policy

`FinalReceiptSnapshot` accepts normal sales with Paid=3, document status=1, a
positive net total, details and all tenders whose net sum balances to the header.
It compares the entire header, product/unit/quantity/price/net/discount rows and
all tenders twice, at least 500 ms apart (four bounded attempts for manual reads).
The poller requires matching observations across polls. Confirmation always
performs a fresh native read on a worker thread and checks duplicate ownership
again immediately before posting. A persisted preview never retains trust.

Read the terminal's TSHD/TSDT/TSRC family before TPSTSal. If a live header exists
but is unpaid or void, do not fall back to an older paid archive. A failed SELECT
cannot count as a complete observation. SQL commands time out after three seconds,
with connection-only LOCK_TIMEOUT=750 and DEADLOCK_PRIORITY=LOW; no database
options, Ada configuration or selling processes change.

Use Ada net amounts directly. Three units listed at 40 can settle at 90 after
checkout. Mixed tenders use FCSrcNet, not cash tendered before change. Keep all
existing void normalization and duplicate/member ownership guards. No SCCRM
points are awarded; Ada remains the authority.

## Evidence and limits

ADA rebuild's read-only handoff dated 2026-11-12 confirms its retained evidence
does **not** establish Paid=3 as a transaction boundary, nor TPST replication
ordering. Two consistent, paid, balanced observations are a conservative reader
policy, not proof that Ada can never mutate the document again. Later native
changes still hold in the durable queue for review instead of silently overwriting
an owner or awarding points. No proprietary commit-order claim is made.

Copy acceptance includes the C# form posting the refreshed 90/30 snapshot rather
than its 120/0 preview; unpaid, missing-payment, mixed-tender, late/free-line,
unstable and failed final reads; all eight actual copied receipts; archive120
versus current90; and unpaid current data versus a paid archive. No test customer
or sale is created in production. Private fixture/proof data stays under ignored
`sync-agent/receipts/runtime/items-recheck-20261112`.

`final-snapshot-copy.cjs` seeds only marker-owned SQL copies. Its two native
receiver calls use outer rollback and therefore prove validation and preservation,
not a committed journal replay. The existing receiver integration tests separately
exercise committed replay, lost acknowledgement, restart, offline and owner
conflict. The backend's actual copied recovery transaction is committed twice
and preserves claim/item identity, original request hashes and every points row.

## Recovery and rollback

The official backend's guarded operator recovery appends an immutable revision
and only missing exact-prefix rows, preserving old requests and originals. It
requires matching independent branch/HQ reads, balanced payments, verified member
mapping and no prior native application. Old acknowledgements cannot finish newer
revisions. Legacy imports cannot overwrite a cashier-confirmed history mirror.
Eight original receipts were verified at both real destinations; an additional
same-cause receipt was tested and recovered separately. Existing native sales,
financial rows, customers and points are retained.

Fleet updates wait for staff work to finish and replace only SCCRM. Pause further
handoffs in the SCProductDev console if needed; already saved history and native
associations remain intact. To roll back desktop code, use the signed publisher's
`-RollbackTo pos-1.3.23` path, then issue a separate explicit fleet command. Never
delete receipt audit revisions or native journals to roll back the reader.
