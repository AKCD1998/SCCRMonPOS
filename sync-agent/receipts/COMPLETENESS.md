# Headless receipt completeness

The existing SCCRMHQReceiptSync service runs four independent reconciliation
lanes in addition to its native delivery lanes. They share no in-memory queue.
The durable PostgreSQL completeness queue fences expired leases and accepts
replayed acknowledgements idempotently. A source outage does not hold another
source lane. Every valid SCCRM receipt is enqueued in its save transaction;
eligible legacy claims without jobs are held for an initial audit first.

`SCCRM_ReadReceiptSnapshot` is an execute-only, read-only procedure. It fixes
database/branch scope in its deployed body, validates register/document/member
parameters, prefers live register tables, and returns only whitelisted receipt
headers, lines, tenders, journal identity and member-match booleans. It never
reads a customer PIN. It does not grant table access or change the existing
native receiver, SQL Server, AdaPos, firewall or another service.

Each target is observed twice with matching results; the backend independently
validates paid/status/payment balance, owner, approved mapping, all existing
nonempty line fields and source/HQ consistency. Only missing fields and exact
appended final lines are filled. A footer-only financial change also requires
independent old/final arithmetic to balance. A conflicting existing value holds
for review; it is never replaced with a guess. Ada remains the point authority.

The backend retains original and final snapshots and mirror evidence in an
append-only private audit. Old claim IDs, line IDs and native request hashes
remain unchanged. Corrections create new native request revisions; superseded
acknowledgements cannot change the new state. A later audit defaults to ten
minutes after success. Retry backs off to five minutes. Unchanged checks update
timestamps without appending an event on every poll.

The main history and completeness states are separate. “SCCRM stored” never
means every field has already been verified. The existing sync log shows the
latest completeness state, verified time and next check. Review remains visible
until a deliberate retry; retry never reassigns an existing native bill owner.

## Controls and rollback

The additive database control defaults to disabled. First enable only the two
approved pilot claim IDs, verify SQL and SCCRM histories, then clear the pilot
allowlist. Setting `sccrm_receipt_sync.completeness_control.enabled=false` stops
new completeness leases; an already leased bounded observation may finish.
It does not pause ordinary member sync, points or receipt delivery.

The service also requires `config.json.completenessEnabled=true`. Use the scoped
operator to back up and replace only the receipt service files and restart only
SCCRMHQReceiptSync. Restore that file backup and the original config to roll back
the worker. Keep the additive DB tables, completed fills and audit; never delete
customers, sales, point rows, journal identities or audits during rollback.
Restoring a prior signed desktop release changes only the desktop program.

## Verification

`completeness-copy.cjs` installs the reader only in marker-owned copies and proves
the receipt identity has execute permission but no customer/sale/point UPDATE.
It reads two actual copied cases twice at HQ and branch, and checks preserved
non-PIN customer, financial and point rows. The paired backend end-to-end script
executes the actual reconciliation worker against local PostgreSQL and these
native copies, validates both corrected native requests with outer rollback,
then audits again. Unit/integration tests cover missing units, checkout discounts,
late/free rows, mixed tenders, conflicts, expired leases, lost responses, restart,
subsequent native mutation, mirror-only repair and duplicate claim protection.

Paid=3 is not asserted to be a proprietary transaction boundary. A verified
observation may change later, which is why periodic reconciliation is retained.
