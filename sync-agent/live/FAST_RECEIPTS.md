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

## Profiles that have not reached HQ

`20261113031659_ada_inbound_branch_customer_profiles.sql` adds a separate
private branch-profile cache and a shared customer read view. The operator
reader obtains only six non-PIN customer fields and the exact paid receipt
header from the originating branch. The destination requires that header to
match the already mirrored HQ branch, POS, document, owner, date, time and total.
Only a branch's own AR code is accepted. A name, phone or point entry cannot
establish ownership. The bootstrap reader is an explicit operator action,
not a service that retains administrator credentials.

StockDay's existing directory/history views can then show that code's history
without creating an account, approved member link or native HQ customer. The
profile records `branchNNN/AdaAcc` as physical provenance. The directory ID stays
stable if the exact code subsequently arrives from HQ; the real HQ profile
always takes precedence. Registration matching still uses the actual HQ
customer table and cannot silently consolidate this fallback contact.

Monitor historical missing profiles as well as the recent window. A branch-only
profile requires this exact-source repair; it must not be hidden under a
different SCCRM member merely because a phone or name agrees.
