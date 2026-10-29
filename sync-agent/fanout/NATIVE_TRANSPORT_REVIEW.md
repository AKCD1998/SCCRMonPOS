# Native Ada transport and restricted member fanout review

Read-only discovery on 2026-10-29. No native task, queue, service, application,
firewall, or database object was changed by this investigation. No customer PIN
or credential was returned in the evidence.

## Verified HQ source

- SQL machine `SERVER`, endpoint `tcp:100.90.166.72,49800`, database `AdaAcc`.
- The existing runtime `SCCRMHQMemberSync` uses SQL login
  `sccrm_hq_member_sync`. A direct permission read confirmed sysadmin=0,
  native customer INSERT=0, native customer UPDATE=0.
- This runtime login cannot SELECT `dbo.TCNTSyncTask` or
  `dbo.SCCRM_LiveMemberLink`; its limited `sys.tables` visibility does not prove
  that native transfer objects are absent.
- Targeted native-task/metadata SELECTs therefore used the existing HQ agent
  account, consumed in memory from
  `\\100.90.166.72\C\Users\Administrator\Desktop\Stockdays\SC-StockDay-Ordering\apps\adapos-sync\.env`.
  The branch marker was checked as 000 and the actual SQL machine/database
  checked before other reads. That existing provisioning identity has the
  necessary administrator rights; it must never become the fanout runtime
  credential. Its username/password and connection string were not printed.
- Connections used a five-second connect timeout, six-second query budget,
  session-only one-second lock timeout, and low deadlock priority.

## Native transfer path found

HQ `dbo.TCNTSyncTask` has these customer tasks:

| Sequence | Name | From / to | Type | Allow | Usage | Log type | Last / condition-last |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 19 | D - Customer | TCNMCst / TCNMCst | 3 | 3 | 1 | 20 | 2020-05-18 |
| 69 | U - Customer | TCNMCst / TCNMCst | 2 | 3 | 1 | 73 | 2020-05-18 |

Both have schedule `D201301013000123100000000000100110`, condition type 1,
condition date difference 0, and empty all-data marker. Branch 005 discovery
independently found the same task definitions. The enum values have not been
independently interpreted; their presence does not prove current delivery.

The native `TCNTSyncLog` schema is a journal: `FTLogSeq`, `FNLogType`,
`FTPosCode`, `FTComName`, `FNSynType`, `FTSynName`, `FTLogDetail`, `FDLogIns`.
Neither that journal nor the discovered task schema provides a demonstrated
durable per-SCCRM-member/per-destination acknowledgment contract. Log payloads
were not read because they are unnecessary for this conclusion.

The installed HQ tree includes `AdaSync\AdaSync.exe`,
`AdaImportExport\AdaExportAuto.exe`, `AdaImportExport\AdaImportAuto.exe`, and
`AdaSky\AdaSky.exe`. The non-secret portions of
`D:\Adasoft\AdaPos4.0HpmFhn\AdaSky\SkyConfig.INI` show:

- General master, transaction, extra-file generation and FTP send/get stages.
- An Inbox/Outbox plus temporary ZIP/FTP folders.
- FTP logical inbound folder `httpdocs/scgroup/000` and outbound
  `httpdocs/scgroup`.
- Configured send/receive schedule strings containing one-minute/two-minute
  intervals. These are configuration observations, not proof of a currently
  running process or successful delivery.
- Outbox had no top-level files. Latest observed top-level receive marker was
  2026-05-25; the observed log file was modified 2026-08-29. No payload ZIP,
  mailbox database, FTP credential, or customer export was opened.

There is **no proven native invocation that sends exactly one identified new
member, preserves existing destination profiles, avoids PIN, and reports a
durable per-branch acknowledgment within ten seconds**. Enabling the broad
native customer tasks would exceed the evidence and the user's create-only
scope. Keep them unchanged. This conclusion is bounded to the inspected
objects/configurations; it does not claim AdaSoftware has no other facilities.

## Exact creation log suitable for bounded backfill

