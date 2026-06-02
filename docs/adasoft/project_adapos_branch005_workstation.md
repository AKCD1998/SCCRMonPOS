---
name: Branch 005 Workstation Expedition — POSSRV | 192.168.0.127
description: Full investigation of Branch 005 workstation. OFFLINE-FIRST architecture confirmed. Each branch has its own local SQL Server. Sync is manual FTP via AdaSky.exe. Source SQL files (80+ stored procs) found. Unprocessed receipts problem is a CENTRAL SERVER issue only — branches process locally correctly. Full data flow decoded.
type: project
originSessionId: external-audit-10
---

## Machine identity
- Hostname: `POSSRV`
- IP: `192.168.0.127`
- Branch: 005 (newest, opened April 2026)
- Investigation date: 19 May 2026

---

## 🏆 THE MOST IMPORTANT FINDING OF THE ENTIRE EXPEDITION

### Architecture: OFFLINE-FIRST with Manual FTP Sync

Each branch has its own local SQL Server. AdaPos connects ONLY to local DB. Central server is NOT directly accessible from workstations. Data moves via FTP zip files, manually triggered.

| Question | Answer |
|---|---|
| Local SQL Server? | **YES** — `POSSRV\SQLEXPRESS`, AdaAcc 227 MB |
| AdaPos connects to central? | **NO** — local `.\SQLEXPRESS` only |
| Central server reachable? | **NO** — `Test-Connection 192.168.0.71` = False |
| Loyalty server reachable? | **NO** — `Test-Connection 192.168.0.155` = False |
| How data reaches central? | **FTP zip files, manually triggered via AdaSky.exe** |
| How often is sync run? | **Manually — no scheduled tasks anywhere on machine** |

---

## Complete data flow — fully decoded

```
1. CASHIER SALE
   AdaPosFront.exe → POSSRV\SQLEXPRESS\AdaAcc (writes TPSTSalHD/DT)

2. BACK-OFFICE OPERATIONS
   AdaPosBack.exe → POSSRV\SQLEXPRESS\AdaAcc (reads/writes all tables)

3. EXPORT (send to HQ/other branches)
   AdaImportExport.exe → reads local AdaAcc → generates XML/CSV
   → zipped as Ada005-000-YYMMDD-HHMMSS.zip
   → placed in AdaSky\Outbox\000\

4. FTP UPLOAD (MANUAL — staff must trigger)
   AdaSky.exe → reads Outbox → uploads zip to FTP httpdocs/scgroup/000/
   → logs to AdaSky\Log\MANUAL_GEN_*.txt

5. RECEIVE FROM OTHER BRANCHES
   AdaSky.exe → downloads from FTP httpdocs/scgroup/005/
   → unzips to AdaSky\Inbox\
   → creates AUTO_RECEIVE_*.Txt manifest

6. IMPORT (receive master data / transfer documents)
   AdaImportExport.exe → reads Inbox zips → imports into local AdaAcc
   → logs to AdaImportExport\LogFiles\LogImport.log

7. CENTRAL SERVER AGGREGATION (HQ side)
   Central server (192.168.0.71) receives zips from ALL branches
   → central AdaAcc is the consolidated database
   → explains why central has 429,054 sales vs 1,234 locally
```

FTP zip naming convention: `Ada{SrcBranch3}-{DstBranch3}-{YYMMDD}-{HHMMSS}.zip`
Example: `Ada005-000-260511-112027.zip` = Branch 005 → HQ, 11 May 2026, 11:20:27

---

## Critical implication for SC-StockDay-Ordering

> **adapos-sync reads from ONE place only — central AdaAcc at 192.168.0.71.**
> It does NOT need to connect to individual branch SQL Servers.
> The central database is the authoritative aggregate of all branches.
> Branch local databases are irrelevant for SC-StockDay-Ordering.

---

## The unprocessed receipts problem — REFRAMED

**Branches process their own local copies CORRECTLY.**
All 273 Type 7 receipt documents on POSSRV local DB: `FTPthStaPrcDoc = 1` (processed).

The 91.7% unprocessed problem on the central server means:
**HQ staff are not running the "process receipt" step on the central system after receiving FTP zips.**

The problem is at the HQ import/processing workflow, not at the branch level.

---

## AdaSky queue status

**Outbox: EMPTY** — last successful outbound sync: 11 May 2026 at 11:20
**Inbox: 2 manifest files** — listing received zips from branches 000, 001, 003, 004 (Apr 22–30)
**Last Branch 005 sync to central: 11 May 2026 — 8 days ago as of investigation date**

Real-time data is NOT possible — branches sync manually. Central DB lags by hours or days.

