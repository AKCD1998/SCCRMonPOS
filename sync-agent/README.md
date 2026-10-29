# HQ background sync

Independent HQ-to-branch new-member delivery: see [fanout](fanout/README.md).
This add-on has its own durable queue, receiving roles and stoppable service;
it does not replace the current HQ member/history worker or enable legacy bulk sync.

Optional Ada-assigned AR codes, parallel delivery authority and UUID-preserving
SCCRM code publication: see [member codes](member-codes/README.md). Existing SC
queue records stay intact; deployment/native UI verification is a separate gate.

Production member/history bridge: see [live launch status](live/WORK_STATUS.md).
The separately guarded `live/` module is installed as `SCCRMHQMemberSync` on
HQ000 and connects the existing Supabase to AdaAcc. It imports native contacts
and finalized member purchases, and creates eligible new SCCRM members in Ada.
It never overwrites/deletes existing native customers and does not enable
bidirectional points adjustments. Its runtime and encrypted credentials are
excluded from source control. The original copy-only worker below remains
separate and its production-denial guards must stay intact.

## Original sandbox release 0.1.0

This executable service is limited to the two test database copies. It cannot be configured for production: SQL database, marker, login and endpoint are fixed by guards in Node and PowerShell. The SQL login is technically denied access to AdaAcc and both historical databases. No real Supabase URL or secret is included. Do not relax these guards to turn this into a production release.

The worker polls every 30 seconds, keeps durable member baselines and point observation/receipt tables in the copies, and resumes after restart. Fields merge independently, Supabase-side conflict wins, blanks preserve data, old unlinked customers require review. No customer DELETE exists. Source point rows are immutable observations; mutations and unsupported types are held for review. Mirrored ledger entries carry an origin marker and don't echo back. Point changes append transactions; master opening points are never overwritten.

PostgreSQL here is a private schema-compatible Supabase stand-in, bound to 127.0.0.1:55443. It has no connection to live Supabase. Its state and the exact SQL copy are a matched pair; never initialize a new PG copy against already advanced SQL sync checkpoints. Deploy only the cold stopped cluster with its matching config and state.

## Tests

Full legacy history import: see [full-data copy verification](HISTORY_COPY_RESULTS_TH.md). The separate `history/` module paginates all 1,438 legacy codes and 4,075 sales + 21 returns / 12,491 lines through an immutable SQL-copy snapshot into a private PostgreSQL copy on port 55444. It uses durable atomic checkpoints, strict bill ownership and line identities, and explicit member mappings, independently of auth and points. It has 34 new integration checks and brings `npm test` to 21 tests. This does not relax the original worker's sandbox limits or deploy a live writer. The new history module is tested from the development workstation; it has not replaced the running HQ service or production API.

`npm test` checks configuration and amount boundaries. `node integration.cjs` tests real SQL Server copy + private PostgreSQL copy, automatic member creation/edits, conflict and blank handling, bidirectional increases/decreases, same-receipt reconciliation, ack-loss replay, restart, pause/resume and preservation of all 11 original customer records excluding PIN. Tests add labeled synthetic customers and point records; they never delete fixtures or reset actual customers.

## HQ deployment

Prepared folder: `D:\SCCRM-HQ-SyncSandbox-20261024` on SERVER (000).

Installed and independently rechecked on 2026-10-24: LocalService/delayed-auto, headless integration 31/31, fresh healthy statuses after a service-only restart, and SQL copy login still denied production access. This remains copy-to-copy operation with a private Supabase-shaped PostgreSQL stand-in. See [Thai installation evidence](RESULT_TH.md). The source installer now fixes Windows PowerShell 5 JSON-array enumeration; its regression test raises the local unit total to 11. That installer-only fix does not require restarting the running HQ worker.

Run `Install-TestService.cmd` locally as Administrator once. It installs only `SCCRMHQSyncSandbox`, delayed automatic start, under LocalService. It compiles the included service host and grants access only within its owned folder. SQL test password is read from the repaired test AdaIni in memory and protected using machine DPAPI; no production configuration is read or changed. First service boot reruns integration tests before entering the continuous worker loop. If verification fails it writes `runtime/verification-blocked.json` and does not repeatedly create fixtures. Read failure evidence and repair before an explicit retry.

No desktop login, browser, screenshots or keyboard/mouse access is used. Do not stop or modify Shopee automation. The service owns its child-process job: stopping it cleans only its private Node/PowerShell/PostgreSQL processes. It does not stop installed PostgreSQL or SQL Server services.

Check public `status/install-result.json`, `status/verified-on-000.json`, and `status/status.json` (private counterparts are under runtime). A fresh healthy status plus verified-on-000 identifies success; SCM Running alone is insufficient. Review entries intentionally generated by tests remain in the copy. The installer report's headlessVerificationPending flag records its initial state; the later verified-on-000 report confirms completion.

Pause by creating `runtime/pause.request`, resume by removing that specific request file. Stop/start using the named service. Do not remove the service data folder or change existing Ada records as a cleanup step.

RPC to 000 was unavailable from the development workstation. Installing and validating the service on HQ therefore needs one local execution by the operator or their existing LLM on 000; preparing a folder over SMB does not itself prove installation.

References: [Windows service installation](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/sc-create), [PostgreSQL initdb](https://www.postgresql.org/docs/18/app-initdb.html).