The existing source `CreateMember.sql` is an owned static procedure:
`dbo.SCCRM_CreateMemberFromSccrm`. It records only successful SCCRM-created
customers in `dbo.SCCRM_LiveMemberLink`, in the same transaction as native
customer creation. The code is deterministic `SC-` plus the first 16 UUID hex
characters; an application lock and unique member/code link protect replay.
Existing code or matching native phone is held for review, with no customer
UPDATE or DELETE. Unsupported Thai-codepage text is rejected rather than
silently converted.

Exactly three owned HQ creation links were observed:

| Private source row | Native creation timestamp (HQ local time) |
| --- | --- |
| Known historical synthetic fixture, held | 2026-10-24 19:13:34.563 |
| Real-member candidate; identifiers retained only in private runtime evidence | 2026-10-27 11:46:58.913 |
| Real-member candidate; identifiers retained only in private runtime evidence | 2026-10-29 10:14:38.347 |

These links, with current readback/identity validation, are a bounded bootstrap
source. The whole native customer table is not an authorized bootstrap set.
Profile names/phones are intentionally omitted from this transport report;
production pilot identity must be verified separately before delivery.
The existing `bf0e4513-a72d-4c83-9b17-afff6779cf9b` source is a known synthetic
fixture from earlier work and must remain held, never distributed to production
branches. The other source records still require the parent pilot's identity
verification; an owned HQ creation row alone does not establish a real person.

## Recommended restricted path

1. An independently stoppable background worker scans only committed owned HQ
   creation links approximately once per second, using a narrow read procedure
   or targeted SELECT grant. This handles a native commit followed by response
   loss before the existing 30-second worker records its PostgreSQL ack.
2. Insert one durable job per immutable member ID and verified destination
   identity. Re-read the owned source mapping/profile and target configuration;
   do not accept caller-invented customer codes or guess an endpoint from POS IP.
3. Use a destination receiver with its own marker, transaction/app lock and
   durable member-to-native-code acknowledgment table. Grant runtime EXECUTE on
   this owned static procedure, deny direct native customer DML, deny PIN, and
   avoid administrator/server-wide privileges.
4. A previously acknowledged member returns the same code only after validating
   that the native row still exists and matches the acknowledgment basis. An
   unowned existing code, duplicate phone, differing name/profile or changed
   mapping becomes review; no phone-only merge and no overwritten profile.
5. Retry must retain the same immutable request identity. A successful native
   commit followed by network/ack loss returns the stored acknowledgment on the
   next attempt. Offline branches are isolated by separate retry schedules and
   bounded connection/query timeouts.
6. Do not infer a missing legacy customer identity from equal phone/name alone.
   Existing Ada codes require the already-approved mapping/manual review path.

The source link and receiver acknowledgment are the idempotency authorities;
the queue is delivery coordination. A PostgreSQL-only notification after the
current worker's ack cannot by itself satisfy the requested HQ-commit timing
under ack loss. The independent source scan avoids requiring an invasive hook
in the current member/history worker.

## Provisioning and operational limits

- Existing provisioning code demonstrates a technically restricted runtime can
  execute a dbo-owned static insert procedure while direct native DML is denied
  through normal SQL ownership chaining. Keep the table/procedure identifiers
  fixed; do not use caller-controlled dynamic SQL.
- New receiver provisioning must first verify the discovered server/database,
  branch identity, schema compatibility, unique customer-code index and owned
  marker. A pre-existing unmarked object/login is a collision, not something to
  replace. Do not reuse broad existing administrator credentials in the service.
- The current HQ service owns its Node/PowerShell children in a Windows job and
  runs headlessly as LocalService. A separate fanout service can use the same
  service-host pattern while its stop/restart affects only its own children.
- The existing launch guide records that remote service RPC was unavailable.
  Prepare reviewed files over the existing SMB channel, encrypt/protect runtime
  credentials as the current service does, then perform one explicit local
  administrator install on HQ if that restriction remains. Staging files is not
  evidence that a service has been installed or verified.
