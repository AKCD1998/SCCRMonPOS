# Branch SQL discovery for member fanout — 29 October 2026

This is read-only discovery, not deployment or successful native UI acceptance.
No native rows, configs, services, firewall rules or sync tasks were changed.
No customer PIN values or credential values were read into this report.

## Verified destinations

| Branch | Tailscale peer / machine | Configured instance | Database | Current TCP listener | Existing customers | Registers observed |
| --- | --- | --- | --- | --- | --- | --- |
| 001 | `100.81.137.41` / `SC_001` | `SC_001\SQLEXPRESS` (installed SCCRM uses `100.81.137.41\SQLEXPRESS`) | `AdaAcc` | 49754 | 1,407 | 001 and 002 |
| 003 | `100.77.101.94` / `POSSRV` | `POSSRV\SQLEXPRESS` | `AdaAcc` | 49703 | 1,382 | 001 and 002 |
| 004 | `100.113.59.42` / `SERVER004` | `SERVER004\SQLEXPRESS` (local SCCRM uses `.\SQLEXPRESS`) | `AdaAcc` | 49976 | 1,381 | 001 and 002 |
| 005 | `100.106.107.80` / `POSSRV` | `POSSRV\SQLEXPRESS` | `AdaAcc` | 49711 | 1,408 | 001 and 002 |

The shared register topology is supported by actual `TSHD001` and `TSHD002`
header rows containing each stated branch and register, not inferred from IP
addresses or table names alone. There are two distinct Windows machines named
`POSSRV`: branches 003 and 005. Their addresses must never be interchanged.

Tailscale identities were online and matched stable node IDs:

- 001: `nKAsnKMrkZ11CNTRL`
- 003: `nFCuxvTVA521CNTRL`
- 004: `n3AqXUmdkF11CNTRL`
- 005: `nSKeeNSVgt11CNTRL`

### Configuration and listener evidence

Installed SCCRM configuration for 001, 004 and 005 was read at
`C:\Users\Administrator\AppData\Local\Programs\SCCRMonPOS\SCCRMonPOS.exe.config`
on the respective peer. It names the instance and `AdaAcc`. Their private
credential files were used in memory only, with `readonly_pilot` required.

All four machines have native Ada configuration at
`D:\AdaSoft\AdaPos4.0HpmFhn\AdaTools\AdaIni.ada`. The files contain each
expected configured instance and `AdaAcc`. This is binary configuration;
matching strings alone do not prove which database row Ada currently selected.
The pilot must additionally verify the running AdaPos status bar and search.

Branch 005's agent configuration at
`D:\SCstockDay\apps\adapos-sync\.env` also names `POSSRV\SQLEXPRESS`,
`AdaAcc`, and branch `005`. Its stored TCP port **49691 is stale**: connection
to that port was refused. The active SQL ERRORLOG records port **49711** on
29 October. Do not treat an old agent port as a permanent SQL endpoint.

For all four peers, current listener evidence comes from the SQL ERRORLOG
under `C:\Program Files (x86)\Microsoft SQL Server\MSSQL10_50.SQLEXPRESS\MSSQL\Log\ERRORLOG`;
005 instead uses `C:\Program Files\Microsoft SQL Server\MSSQL10_50.SQLEXPRESS\MSSQL\Log\ERRORLOG`.
001, 003 and 005 started SQL on 29 October; 004's current log starts 10 October.
No MDF, NDF or LDF was opened, copied or read.

003's existing read-only login was consumed from the scoped configuration
backup `C:\SC-Sync-Config-Backup\.env.branch003.before-transfer.20260909-113453.bak`.
The backup's endpoint is historical context; current instance/machine, database,
port and branch/register ownership were independently checked through SQL and
native config. The password is not recorded here.

### Endpoint identity and dynamic ports

Every connection returned the expected `SERVERPROPERTY('MachineName')` and
`DB_NAME()`. Do **not** require `@@SERVERNAME` to equal that machine name:
003, 004 and 005 retain names from old Windows installations:

