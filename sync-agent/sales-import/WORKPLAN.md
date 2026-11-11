# HQ sales import — active task 2026-11-11

User authorized an automatic background import of existing finalized Ada branch
receipts into HQ, copy tests first, no duplicate logical bills or points, no
AdaPos/SQL/Shopee stops. This extends the receipt recovery already completed.

Verified read-only: all 000/001/003/004/005 native schemas match (320 columns in
8 sale/void tables), no enabled triggers on those tables. HQ otherwise stops at
9 November; a single 11 November receipt was separately restored. Native sync
tasks are configured but old last-run fields and old vendor logs do not prove
an active headless importer. Actual Windows scheduled jobs named AdaPOS Sync run
the StockDay HQ-to-web export, not branch-to-HQ sales replication. Vendor auto
import CLI, bounded operation and replay behavior are unverified, so do not run
it against production or enable its old bulk schedules.

Implementation chosen: isolated SCCRMHQSalesImport Windows service on SERVER,
LocalService/Session 0/BelowNormal; no GUI or persistent PowerShell children.
.NET SqlClient reads only fixed branch export views through new view-only logins;
HQ login can execute owned queue/import procedures only. No customer/PIN reads
in runtime and no points writes. Bootstrap admin credentials are pipe-only.

HQ durable SQL queue freezes the original XML snapshot and SHA-256 before apply.
Lease/retry/journal and native insertion commit together; original receipt number
and all source values preserved. Typed XML handles the observed varchar/bigint/
datetime/float/int types. Eight tables: HD,DT,RC,PD,PG,PH,InvCsm,VoidDT. New native
receipts are inserted only when all destination rows are absent; existing equal
receipts are verified, conflicts/partial receipts/customer-code issues held.
Never delete/overwrite old sale rows or point/customer tables. Source selectors
use indexed receipt numbers, 90-second maturity, bounded pages and rolling
3-day overlap starting 2026-11-08. Independent retry/backoff per branch; durable
jobs survive restarts even if discovery cursors are replayed. Source snapshots
are checked twice before freezing. Return/void rows retain their exact values.
The scan window expands from the durable last-complete scan after longer
outages, so receipts cannot silently age out during an offline interval.

Copy test databases will be separately named SCCRM_SalesLab_20261111_000/001/
003/004/005, not the existing member/receipt-copy labs used by other tasks.
Tests must cover insertion, replay/lost response, crash/expired lease, offline,
partial destination, different owner, key collision, raw voids/returns and
unchanged customers/points. Stage only this new service, pilot 005 then other
verified branches, wait for live queues and inspect actual SQL/history results.
Do not claim completion while live checks are missing.

Current source: isolated branch codex/hq-sales-import-20261111 from master
5b6d61b. Probe.ps1/probe.cjs and runtime/probe-*.json are present. Those probe JSON
files contain metadata only, no credentials or PIN. Source schemas and PK/index
facts are in the probe records; TPSTVoidDT PK is FTVidSeq,FNSdtSeqNo (not doc no).
All secrets must be gitignored and protected, and status files must omit them.

Existing member, fanout, points and receipt workers stay running. Existing
receipt receiver remains fill-blank-member-only; do not broaden its rights.