Log pattern: all log files prefixed `MANUAL_GEN_` — confirms 100% manual triggering.
`_NF` suffix = "Not Found" (nothing in Outbox to send).

---

## Executable inventory — KEY CORRECTION

AdaPos4.0.exe does NOT exist as a single binary. The POS suite is:

| File | Size | Date | Purpose |
|---|---|---|---|
| `AdaPos\AdaPosBack.exe` | 47,384 KB | 29 Apr 2019 | **Back-office management** |
| `AdaPos\AdaPosFront.exe` | 13,380 KB | 6 Jan 2020 | **Cashier front-end** |
| `AdaSmart\AdaSmart.exe` | 49,440 KB | 29 Jan 2020 | Unknown — large, likely analytics/reporting |
| `AdaImportExport\AdaImportExport.exe` | 7,572 KB | 29 Jan 2019 | Data export/import engine |
| `AdaImportExport\AdaExportAuto.exe` | 7,572 KB | 29 Jan 2019 | Auto export variant |
| `AdaImportExport\AdaImportAuto.exe` | 7,572 KB | 29 Jan 2019 | Auto import variant |
| `AdaSky\AdaSky.exe` | 2,020 KB | 30 Mar 2017 | **FTP sync manager** |
| `AdaSky\AdaLogSky.exe` | 324 KB | 19 Sep 2014 | Sync log viewer |
| `AdaSync\AdaSync.exe` | 480 KB | 7 May 2018 | Newer sync mechanism (purpose TBC) |
| `AdaTools\AdaTools.exe` | 2,520 KB | 1 Feb 2017 | Utility tools |
| `AdaTools\AdaMonitor\AdaMonitor.exe` | 534 KB | 1 Dec 2016 | Monitoring tool |
| `AdaTools\AdaBarCode.exe` | 5,496 KB | 8 Feb 2019 | Barcode tools |
| `AdaEJ\AdaEJ.exe` | 4,844 KB | 16 Aug 2016 | Electronic journal |
| `AdaPurge\AdaPurge.exe` | 860 KB | 13 Nov 2015 | Database purge/mirror tool |

---

## 🏆 GOLDMINE FIND — SQL Source Files

`AdaDB\Source_SQL\` contains **80+ stored procedure .sql files** — the actual business logic source code. No decompilation needed.

Key files confirmed:
- `STP_DOCxTCNTPdtTnfDT1.sql` through `DT4.sql` — transfer document processing (Types 1–4)
- `STP_PRCxUpdQtyNow*.sql` — stock quantity recalculation
- `STP_PRCxSTK_MonthEnd.sql` — month-end stock processing
- `STP_SYNxAddLogChange.sql` — sync change logging
- `AdaDB_VCN_TCNTSale.sql`, `AdaDB_VCN_TCNTPurChase.sql` — sales/purchase views

### Transfer procedure logic confirmed from source
From `STP_DOCxTCNTPdtTnfDT4.sql`:
- Type 4 (dispatch): deducts from `FTPthWhFrm`, adds to `FTPthWhTo`
- Type 7 (receive): adds to receiving branch warehouse
- **Uses `FCPtdQtyAll` (dispatched qty) for BOTH debit and credit sides**
- **No received quantity field — confirmed architecturally in source code**
- Assumes received qty = dispatched qty always

---

## Config files — key contents

### AdaSky\SkyConfig.INI — Most important config
```ini
[SYSTEM]
SKY=Provider=Microsoft.Jet.OLEDB.4.0;Data Source=...\AdaSky\Sky.mdb;
    Jet OLEDB:Database Password=mysky;

[M_FTP]
INBOX=httpdocs/scgroup/005     ← Branch 005 receives HERE
OUTBOX=httpdocs/scgroup        ← Sends to HQ root folder

[M_FOLDER]
DAY_OF_KEEPLOG=30
```

FTP credentials stored inside `Sky.mdb` (Access DB, password: `mysky`). FTP server is external (not 192.168.0.71).

### AdaPurge\AdaPurge.ini — Credentials exposed
```ini
[Source]
ServerNameS=ADA74\Sql2008     ← ADA74 = likely 192.168.0.74
UserIdS=sa
PasswordS=adasoft              ← SA password confirmed same across all machines
DataBaseS=AdaAcSample2010R6