- 003: `DESKTOP-I65J8U5\SQLEXPRESS`
- 004: `DESKTOP-2BA1CHI\SQLEXPRESS`
- 005: `DESKTOP-TQ7J8HJ\SQLEXPRESS`

From the development workstation, `<verified IP>\SQLEXPRESS` resolved and
connected to 001 in 186 ms and 005 in 153 ms. Named-instance discovery for
003 and 004 failed within the five-second connection budget, although direct
TCP to their ERRORLOG-verified listeners succeeded. Repeat connectivity from
HQ's actual service identity before enabling destinations. Do not open a broad
firewall rule to mask this difference. Future listener changes must cause a
retry/held destination until an approved endpoint is verified.

SQL Server 2008 R2 reports a signed 16-bit value for
`CONNECTIONPROPERTY('local_tcp_port')` on the tested high ports (for example
`-15825` for 49711). Do not use that unnormalized raw value as a positive-port
guard. ERRORLOG and successful configured TCP connection established the ports.

## Native customer schema and least privilege

All destinations returned `readonly_pilot`, `db_datareader=1`, and
`sysadmin=db_datawriter=INSERT=UPDATE=DELETE=0` for `dbo.TCNMCst`.
Read commands used a one-second session lock wait and five/eight-second command
budgets. No permissions were granted during discovery.

- `TCNMCst` has 101 inspected non-PIN columns on each destination.
- `PK_TCNMCst` uniquely keys `FTCstCode`, `varchar(20)`; no unique phone key was
  found. Phone equality alone therefore cannot establish identity.
- Database and text-field collations are `Thai_CI_AS`.
- Common fields include `FTCstName varchar(200)`, `FTCstTel varchar(50)`,
  `FTCstEmail varchar(100)`, active/approval flags, and insert/update metadata.
- The only observed schema difference is `FTCstNameOth`: 001/003 use
  `varchar(200)`; 004/005 use `nvarchar(200)` (400 bytes). A writer must validate
  representability and not assume all four byte schemas are identical.

Metadata signatures in column order, including names/types/lengths/precision/
scale/nullability/collation, SHA-256:

- 001/003: `49e6005512b5899ac03317e87a56b1e5deb5e19467c177d9f72ec3d33f3a3753`
- 004/005: `a593c736dccd0915bdca9ba02966fd93a30b9796d9442ce10be733457852eef5`

These hashes describe schema, **not** customer preservation. The main agent must
take and compare independent non-PIN row baselines before/after any pilot write.

## Existing native member transport observed on 005

`dbo.TCNTSyncTask` includes two customer tasks mapping `TCNMCst` to `TCNMCst`:

| Sequence | Name | Type | Allow | Usage | Log type | Last sync / connection |
| --- | --- | --- | --- | --- | --- | --- |
| 19 | D - Customer | 3 | 3 | 1 | 20 | 2020-05-18 |
| 69 | U - Customer | 2 | 3 | 1 | 73 | 2020-05-18 |

Both have schedule `D201301013000123100000000000100110` and an empty
`FTSynStaAllData`. Their presence and these undocumented flags do not prove an
available exact-member export/import interface, a successful current transfer,
or idempotent acknowledgements. No task was executed or enabled.

`TCNTSyncLog` columns are `FTLogSeq`, `FNLogType`, `FTPosCode`, `FTComName`,
`FNSynType`, `FTSynName`, `FTLogDetail`, and `FDLogIns`.
`TCNTSyncOpts` was absent; `TFFTmpQueue` exists. Discovery did not read arbitrary
log payloads or manipulate any native queue.

## Remaining acceptance boundaries

- This report does not authorize direct table writes. Use a restricted,
  idempotent create-only procedure after copy tests and provisioning review.
- Actual HQ-to-branch connectivity and service runtime must be measured.
- AdaPos's actual member search must be checked after delivery; no UI was
  controlled by this discovery agent.
- POS2 device file access at `100.93.254.58` (001) and `100.73.76.18` (004)
  did not expose the expected installed SCCRM config at the checked path.
  Their sharing/credentials were not changed. Shared SQL topology above was
  proved from the databases, but these two client configs remain uninspected.
