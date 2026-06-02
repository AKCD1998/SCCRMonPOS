---
name: nb005-final-scan-adatools-sky-printer-cardreader
description: "Final NB-005-01 scan: AdaIni.ada solves missing connection string mystery (Jet binary DB read by all Ada modules); AdaPrnSrv = Crystal Reports document queue NOT ESC/POS (receipt printing via Windows drivers); FTP server ftp://147.50.231.154 scgroup/Ad@Soft#21; TWO PARALLEL DATABASES discovered (AdaSky syncs legacy TSALE*/TMEMBER schema NOT AdaAcc); AdaSmartQ undocumented 5th module; xp_cmdshell enabled by AdaPrnSrv/AdaTools at startup; Thai ID card = MOPH MQTT tool; AdaMonitor shows passwords on screen."
metadata: 
  node_type: memory
  type: project
  originSessionId: 4eb79e91-534f-4357-83ab-417e0a3131b1
---

## AdaIni.ada — The missing connection string, SOLVED

`D:\AdaSoft\AdaPos4.0HpmFhn\AdaTools\AdaIni.ada` is a **Jet/Access binary database** (not a text INI file despite the extension). Every AdaPos module reads this file at startup to get its SQL Server connection string. This is why no text INI, XML, config, or registry key ever contained a server address — it was always in a binary Access file in the AdaTools folder.

- All modules confirmed reading it: AdaPosBack, AdaPosFront, AdaSmart, AdaPrnSrv, AdaImportExport
- Connection string format: `Provider=SQLOLEDB.1;Password=...;Persist Security Info=True;User ID=AdaSoft;Initial Catalog=`
- Separate login for purge: `AdaTools\AdaIni.ada` + `wCNLoginPurge` — purge operations require a distinct credential

---

## AdaTools.exe — Feature map (v4.6006.0001, Feb 1 2017)

| Menu/Window | Function |
|---|---|
| `omnToolBkpRst` / `wCNBkUpReStore` | SQL Server backup and restore |
| `omnToolConfig` / `wCNConfig` | Database connection configuration |
| `omnToolsExeSql` / `wCNExeSQL` | **Direct SQL execution console** |
| `omnToolPurge/All/Tran` / `wCNPurgeDbSQL` | Data purge (all records / transactions only) |
| `omnToolsCompare` | **Database schema comparison** |
| `omnToolsInit` | Database initialization (new install) |
| `omnToolsUpdAct` | Update/patch actions |
| `omnToolsUpload` | Data upload to SQL Server |
| `omnToolUtilCompact` | Compact Access database |
| `omnToolUtilRepair` | Repair database |
| `AdaPatch Server` | **Centralized schema patching — pushes DB patches to connected branches** |

**Key text strings:**
- "Select database for connection"
- "Select connection for back office (AdaSmart, AdaPosBack)"
- "Connected of Front Office (AdaSmartQ, AdaPosFront)"

### AdaSmartQ — undocumented 5th module
Referenced in AdaTools connection setup alongside AdaPosFront. Not seen anywhere else. Likely a customer-facing queue display or self-service kiosk variant of AdaSmart. Never encountered in any file listing.

---

## AdaMonitor.exe — Network health dashboard (.NET, Telerik UI, Dec 1 2016)

Three-tier architecture view: **HQ → Store Server → POS Terminal**

Grid columns displayed:
| Column | Caption | Risk |
|---|---|---|
| `FTSysConSrv` | Server | SQL Server address |
| `FTSysConUsr` | User | SQL login username |
| **`FTSysConPwd`** | **Password** | **⚠️ SQL password displayed in plain text in grid** |
| `FTSysConDbName` | Database | Database name |
| `FTSysStatus` | Status | Connection alive/dead |
| `FNSysLogErr` | Log.Error | Error count |

EPR subsystem strings: `EPR_tCS_XMLEPRDBServer`, `EPR_tCS_XMLCfgSaleCN/CR/DN/DR/Ret` — AdaMonitor configures EDC card payment export paths (CN=credit note, CR=card receipt, DN=debit note, DR=debit receipt, Ret=return).

Not run on NB-005-01 (desktop shortcut present but never executed).

---

## AdaPrnSrv.exe — RECEIPT PRINTER MYSTERY CLOSED

**AdaPrnSrv is a Crystal Reports document queue manager, NOT an ESC/POS hardware driver.**

- No COM, LPT, port 9100, Baud, or ESC/POS strings anywhere in the binary
- Prints `.rpt` Crystal Reports files via Windows printer drivers
- Manages unprinted document queue from `TSysLogPrnDocHHT` (HHT = handheld terminal):
  ```sql
  WHERE (FTLogStaPrint <> '1' Or FTLogStaPrint IS NULL)
  SET FTLogStaPrint = '1'
  DELETE FROM TSysLogPrnDocHHT WHERE FTLogStaPrint = '1'
  ```
- Forms: `wCNPrnBill`, `wPrnDoAdaPrnSvr`, `wPrnDoc` — bill printing and document spooler
- Reads connection from `AdaTools\AdaIni.ada`

**Receipt printing architecture (corrected):**
```
AdaPosFront.exe → Windows Print API → Windows printer driver → Receipt printer
AdaPrnSrv.exe  → Crystal Reports → Windows Print API → Windows printer driver → Document printer
```
Not TCP port 9100. Not ESC/POS byte stream. Standard Windows GDI printing via drivers.

### ⚠️ xp_cmdshell enabled at startup

