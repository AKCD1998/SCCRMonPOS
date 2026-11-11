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
receipts are verified, conflicts/partial receipts held. A source member code
missing from the HQ directory is preserved on the bill with an explicit pending
profile event; it does not create/edit a profile or block the original receipt.
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

## Live result — 11 November 2026

Installed and running SCCRMHQSalesImport on SERVER as LocalService, Session 0,
BelowNormal, delayed automatic start, scoped recovery actions. All 001/003/004/
005 sources enabled after actual 005 pilot and independent 320-column destination
checks on three newly restored receipts from each branch. Only this new service
was stopped/restarted for its upgrade; existing SCCRM services stayed running.

32 SQL-copy cases pass for 17 bounded real receipts plus copy-only edge fixtures;
the final three assertions were resumed after correcting a fixture helper that
had itself seeded the orphan code on later clones. Runtime/receiver source did
not change across those resumed assertions. Original copy assertion already
proved the importer left that missing customer absent. Existing receipt worker
regressions pass 5/5. Proofs and per-branch audits are in gitignored runtime/.

Runtime sourceHash d0ae059404fdd2769f83e329e9dc4a3c956bda7989fe540eac3ff3bcfe25edc1.
Code is PR 36 (AKCD1998/SCCRMonPOS). Installed commit 6e2f0c4; subsequent operator
documentation does not change the installed C#/SQL. Status shortcut on SCProductDev:
C:\Users\scgro\Desktop\SCCRM - Sales import status.lnk. Scoped stop/start helpers
are in Desktop\SCCRM-HQ-SalesImport-Tools. Do not open/stop AdaPos or Shopee.

At 10:41Z the importer had restored 1,406 previously absent native bill replicas
(001 534 / 003 467 / 004 200 / 005 205). No duplicate native receipt numbers;
all queued documents then had an HQ header. Existing-HQ records still awaiting
read-only comparison are not missing bills. Older HQ/source differences are
held without overwriting. Initial backlog priority postponed only owned pending
jobs whose header already existed, to let missing bills finish first.
After the missing backlog completed, 1,259 unprepared pending jobs for headers
already present in HQ were explicitly held as SALES_PREEXISTING_PRESERVED in
one marker-guarded, queue-only adoption transaction. They are not success/
source-equality claims and their native data was untouched. This removes the
one-time old-record comparison backlog from the delivery lane for new bills.

Two original receipts were copied with their original codes while their customer
profiles remain absent in HQ: S2611005001-0004512 / AR005-000061 and
S2611001001-0058155 / AR001-000892. Both jobs succeeded with
SALES_VERIFIED_MEMBER_PENDING. Never invent or merge those profiles here.

Observed fresh end-to-end sale-to-HQ samples were 95–191 seconds, including the
intentional 90-second settlement window; samples during service upgrade/backlog
were longer (up to 427 seconds). Once discovered, several commits took 0.15–0.66s.
Do not confuse this receipt timing with the independent member fast lane.

HQ preservation audit found no removal/change in all 1,844 original non-PIN
customer rows, 696 original point rows or 8,323 original November headers and
their eight-table rows. Existing source sale/point rows are unchanged on all
four branches. 005 had one concurrent customer edit by Ada user dao1 at 17:16:59
(AR005-000027), distinct from the importer, whose actual SQL identities have no
customer insert/update, native direct DML or point-insert permissions. New
profiles/one new HQ point row appeared through ongoing normal services; do not
claim all live row counts stayed fixed. Audit 005 profile hash differs for that
known staff edit; this is not an importer profile write.

Separate observation, outside this branch-import receiver: three SCCRM receipt
member-link jobs at 004 remain held for RECEIPT_HEADER_CHANGED (client capture
time differs from final Ada time): S2611004002-0025098, -0025100, -0025111.
Their original native sales are imported by this worker. Existing receipt queue
HQ target status may still say NOT_ARRIVED because the parent is already review.
Do not report these member links repaired, rewrite frozen payloads, or silently
relax the existing receipt receiver in this task. They need a separate guarded
canonical-time/member-link correction.