- A local one-time bootstrap may create only owned helper objects and a limited
  role after copy tests; it must not restart SQL/AdaPos/Shopee or alter Ada's
  actual configuration. Source admin privileges were verified for HQ only;
  destination bootstrap privileges remain a separate per-branch preflight.
- Stop/rollback should disable only fanout scanning/delivery or restore its
  previous executable/configuration. Never delete customers, native code links
  or successful acknowledgments as rollback.

## Still requires implementation / acceptance

No production fanout or production provisioning was executed by this review.
The parent task still owns copy tests, durable queue/receiver implementation,
role-denial tests, timing measurement, destination non-PIN baselines, HQ install,
and actual AdaPos customer-search acceptance. Whether AdaPos needs a fresh
search or a data reload is not established by source-table/config discovery.

## Receiver implementation handoff

`Receiver.sql` and `Provision-Receiver.ps1` implement the receiving side for
the parent integration harness. The procedure takes immutable member/profile
inputs and a bound target identity, creates only a new native contact and its
owned acknowledgment, and returns actual native profile fields for the Node
adapter's independent digest check. SQL2008 does not calculate SHA256 here.
Caller strings use MAX parameter types followed by explicit length checks so
overlong direct calls cannot silently truncate before validation.

The provisioner defaults to Copy mode with an exact
`SCCRM_FanoutCopy_20261029_<branch>` database-name guard and the copy lab's owned
marker `fa35c153-6692-43b8-afd1-b102a119b002` / scope / matching branch. The runtime
copy receiver also rechecks this marker before any contact insertion.
Live mode additionally requires an independently reviewed exact-target allowlist;
nonpilot branches require an explicit production approval flag. Every login and
helper object must be absent or match the owned target marker and stable login
SID. It refuses incompatible text widths, missing code uniqueness, unexpected
native owner and enabled/unreviewed native customer triggers. Runtime rights are
EXEC-only for the receiver, with explicit direct native SELECT/DML/ALTER and PIN
denials, and are checked under the actual runtime login after provisioning.

Owned objects and the new login/user are provisioned in one transaction.
Transactional login creation/rollback is supported by [Microsoft's CREATE LOGIN
reference](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-login-transact-sql?view=sql-server-ver17).
This does not use `EXECUTE AS sysadmin`; the permission probe temporarily uses
the new restricted database user and then reverts. No production provisioning
was run by this subagent.

Required copy acceptance cases for these receiving files:

| Case | Expected result |
| --- | --- |
| First eligible HQ member | One new native row, exact HQ code/profile, zero opening points and one owned ack |
| Same request sent repeatedly | Same actual code/UTC ack, no new native row or profile write |
| Same UUID with changed profile/hash | `FANOUT_ACK_BASIS_CHANGED_REVIEW`; original profile remains |
| Native profile changed after ack | `FANOUT_NATIVE_PROFILE_CHANGED_REVIEW`; no repair/overwrite |
| Native row missing after ack | `FANOUT_NATIVE_ROW_MISSING_REVIEW`; no reconstruction |
| Existing unowned code, even identical profile | `FANOUT_CUSTOMER_CODE_COLLISION_REVIEW` |
| Existing native phone, including formatted/+66 | `FANOUT_EXISTING_CUSTOMER_REVIEW_REQUIRED`; no merge |
| Different member attempting the owned code | Code/identity/mapping rejection; original owner unchanged |
| Wrong database, machine, marker or target identity | Fail closed before customer insert |
| Long or unrepresentable text | Rejected without silent codepage/length loss |
| Native commit succeeds but response is lost | Retry reads exact immutable ack and actual native row |
| Receiver execution under restricted login | EXEC succeeds; direct native SELECT/DML/ALTER/PIN reads denied |
| Original customers before/after | All original non-PIN field snapshots unchanged |

The parent harness additionally owns offline/reconnect, service-restart,
parallel branch isolation, durable queue replay and end-to-end timing tests.

## Native admin-source provenance verified