AdaPrnSrv (and AdaTools) execute these SQL commands as part of initialization:
```sql
EXEC sys.sp_configure N'xp_cmdshell', N'1'
EXEC sys.sp_configure N'Ole Automation Procedures', N'1'
EXEC sys.sp_configure N'Ad Hoc Distributed Queries', N'1'
EXEC sys.sp_configure N'clr enabled', N'1'
EXEC sys.sp_configure N'remote admin connections', N'1'
RECONFIGURE WITH OVERRIDE
```
SQL Server runs with all advanced/dangerous features permanently enabled. Combined with `sa`/`adasoft` credentials in plaintext and SQL injection in browse stored procedures, any attacker reaching the DB can execute OS commands.

---

## Sky.mdb — FTP Server Identity CONFIRMED

Opened via 32-bit PowerShell with Jet OLEDB 4.0 (standard 64-bit PowerShell fails — Jet driver is 32-bit only).

### mtFTP — FTP credentials
| Field | Value |
|---|---|
| Profile name | SkyFTP |
| **FTP server** | **`ftp://147.50.231.154`** |
| **Username** | **`scgroup`** |
| **Password** | **`Ad@Soft#21`** |
| Port | 21 |

147.50.x.x = Thai IP block (NECTEC/True Internet range). All 6 branches upload to this single endpoint.

### ⚠️ TWO PARALLEL DATABASES DISCOVERED

Sky.mdb's `SqlDef` table reveals AdaSky queries a **completely different schema** from AdaAcc:

| AdaSky table | AdaAcc equivalent | Schema |
|---|---|---|
| `TSALEHD` / `TSALEDT` / `TSALERC` / `TSALECD` | `TPSTSalHD/DT/RC` | Legacy T-prefix |
| `TMEMBER` | `TCNMCst` | Legacy T-prefix |
| `TPRODUCT` | `TCNMPdt` | Legacy T-prefix |
| `TSUPPLIER` | `TCNMSpl` | Legacy T-prefix |
| `TBANK` | `TCNMBank` | Legacy T-prefix |
| `TUNIT` | `TCNMUnit` | Legacy T-prefix |
| `TGRPBOM` | unknown | Legacy T-prefix |

**The HQ FTP relay server (147.50.231.154) collects data in a legacy flat T-schema, NOT in AdaAcc's TCN/TPS format.** This means:
- Each branch has (at minimum) TWO databases: AdaAcc (operational, TCN/TPS schema) + a legacy T-schema DB that AdaSky reads from
- The central server at 192.168.0.71 likely has BOTH schemas present
- adapos-sync reads AdaAcc (TCN/TPS) — correct. The legacy T-schema DB is a separate aggregation layer.
- The 7-day rolling sales window (`DateSelect = 7`) applies to the legacy schema sync

### tbDownloadSetup — master data pushed from HQ to branches
`TBANK`, `TGRPBOM`, `TMEMAREA`, `TMEMBER`, `TMEMDISC`, `TMEMOCP`, `TPRODUCT`, `TSUPPLIER`, `TUNIT`

### tb_ActionFlow — historical FTP log
Last entries: November 2004 / January 2007. The legacy FTP log has not been written since ~2007. Current AdaSky uses `LogAdaSky.XML` for active logging.

### Table1 — dealer codes
Five entries: `00001`–`00005` (5 branch warehouses).

---

## Thai ID Card Reader — MOPH MQTT Tool

| Field | Value |
|---|---|
| Executable | `moph-smartcard-reader-mqtt.exe` |
| Size | 19 KB (launcher only) |
| Created | 2026-05-14 |
| Source | GitHub Actions artifact (Thai government open-source) |

**moph** = Ministry of Public Health Thailand. Reads the Thai national citizen smart card (บัตรประชาชน) and publishes data as MQTT messages to a local broker. AdaPos or another app subscribes to the MQTT topic and auto-fills customer name, ID, and DOB.

Populates `TCNMCst.FTCstCardID` (varchar 15) — the field in the customer master specifically for national ID.

Installed May 14, 2026 — same day NB-005-01's IP changed to .231. A recent addition to Branch 005 workflow.

---

## Updated understanding after NB-005-01 complete

| Layer | Before | After |
|---|---|---|
| Connection string mystery | Unknown | **SOLVED — AdaIni.ada Jet binary** |
| Receipt printing architecture | ~10% | **~90% — Windows GDI via Crystal Reports, not ESC/POS** |
| Sync mechanism / FTP | ~90% | **~98% — server IP, credentials, two-schema pattern confirmed** |
| Two parallel DB schemas | Unknown | **DISCOVERED — AdaAcc (operational) + legacy T-schema (FTP sync)** |
| Executable business logic | ~65% | **~75% — AdaTools/AdaMonitor/AdaPrnSrv fully mapped** |
| Security posture | ~80% | **~95% — xp_cmdshell confirmed always-on, passwords in grid UI** |
| Customer ID capture | Unknown | **CONFIRMED — MOPH smart card reader → MQTT → TCNMCst.FTCstCardID** |
| **Overall** | **~92%** | **~95%** |

## What the central server Prompt A must now investigate additionally

Given the two-schema discovery:
1. Does the central server have a legacy T-schema database alongside AdaAcc?
2. What is it called? (`AdaSale`? `AdaSync`? `AdaHQ`?)
3. Is 147.50.231.154 a third-party hosting server or is it the central server at 192.168.0.71 on a public IP?
4. Are TSALE*/TMEMBER tables on the central server the source for adapos-sync, or is AdaAcc?
