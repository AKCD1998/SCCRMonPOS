# Automatic branch sales import

`SCCRMHQSalesImport` independently imports replicas of existing finalized Ada
branch receipts into HQ `AdaAcc`. It never invents receipt numbers, changes an
existing sale, edits customers, computes points or writes the point ledger.
Member/fanout/point/receipt services and the desktop version are unchanged.

The old Windows jobs named AdaPOS Sync export HQ stock to StockDay; they do not
receive branch sales. Old vendor import tasks/logs did not prove a working,
replay-safe unattended branch receiver, so those programs were not enabled.

## Scope

- SERVER/HQ 000: `D:\SCCRM-HQ-LiveSync-20261024\sales-import`.
- LocalService, Session 0, BelowNormal, delayed automatic start. One .NET process,
  no desktop, browser, PowerShell child workers or dependency on AdaSmart.
- Verified native SQL endpoints from Ada config: 001 SC_001, 003 POSSRV,
  004 SERVER004, 005 POSSRV. POS2 shares its branch SQL; POS IPs are not guessed.
- Source SQL users select only eight explicit-column, fixed-branch export views.
  The HQ SQL user executes the owned queue/apply procedures only. Neither runtime
  role can directly read customers/PINs or modify sales/customers/points.
- Paid/finalized sale or return, POS 001/002, 90-second settling interval.
  Reads both archived TPST tables and matching TSHD/TSDT/TSRC/TSPD/TSPG/TSVT
  tables for paid, finalized receipts only. Open/cancelled bills are excluded.
  Archive wins when the same document is in both places; moving a bill out of
  the daily tables cannot enqueue another copy. Daily tables are read-only.
  Indexed receipt-number pages of 25, normal three-day overlap, no records
  before 2026-11-08. A durable last-complete scan extends the window after longer
  outages; a three-day outage cannot silently skip receipts. Month rollover is
  included. This repairs the known recent gap without a full-history scan.
- Original HD,DT,RC,PD,PG,PH,InvCsm,Void rows copied with original keys and every
  column. Typed XML preserves null/empty, Thai text, dates, float precision,
  promotions, tender, void and return data. Two matching reads before freezing.

## Reliability

The persistent HQ SQL queue stores one immutable packet per branch/receipt.
60-second fenced leases recover on restart. Native insert, readback, journal
and queue success commit atomically. Lost replies replay the durable result.
Discovery may repeat after restart; the queue's unique key prevents duplicates.
Each branch has independent retry/backoff. Frozen packets can finish even when
their source is offline. A source with no connection cannot hold other sources.

An identical existing receipt is verified with zero inserts. Only native
processing/audit fields are ignored for this existing-copy comparison. A
different owner/amount/item, partial copy, native global void-key collision,
unexpected trigger or changed identity is held for review, never overwritten.
An original member code missing from the HQ customer directory does not block
the receipt copy. Keep that exact code and log `SALES_VERIFIED_MEMBER_PENDING`;
never invent, merge or edit a customer profile from a sales packet. The receipt
is present while its separate member-directory workflow catches up.

The importer and existing receipt-member worker share the same per-bill SQL
application lock. Receiver SQL pins the database/schema/marker and uses a
short lock timeout, low deadlock priority and the SET options required by Ada's
indexes. No SQL defaults, firewall, native config or other service is changed.

## Inspect / pause / rollback

Read `status\health.json` on HQ (or through the existing D share). This reports
the process identity, heartbeat, source connectivity and queue counts. It
contains no customer contact data or credentials. SQL tables owned by this
component: `SCCRM_SalesSources`, `SCCRM_SalesJobs`, `SCCRM_SalesEvents`,
`SCCRM_SalesJournal`, `SCCRM_SalesMeta`. Events include receipt, state, safe code
and timestamps through the jobs relation. A review is not a success.

From SCProductDev, stop only this importer:

```powershell
sc.exe \\100.90.166.72 stop SCCRMHQSalesImport
```

Resume with `start` instead of `stop`. The durable queue and verified receipts
remain intact. Pausing one source uses its owned `SCCRM_SalesSources.enabled`
flag. Do not delete queue/journal records, undo imported sales, stop SQL/AdaPos/
Shopee, or stop existing SCCRM services as a software rollback.

## Verification and deployment

`control.cjs compile`, `control.cjs copy`, `copy.integration.cjs` prepare and
exercise separately owned copies. All copy databases are
`SCCRM_SalesLab_20261111_{000,001,003,004,005}`. Native rows are seeded from
bounded real reads, with no customer PINs. Fault injection and synthetic
receipt variants exist only there. Customer/point sentinels and exact binary
comparison of all native columns verify unchanged originals and roundtrips.

`control.cjs live` requires current copy proof and creates only owned SQL
objects/narrow identities. All source switches initially remain disabled.
`Stage-Service.ps1` requires clean committed source and current copy proof.
Credentials are generated for this component, protected locally using user
DPAPI, then sealed for the HQ service with its own RSA4096/AES256/HMAC key.
HQ machine-DPAPI and restricted folder ACLs protect the private bootstrap key.
Admin bootstrap credentials are memory/pipe-only and never enter the service.
Enable pilot 005, verify actual native rows, then enable other tested branches.
`audit.cjs before|after <branch...>` hashes non-PIN customer, point and existing
sale rows. Read tests/audits before claiming delivery complete; a running
service alone does not prove a destination has the receipt.
