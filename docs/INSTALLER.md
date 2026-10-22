# Combined SCCRM installer — 1.3.2

## 1.3.5: slow SQL metadata checks

Branch 001 POS1 and POS2 both reported SQL -2 during setup against the same
`SC_001\SQLEXPRESS` / `AdaAcc`. Read-only reproduction confirmed successful login
and database permissions, followed by intermittent timeouts reading catalog
metadata. One catalog count of 460 user tables completed after 38 seconds; the
old per-command budget was ten seconds. A three-second session-only lock-wait
probe still produced command timeout -2 rather than lock timeout 1222, so the
underlying server delay has not been proven to be a blocking transaction.
No session was killed and no database data, permissions or server configuration
was changed. The temporary diagnostic connection was closed.

Setup 1.3.5 allows 15 seconds for connection and 60 seconds per verification
command, retains every existing read-only/role/schema/branch check, and reports
the current phase in the connection dialog. Authentication rejection, connection
timeout, an authenticated metadata timeout, and a reported lock timeout have
separate safe messages without raw SQL error text or credentials. Installation
still fails closed if any verification cannot finish; no timeout is treated as
approval. Existing app updates stay optional. Server-side latency may still
require separate investigation if the larger bounded budget is exceeded.

Download `SCCRMonPOS-Setup-1.3.2.exe` from the existing StockDay admin page. Exit
SCCRM first; AdaPos can remain open. There is no separate ZIP or command script.
The same company device/Tailscale policy runs before any setup connection work.

When Install is clicked, the bundled native executable runs `--setup-adapos`
against the selected installation directory. It first looks for the existing
SCCRM connection, then the local StockDay agent at `D:\SCstockDay`,
`C:\SCstockDay`, or the corresponding `SC-StockDay-Ordering` folders. Only the
explicit database/branch fields are imported; agent admin passwords and tokens
are excluded. No credential is built into the installer or website.

For a local named SQL instance, setup reads its current registry TCP port before
trying its configured name. It never scans other servers or local SQL instances.
The native watcher retains named-instance configuration and its normal port
discovery, so a SQL Express port change does not require reinstalling SCCRM.

Setup verifies database SELECT permission, refuses `sa`, elevated database/server
roles, database/table write or ALTER permissions, and checks AdaPos header/detail
columns with SELECT-only queries. An imported agent branch must match at least
one nonempty receipt table. Missing settings or a failed check opens a connection
dialog; installation cannot continue until a suitable read-only connection works.
Silent setup fails closed. No SQL accounts, SQL services, firewalls, AdaPos data,
or permissions on the database are modified.

After verification, setup backs up existing configuration under
`data/configuration-backups`, then merges only AdaPos settings. Database identity
is stored in the existing `SCCRMonPOS.secrets.config` format; its file and backup
ACLs grant only the current Windows user, SYSTEM, and administrators. This file
is not DPAPI encrypted. Existing unrelated API credentials, session files,
watermarks and queues remain untouched. A failed configuration write restores
the original configuration bytes. Installed older SCCRM versions understand the
same file format, including if later installer file extraction fails.

Setup only updates these local settings when the user chooses Install. It does
not alter app configuration on the Welcome page. The success exit code is 43;
older executables that ignore the command return 0 and cannot authorize this
installer stage. The existing device-check exit code remains 42.

The installer opens SCCRM by default on Finish. A new staff device still needs
its existing staff PIN; previously saved staff sessions are preserved. Membership
and purchase history continue using the original Supabase backend. Future
desktop updates remain optional and do not rerun local setup automatically.

Verification includes configuration preservation, credential escaping, restricted
file access, failure rollback, environment conflicts, XML external entity
rejection, native read-only SQL verification against Branch 005, and the existing
desktop/member/device/history suites. Actual local installation and receipt
confirmation on Branch 005 are recorded separately from these checks.
