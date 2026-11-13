# Ada → SCCRM purchase history

The inbound bridge reads paid Ada member sales and returns, including bills
that never passed through SCCRM's receipt claim API. It preserves the original
customer code, branch, POS, document identity, quantities, units and totals.
An imported bill does not award points or create an authentication account.

The independent receipt lane defaults to a 10-second pause between cycles
(`receiptPollMs`, allowed 5–60 seconds). It reads today's and the previous two
days' receipts through the existing native date index, using 100-row keyset
pages. Each cycle starts at the window floor, so a late branch import cannot
fall behind a permanent sale-time cursor. Source timestamps come from HQ's SQL
clock. Exact customer codes and all item rows are read before each destination
transaction; a new header and its items commit together. Missing items stay
pending for the next cycle. A customer missing at HQ is reported separately,
without inventing or assigning an owner.

The five-minute full reconciliation still catches historical imports and edits
outside that window. The member, recent-receipt and full-history lanes each
have separate SQL and PostgreSQL connections. Any retrying lane makes the
published worker state retrying. Status contains SQLSTATE codes, never database
error messages containing source values.

The 10-second interval starts after a successful scan; it is not an end-to-end
latency guarantee. The existing branch → HQ importer has a 90-second settlement
delay. Offline branches, native locks, backlog, source inconsistencies and full
reconciliation outside the recent window add delay. Measure native sale time,
HQ import completion, mirror update and website response separately.

Apply `20261113030332_ada_inbound_name_index_permission.sql` before rollout.
It grants the existing restricted worker EXECUTE on a pure immutable name
normalizer used by the customer expression index. It does not grant public
execution, security-definer behavior, native DML, authentication or point writes.
The runtime uses three PostgreSQL sessions, within the existing role limit.

For an existing installation, back up only the owned live worker, SQL RPC,
scheduler and helpers. Use its existing restart hold and stop request to let
the worker drain, replace the reviewed files, then release the hold. Preserve
encrypted credentials, configuration, source identities and other services.
Rollback restores these backed-up files and restarts only this owned worker;
it never deletes imported customers, receipts, item snapshots or approved links.

Verification uses synthetic fixtures in a fresh, explicitly local PostgreSQL
database. It reproduces the index permission failure under the restricted role,
then checks idempotent customer updates, late older bills, returns, decimal
quantities, units and repeated replay. Unit checks cover incomplete item
snapshots, wrong owner scopes, rollback and independent bounded polling.

## Direct branch history and profiles

Enable `branchHistoryEnabled` only after the ordered inbound migrations and
the owned six-column profile views have been provisioned. Pilot with
`branchHistoryBranches: ["005"]`, then enable 001/003/004/005. The default
branch pause is ten seconds. Each branch has an independent native reader;
all share one additional PostgreSQL session through a serial destination queue.
An offline reader never holds that destination queue during network I/O.

The readers reuse the existing machine-sealed `sccrm_sales_export_NNN` sources.
Their HQ writer credential never leaves the private source-filter helper.
They read only owned, explicit-column sales/profile views. Native customer,
PIN, sales and point writes remain unavailable. The six-column profile view
is qualified with a synthetic SQL Server copy: all four home-branch filters,
view SELECT, denied raw customer/PIN access and denied customer UPDATE.
No administrator credential enters the runtime.

Recent branch receipts retain the existing 90-second settling interval.
Two matching header/item reads must agree before a complete packet commits.
The source export views begin at 2026-11-08; a full replay from that floor runs
every five minutes and three-day overlap scans run between them. Older
archives use the bounded, operator-only native reader with the same two-read
proof. Rows keep their physical `branchNNN/AdaAcc` origin. The history view
deduplicates a later matching HQ arrival under the same stable receipt ID.
Cross-source owner/identity changes and public-claim owner conflicts are held.
Valid original legacy customer codes are retained without renumbering.

`20261113031659_ada_inbound_branch_customer_profiles.sql` adds a separate
private branch-profile cache and a shared customer read view. The reader first
checks the real HQ profile, then the original AR code's home branch for six
non-PIN fields. The destination requires the already mirrored receipt's exact
branch, POS, document, owner, date, time and total. A member born at one branch
may buy at another; the receipt owner code remains unchanged. Names, phones
and point entries cannot establish a link to an SCCRM account.

StockDay's existing directory/history views can then show that code's history
without creating an account, approved member link or native HQ customer. The
profile records `branchNNN/AdaAcc` as physical provenance. The directory ID stays
stable if the exact code subsequently arrives from HQ; the real HQ profile
always takes precedence. Registration matching still uses the actual HQ
customer table and cannot silently consolidate this fallback contact.

Profile-source failures leave complete receipt packets queued under their
original code and publish an incomplete status. A later successful exact
profile read reveals the same bill, without assigning it to another person.
Monitor every branch's `lastFullAt`, pending counts and profile read errors.