`admin-source.cjs` exports bootstrap-only `readAdmin(branch)`. It captures its
private PowerShell child's stdout in memory, not in a tool log. Branches use
32-bit Jet against a local temporary copy of the exact native AdaIni file,
inside a folder restricted to the current Windows identity, SYSTEM and local
Administrators. The remote AdaTools directory is never opened through Jet, so
Jet cannot create a remote lock file. Only effective `TConfig` SQL keys are
queried; no customer table or PIN is queried. Local temporary copies were
removed after all successful checks.

The effective native server key is `SqlSrc`, not `SqlSrv`. Read-only SQL
connection checks with the captured credential independently confirmed the
actual machine/database and sufficient bootstrap rights:

| Branch | Native effective SqlSrc / configured HQ server | Actual SQL machine | Database | Verified endpoint |
| --- | --- | --- | --- | --- |
| 000 | SERVER\\SQLEXPRESS | SERVER | AdaAcc | tcp:100.90.166.72,49800 |
| 001 | SC_001\\sqlexpress | SC_001 | AdaAcc | 100.81.137.41\\SQLEXPRESS |
| 003 | POSSRV\\sqlexpress | POSSRV | AdaAcc | 100.77.101.94\\SQLEXPRESS |
| 004 | SERVER004\\sqlexpress | SERVER004 | AdaAcc | 100.113.59.42\\SQLEXPRESS |
| 005 | POSSRV\\SQLEXPRESS | POSSRV | AdaAcc | 100.106.107.80\\SQLEXPRESS |

For 001/003/004/005, the exact file is
`\\<verified peer>\D\AdaSoft\AdaPos4.0HpmFhn\AdaTools\AdaIni.ada`.
HQ uses the existing agent environment file documented above. Native usernames
and passwords are intentionally absent from this report. The reader must not
be logged or persisted unencrypted; its result is for the reviewed provisioner
stdin pipe only. These successful credential/provenance checks performed no
DDL/DML and do not themselves authorize an untested destination rollout.

## Verification performed for the handoff

- Windows PowerShell parser checks passed for both receiving/bootstrap helpers.
- Six actual provisioner refusal cases passed before any SQL connection:
  incorrect scope, Copy mode targeting production, Live mode without its
  independent allowlist, arbitrary host, unowned worker name and oversized
  packet.
- Copy-only native provisioning then passed for the source copy 000 and all
  four destination copies 005/001/003/004. Actual restricted-login permission
  probes returned receiver EXECUTE=1 and native SELECT/INSERT/UPDATE/DELETE/
  ALTER/PIN=0 for every receiver. Customer counts before and after this
  provisioning were unchanged: 005=1408, 001=1407, 003=1382, 004=1381. This is a
  provisioning check, not the full end-to-end preservation/integration result.
- Copies intentionally have no PIN column. The provisioner therefore applies
  the additional column-level PIN denial only when metadata says that column
  exists; it never creates/copies a PIN column to facilitate a permission test.
- A separate synthetic-only cryptographic interoperability check passed five
  assertions: Node sealing decrypted through the equivalent Windows PowerShell
  5.1 RSA-OAEP-SHA1/AES-CBC/HMAC operations, while altered IV/ciphertext/MAC were
  rejected. The real machine-only secret-bridge guard remained unchanged; no
  production secret or private bootstrap key was used in that check.
- Source-provision SID binding and raw receive-packet length checks identified
  in the independent review were subsequently added by the parent. The source
  cursor's lowercase GUID/BIN2 ordering agrees with canonical UUID order; its
  SQL datetime millisecond serialization round-trips the native datetime value.
- Service host inspection showed it tracks only its own spawned Node process
  and Windows job children. The independent worker holds the known synthetic
  source fixture and does not replace the existing member/history worker.

For honest timing evidence, older HQ creation links are backlog: their real
HQ-created-to-delivered age must be reported separately from dispatcher enqueue
to native acknowledgment. A fast backlog dispatch is not a fresh production
HQ-commit-to-branch latency measurement. Fresh-copy timing tests establish the
mechanism, while a fresh real verified-member event establishes the live SLA.