[Destination]
ServerNameD=ADA74\Sql2008
DataBaseD=AdaMiror
```

### AdaEJ\EJ.INI — Copy-paste error from Branch 001
```ini
Branch=001
BranchHQ=001
PthPic=D:\Project\AdaPosFashion\AdaEJ   ← dev path, never updated
```
Electronic journal config was copied from Branch 001 and never updated for Branch 005.

### AdaSky\SkyLogConfig.INI — Table-to-Thai mapping
Full table name ↔ Thai description ↔ English mapping for all sync log categories:
- `TCNTPdtTnfHD` = โอนสินค้า = Product Transfer
- `TPSTSalHD` = ขายปลีก = Sale(Retail)
- etc.

---

## Local database comparison

| Metric | Local (POSSRV) | Central (192.168.0.71) |
|---|---|---|
| Database | AdaAcc | AdaAcc |
| Size | 227 MB | 4,600 MB |
| Tables | **444** | 435 |
| Created | 9 Apr 2026 | Long-established |
| Sales (TPSTSalHD) | 1,234 | 429,054 (all branches) |
| Products (TCNMPdt) | 6,661 | 6,663 |
| Transfer docs | 337 | 6,737 |
| Stock card rows | 70,800 | 636,623 |
| Adjustments | 0 | 1,632 |

Local has 9 extra tables = per-workstation temp tables (`Tmp_ChkDT{hostname}`, `TTmpTagBar{hostname}`) created when that workstation performs stock checks. Normal behavior.

### Transfer status on local DB
ALL 273 Type 7 receipts: `FTPthStaPrcDoc = 1` (processed) ← vs 91.7% unprocessed on central

### Most recent activity from logs
User `dao1` logged in 14 May 2026 at 08:22, performed:
- `รับโอน` (receive transfer)
- `ยืนยันโอนสินค้า` (confirm product transfer)

---

## Windows services
- No Adasoft-specific services installed on workstation
- SQL Server services: `MSSQL$SQLEXPRESS` (Running, Automatic), `SQLBrowser` (Running), `SQLWriter` (Running)
- `SQLAgent$SQLEXPRESS` — Stopped, Disabled
- Zero scheduled tasks for Adasoft

---

## New discoveries summary

| # | Discovery | Significance |
|---|---|---|
| 1 | **OFFLINE-FIRST confirmed** | Each branch = independent SQL Server node |
| 2 | **Manual FTP sync only** | No automation whatsoever — entirely staff-dependent |
| 3 | **AdaPos = 2 executables** | AdaPosBack.exe (mgmt) + AdaPosFront.exe (cashier) |
| 4 | **Source SQL files found** | 80+ stored procedures readable without decompilation |
| 5 | **Received qty gap confirmed in source** | `FCPtdQtyAll` used for both sides — architectural |
| 6 | **Unprocessed = HQ problem, not branch** | Branches process locally correctly |
| 7 | **ADA74 = likely 192.168.0.74** | Branch machine with SQL Server 2008 |
| 8 | **AdaSync.exe** | Newer sync mechanism (May 2018), purpose TBC |
| 9 | **AdaSmart.exe** | 49 MB unknown app — likely analytics/reporting |
| 10 | **EJ.INI copy-paste error** | Branch 001 config never updated for Branch 005 |
| 11 | **FTP credentials in Sky.mdb** | Access DB password `mysky` — readable |
| 12 | **Central unreachable from branch** | Different network segment — by design |

---

## Remaining unknowns after this investigation

| Unknown | How to answer |
|---|---|
| AdaSmart.exe purpose | String extraction or launch on non-production machine |
| AdaSync.exe vs AdaSky.exe | Read AdaSync config files |
| FTP server identity | Open Sky.mdb with Access (password: mysky) |
| ADA74 = 192.168.0.74 confirmation | Check hosts file or ARP table |
| 80 source SQL files — full read | Read each .sql file in AdaDB\Source_SQL\ |
| Who processes FTP zips at HQ? | Investigate HQ workstation (not server) |
| Branch 004 date bug cause | Check POS config on Branch 004's POSSRV equivalent |
| AdaPosFront.exe UI/menu | Take screenshots when software is open |

---

## Updated understanding estimates

| Layer | Before | After |
|---|---|---|
| System architecture | ~60% | **~95%** — fully understood |
| Data flow (branch → central) | ~40% | **~95%** — FTP sync fully decoded |
| Transfer processing logic | ~75% | **~90%** — source SQL confirms gap |
| Executable business logic | ~40% | **~55%** — source SQL found, binaries still unread |
| Config & deployment | ~88% | **~92%** |
| **Overall system** | **~78%** | **~87%** |

## SC-StockDay design implications
1. `adapos-sync` reads central AdaAcc only — correct as designed
2. Sync lag is real — branches may be 1–8+ days behind central
3. Must label all data with "as of last sync" timestamp
4. The 91.7% unprocessed receipts = HQ workflow problem, not branch problem
5. A fix at HQ processing workflow alone could resolve the phantom stock issue without SC-StockDay — but SC-StockDay adds the missing discrepancy recording layer
