---
name: Session 9 — Full Expedition Report (All Parts)
description: Largest single investigation session. DB queries 1-15, full file system scan, Windows environment, IIS, SQL instances, all databases, service inventory, scheduled tasks, new discoveries. 10 major new findings including branch 004 Buddhist Era date bug, two 9GB backup DBs online, loyalty DB on separate server 192.168.0.155, LAN architecture confirmed, SC Group (1989) business name confirmed.
type: project
originSessionId: external-audit-9
---

## Session scope
- 15 database queries
- Full file system scan: AdaPos4.0HpmFhn, AdaPos3.0HpmFhn, AdaAbreastTools, AdaUploadPoint
- Windows services, scheduled tasks, IIS apps, SQL instances, all databases
- Log file contents
- 10 major new discoveries

---

# PART 1 — DATABASE RESULTS

## DB-1 — Unprocessed inbound receipts by branch
| ReceivingBranch | UnprocessedReceipts | OldestUnprocessed | NewestUnprocessed |
|---|---|---|---|
| 001 | 1,038 | 2024-12-02 | 2026-05-18 |
| 003 | 764 | 2024-12-02 | 2026-05-18 |
| 004 | 748 | 2024-12-02 | 2026-05-16 |
| 005 | 273 | 2026-04-06 | 2026-05-18 |
| 000 | 12 | 2025-08-25 | 2026-05-17 |
| **TOTAL** | **2,835** | | |

Branch 001 worst (1,038). Branch 000's 12 = return-direction transfers (branches → HQ).
All four selling branches have unprocessed receipts from the very first day of recorded transfers (Dec 2, 2024).

---

## DB-2 — Stock adjustment volume by branch and month (key insight)
Only branch 000 has records in `TCNTPdtAjsHD`. No receiving branch (001, 003, 004, 005) has any adjustment documents.

**Escalation pattern:**
| Period | Monthly average |
|---|---|
| 2020–2022 | 1–5 adjustments/month |
| 2023 | 5–39 adjustments/month |
| 2024 | 19–64 adjustments/month |
| 2025 | 41–72 adjustments/month |
| 2026 (partial) | 12–44 adjustments/month |

**10–15× escalation from 2020 to 2024–2025.** Directly correlates with increasing transfer volume and unprocessed receipts causing phantom stock.

---

## DB-3 — TCNTPdtTnfDT column map (74 columns) — KEY CONFIRMATION
Column `FCPthQtyRcv` **does NOT exist**. Confirmed architecturally impossible to record received ≠ dispatched quantity.

Key columns:
- `FCPtdQty` — dispatched quantity
- `FCPtdQtySet` — set/bundle quantity
- `FTPtdStaPrcStk` (col 39) — stock processing flag
- `FTPtdApOrAr` (col 44) — AP or AR reference
- `FTWahCode` (col 45) — warehouse code
- `FTPtdStaPrcStkCrd` (col 65) — stock card processing flag
- Full audit trail: DateUpd/Ins, WhoUpd/Ins (cols 69–74)

---

## DB-4 — TCNTPdtTnfHD column map (102 columns)
Key columns:
- `FTPthDocNo` varchar(20) — document number
- `FTPthDocType` varchar(2) — '2','3','4','7' observed
- `FDPthDocDate` datetime
- `FTPthStaDoc` (col 67) — document approval status
- `FTPthStaPrcDoc` (col 68) — stock processing status
- `FTPthStaPrcSpn` (col 69) — supplier processing
- `FTPthStaPrcCst` (col 70) — cost processing
- `FTPthStaPrcGL` (col 71) — GL posting status
- `FTPthStaPost` (col 72) — posted flag
- `FTPthBchFrm` (col 92) varchar(5) — source branch
- `FTPthBchTo` (col 93) varchar(5) — destination branch
- Full payment breakdown: cash/cheque/credit/certificate/coupon/clearance/misc

---

## DB-5 — TCNTPdtAjsHD column map (24 columns)
Note: column prefix is `FTIsh` (not `FTAjs`) — naming inconsistency.
Key: `FTIshBchTo` (col 18) — destination branch for adjustment. `FTIshDocType` (col 2) — adjustment type. `FTIshRmk` (col 13) varchar(200) — remark field.

---

## DB-6 — The 520-document gap — RESOLVED
Original estimate of 520 unmatched outbound transfers was **incorrect**.
Corrected query returned **0 unmatched** — the gap is explained by **batching**: on high-volume days, one Type 7 receipt covers multiple same-day Type 4 dispatches to the same branch. The gap is not missing documents — it's many-to-one grouping.

---

## DB-7 — Complete stored procedure list (65 total)
All 65 names confirmed. Key groups:

**Transfer processing:** `STP_DOCxTCNTPdtTnfDT1`, `DT2`, `DT3`, `DT4`
**POS sales:** `STP_DOCxTPSTSalDT1`, `DT1Day`, `DT1DayCloseShift`, `DT9`, `DT9Day`, `DT9DayCloseShift`
**Stock qty management:** `STP_PRCxUpdQtyNow`, `STP_PRCxUpdQtyNowByDoc`, `STP_PRCxUpdQtyNowByPdt`, `STP_PRCxGetQtyNowByPdt`
**Month-end stock:** `STP_PRCxSTK_MonthEnd`, `STP_PRCxSTK_MonthEndEx`, `STP_PRCxSTK_ReMonthEndByDoc`, `STP_PRCxSTK_ReMonthEndByDocEx`, `STP_PRCxSTK_ClearProcess`
**SQL Injection (3 confirmed):** `STP_CN_GetBrowseMaster`, `STP_CN_GetBrowseDT`, `STP_CN_GetBrowseHD`
**Approval:** `STP_DOCxPrcApprove`, `STP_MAxPrcApprove`, `STP_PRCxDocNotApprove`
**Accounting:** `STP_DOCxTACTPiDT1` (purchase), `STP_DOCxTACTSiDT1` (sales invoice), `STP_DOCxTACTVatDT*` (VAT), `STP_DOCxTACTCsmDT*` (cash/bank)
**Backup:** `STP_BACKUPDB`, `STP_SYSnBackupDB`
**Logging:** `STP_MSGxWriteTSysPrcLog`, `STP_MSGxWriteTUserPrcLog`, `STP_SYNxAddLogChange`
**Adjustment:** `STP_DOCxTCNTPdtAdjStk`
**Index rebuild:** `SP_ReIndex` (cursor, blocking on 435 tables)

---

## DB-9 — POS sales by branch
| Branch | Total Sales | Last Sale |
|---|---|---|
| 001 | 198,134 | 2026-05-18 |
| 003 | 166,158 | 2026-05-18 |
| 004 | 62,108 | **2569-04-15** ⚠️ Buddhist Era bug |
| 005 | 1,228 | 2026-05-18 (new, started April 2026) |

Sales document number format: `S2604004002-0008780` = year(26=2026) + month(04) + branch(004) + POS(002) + sequence.
Column prefix is `FTShd` (not `FTSal`). Most recent cashier at branch 004: `dao1`.

---

## DB-10 — TPSTSalHD key columns (120 total)
`FTShdDocType`: varchar(2) — 1=retail sale, 9=return
`FTShdUsrEnter/Packer/Checker/Sender` — multi-role audit trail
`FCShdMnyCsh/Chq/Crd/Ctf/Cpn/Cls/Cxx` — payment breakdown fields
`FTCtrCardID` — loyalty card ID field (linked to loyalty system)
`FDShdDocDate` — datetime (has Buddhist Era bug at branch 004)

---

## DB-11 — TPSTSalDT key columns (90 total)
`FCSdtQty` — sold quantity
`FCSdtQtyRet` — returned quantity
`FDSdtExpired` — datetime — **expiry date field** (pharmacy-critical)
`FTSdtLotNo` — varchar(50) — lot number (pharmacy-critical)
`FTCpnCode` — coupon code

---

## DB-12 — System users (24 accounts)
| Level | Code | Name | Notes |
|---|---|---|---|
| 9 | ADASOFT | SUPPORT | **Vendor backdoor — highest permission** |
| 8 | 008, 009, benz1(songpol), Owner(scowner) | Admin | 4 full admin accounts |
| 4 | AMMNGR | ADMINISTRATOR MANAGER | Area manager |
| 3 | c00101 | ผู้จัดการ | Branch manager |
| 2 | ph00101, ph00102 | เภสัชกร | Pharmacists |
| 2 | b00101 | รองผู้จัดการ | Deputy manager |
| 1 | dao, dao1, a00101–a00105, admin1, staff1, stock1, sku1, User, Manager, msc | Floor staff |

All accounts: `FTUsrLng=1` (Thai). Vendor account `ADASOFT` has level 9 — above all client accounts.

---

## DB-13 — Key system configuration values
| Setting | Value | Notes |
|---|---|---|
| `PCstPntUrl` | `http://localhost/API2Member` | Loyalty point service URL — pointing to localhost |
| `AInvTaxNme` (user value) | `เอสซีกรุ๊ป(1989)Frm_SQL_SMInvoice.rpt` | **Business name: SC Group (1989)** |
| `PLimitItem` | 200 | Max items per bill |
| `AAlwAlipay` | 1 (GHL) | Alipay configured but X-Key empty |
| `PPromptPay` | empty | PromptPay not configured |
| `PRcvCstID` | NULL | National ID card scan not required |
| `AAlwTicket` | 0 | Ticket system disabled |
| `PInvRst` | 1 | Invoice number resets periodically |
| `AdaWebAbreast debug` | true | **Debug mode ON in production** |

---

## DB-14 — Stock card (TCNTPdtStkCard) — confirmed active
| Branch | Total Lines | Earliest | Latest |
|---|---|---|---|
| 000 | 594,582 | 2024-12-01 | 2026-05-18 |
| 001 | 14,938 | 2024-12-02 | 2026-05-18 |
| 003 | 13,689 | 2024-12-02 | 2026-05-18 |
| 004 | 12,817 | 2024-12-02 | 2026-05-18 |
| 005 | 597 | 2026-04-10 | 2026-05-18 |
| **Total** | **636,623** | | |

**Stock movement types:**
| FTStkType | RecCount | Meaning |
|---|---|---|
| 0 | 535,077 | POS sales deductions |
| 1 | 58,248 | Stock-in (purchases + processed transfers) |
| 2 | 43,061 | Stock-out / adjustments / returns |
| 5 | 237 | Physical count adjustments |

Confirmed: when Type 7 transfers ARE processed, they create `FTStkType='1'` entries correctly. The processing works — it's just not being triggered.

---

## DB-15 — Purchase invoices
Table prefix: `FTXih` (not `FTPi`). Document prefixes: `PR` = Purchase Receipt, `PS` = Purchase Summary/Special.
Primary supplier: `AP-000019` (9 of 10 most recent invoices). Today's purchases unprocessed (`FTXihStaPrcDoc=NULL`) — batch processing runs end-of-day.

---

# PART 2 — FILE SYSTEM

## AdaPos4.0HpmFhn — CRITICAL FINDING
**The folder contains only two empty staging directories:**
```
AdaImportExport/    (empty)
AdaSky/
  Inbox/            (empty)
  Outbox/           (empty)
```
**No AdaPos4.0.exe exists on this server.** The POS application binary runs only on branch workstations. This server is a sync/data-export hub only. AdaSky queue is empty — no pending sync items.

## AdaPos3.0HpmFhn
Legacy placeholder. Only contains empty AdaSky/Inbox + Outbox structure. No executables.

## AdaAbreastTools
```
AdaAbreastTools.exe          1,844,736   2014-11-19
AdaAbreastTools.exe.config   2,870       2013-04-09
AdaXML.ada                   3,697       2022-01-17
C1.Common.dll                86,016      2004-03-12
C1.Win.C1FlexGrid.dll        569,344     2005-04-14
P-Pic/    TH/
```

**AdaAbreastTools.exe.config** — WCF connects to `http://localhost:8731/Design_Time_Addresses/AdaWCFCstPoint/AdaWCFCstPoint/` — development-time placeholder URL never updated. `security mode=None`.

**AdaXML.ada** (3,697 bytes, same file in 3 locations) — Encrypted AES+Base64 fields:
`W_AdaWCFCstPoint`, `W_AdaUploadNoIP`, `W_AdaWebReport`, `W_NoIPService`, `W_ComCode`, `W_AdminLogin`, `W_AdminPwd`, `W_BranchCode`, `W_PortWeb/DB/FTP`, `L_DBAccServer/Database/Login/Password`, `L_AdaWCFService`, `L_ReqPointServerIP/Port`
**ALL W_DBMember* fields are empty** — loyalty member DB not configured in this copy.

## AdaUploadPoint — full inventory
```
AdaDownloadPoint.exe         376,832    2016-08-01
AdaDownloadPoint.exe.config  4,506      2013-08-16
AdaDownloadPoint.pdb         411,136    2014-10-27  ← debug symbols present
AdaUploadPoint.exe           148,480    2016-01-22
AdaUploadPoint.exe.config    6,500      2014-10-13
AdaUploadPointCfg.xml        1,406      2013-04-09
AdaUploadPointConfig.exe     849,920    2014-02-20
AdaXML.Ada                   3,697      2022-01-17
Ionic.Zip.dll                445,440    2013-04-09
StartWindowService.bat       31
StopWindowService.bat        30
LogData/Log/  LogData/LogError/  LogData/AdaDownloadPoint/
```

**AdaUploadPoint.exe.config WCF endpoints:**
- Self-hosted: `http://localhost:8731/Design_Time_Addresses/AdaUploadPoint/AdaWCFDownload/` (wsHttpBinding)
- Cloud: `http://ada059.adasoft.adasoft.com:3000/AdaWSNoIP/AdaWCFNoIP.AdaWCFNoIP.svc`
- Local WCF: `http://ada069/AdaWCFCstPoint_5406_01/AdaWCFCstPoint.svc` ← customer-specific code `5406_01`

**AdaDownload.ada** — encrypted: `L_LastUpTime`, `L_LastUpDate`, `L_Record` (last successful upload data)
**AdaDownloadPoint.pdb** — debug symbols present. Source file paths may be readable from PDB.

---

# PART 3 — WINDOWS ENVIRONMENT

## Services
| Name | DisplayName | Status | StartType |
|---|---|---|---|
| AdaPreparePoint | AdaPreparePoint | **Stopped** | Automatic |
| AdaUploadPoint | AdaUploadPoint | **Stopped** | Automatic |

Both configured auto-start but currently stopped. AdaDownloadPoint runs as a child process of AdaUploadPoint, not a separate service.

## Scheduled tasks
Only one: `Bplus_backup` (external backup software). **No Adasoft-specific scheduled tasks.** No nightly batch, no auto-restart of services, no database backup task.

## IIS Applications (all on DefaultAppPool — single point of failure)
| App | Physical Path |
|---|---|
| AdaiPointz | C:\Inetpub\wwwroot\AdaiPointz |
| AdaWCFCstPoint | C:\Inetpub\wwwroot\AdaWCFCstPoint |
| AdaWebAbreast | C:\Inetpub\wwwroot\AdaWebAbreast |
| AdaWebReport | C:\Inetpub\wwwroot\AdaWebReport |

**AdaWebAbreast Web.config:**
- Connection string: `Data Source=ADA59\SQL2005` — **stale/wrong server name**
- `debug="true"` — **debug mode in production**
- ASP.NET MVC 2.0, .NET 3.5
- `AdaReportURL: http://192.168.0.71/Report/wMain.aspx` → **this server's LAN IP = 192.168.0.71**

**AdaiPointz Web.config:**
- Active connection: `data source=192.168.0.155;initial catalog=AdaMember40;user id=sa;password=adasoft`
- **Loyalty DB is on a SEPARATE server: 192.168.0.155, database: AdaMember40**
- Migration history: `ada85\sql2012` → `192.168.0.212\sql2012` → `192.168.0.155` (current)
- `Authentication mode=None` — no ASP.NET authentication
- Entity Framework 4.4, ASP.NET MVC 4, .NET 4.0

**AdaWCFCstPoint folder contains:**
`AdaPrepareConfig.exe`, `AdaPreparePoint.exe`, `AdaPrepareRun.exe`, plus LogData, Dll, X-Dll, StoreProcedures
- AdaPreparePoint.exe.config: connects to `http://192.168.0.74:8011/` — **branch machine on LAN**
- AdaPrepareRun.exe.config: connects to `http://localhost:1753/AdaWCFDownload.svc`

**AdaWebAbreast.rar** — 13.7MB installer backup in wwwroot

## SQL Server
One instance: `WIN-N8RL1PCFEDO\SQLEXPRESS` = SQL Server 2008 R2 (version 10.50.x)

## All databases
| Name | State | SizeMB | Created | Compat |
|---|---|---|---|---|
| **AdaAcc** | ONLINE | **4,617** | 2020-05-18 | **80** (SQL 2000 mode) |
| **AdaAcc_20260313DataFULL** | ONLINE | **9,835** | 2026-03-13 | 80 |
| **AdaAccFull20241118** | ONLINE | **9,499** | 2024-11-18 | 80 |
| master | ONLINE | 4 | 2003-04-08 | 100 |
| msdb | ONLINE | 12 | 2010-04-02 | 100 |
| tempdb | ONLINE | 2 | 2026-05-17 | 100 |

**All AdaAcc databases run at compatibility level 80 (SQL Server 2000 mode) on SQL Server 2008 R2.**
Two backup databases (19.3 GB total) are online simultaneously — wasting memory, disk, and adding attack surface.

---

# PART 4 — LOG FILE PATTERN

Error repeating every 30 seconds in all LogStep files:
```
[15/05/2026 16:17:00] LOG : Connect to Service Fail : Invalid URI:
The hostname could not be parsed. : http://:80/AdaWCFCstPoint/AdaWCFCstPoint.svc
```

Root cause: Service reads `AdaXML.ada` → decrypts hostname field → gets empty string → builds `http://:80/...` → URI parse fails. Logs `tVB_PATHConfig=C:\Program Files\Adasoft\AdaUploadPoint\AdaXML.ada` in error log.

Session durations from log dates:
- Feb 18 – Mar 5, 2026 (15 days) → 7.3 MB log
- Mar 6 – Apr 29, 2026 (54 days) → **24.9 MB log**
- Apr 29 – May 11, 2026 (12 days) → 5.7 MB log
- May 11 – May 15, 2026 (4 days) → 2.0 MB log
- May 15 – May 17, 2026 (2 days) → 0.8 MB log → service stopped

---

# NEW DISCOVERIES — SUMMARY

## 🔴 Discovery 1 — Branch 004 Buddhist Era date bug
`FDShdDocDate` for branch 004 stores year as 2569 (Thai Buddhist Era) not 2026 (Gregorian). POS at branch 004 passes raw Thai year to SQL Server without subtracting 543. 62,108 sales records indexed as April 15, **year 2569 CE** — 543 years in the future. All date-range reports comparing branches will produce incorrect results for branch 004.

## 🔴 Discovery 2 — Two 9GB backup databases online simultaneously
`AdaAcc_20260313DataFULL` (9,835 MB) and `AdaAccFull20241118` (9,499 MB) both attached, online, and accessible. Same `sa/adasoft` credentials. Same injectable stored procedures. Total unnecessary attack surface + disk/memory waste: 19.3 GB.

## 🔴 Discovery 3 — Loyalty database is on a DIFFERENT server
`AdaiPointz` connects to `192.168.0.155`, database `AdaMember40`, `sa/adasoft`. This is NOT this machine. The AdaCustomer.edmx and AdaAcc do not contain the live loyalty data — it is on a separate server that has not been investigated.

## 🟡 Discovery 4 — LAN architecture confirmed (4+ nodes)
| IP/Hostname | Role |
|---|---|
| `192.168.0.71` | This server — central DB + IIS |
| `192.168.0.74` | Branch machine — AdaWCFDownload on port 8011 |
| `192.168.0.155` | Separate server — AdaMember40 loyalty DB |
| `ada059.adasoft.adasoft.com:3000` | Adasoft cloud No-IP service |
| `ada069` | Local hostname — runs AdaWCFCstPoint_5406_01 (may = 192.168.0.71) |

## 🟡 Discovery 5 — Business name confirmed
`เอสซีกรุ๊ป(1989)` = **SC Group (1989)** — from Tax Invoice template in TSysConfig.

## 🟡 Discovery 6 — Customer installation code
`5406_01` in `AdaWCFCstPoint_5406_01` is SC Group's unique Adasoft customer code.

## 🟡 Discovery 7 — Vendor backdoor account
`ADASOFT/SUPPORT` at permission level 9 — above all client accounts. Has full system access.

## 🟡 Discovery 8 — AdaWebAbreast in debug mode
`debug="true"` in production Web.config exposes full stack traces to any browser user.

## 🟡 Discovery 9 — AdaDownloadPoint.pdb present
Debug symbols file for AdaDownloadPoint.exe is present. Contains original source file paths — potentially leaks development environment information.

## 🟡 Discovery 10 — No Adasoft scheduled tasks
Zero scheduled tasks for service restart, sync, backup, or month-end processing. The escalating adjustment volume is entirely manual — no automation exists.

## 🟢 Discovery 11 — AdaAccEmpty.mdb in wwwroot
`C:\Inetpub\wwwroot\AdaWebAbreast\bin\DB\AdaAccEmpty.mdb` — 22.6 MB Access database template for export/offline use. Schema visible without special tools.

---

# REMAINING UNKNOWNS

| Unknown | How to answer |
|---|---|
| What is `ada069`? | Check hosts file: `C:\Windows\System32\drivers\etc\hosts` |
| Is `192.168.0.155` online? | Ping + SQL connect from this machine |
| What triggered periodic service restarts? | Check Windows Event Viewer for service start events |
| Why is `AdaXML.ada` hostname empty? | Need source code or AdaUploadPointConfig.exe UI |
| 59 stored procedure definitions unread | Use `sp_helptext` per procedure |
| What triggers Type 7 processing flip? | Read `STP_PRCxUpdQtyNow` and `STP_PRCxSTK_MonthEnd` |
| AdaMember40 schema on 192.168.0.155 | Requires access to that server |
| AdaAccEmpty.mdb schema | Open with Access or mdb viewer |
| Branch workstation configuration | Need access to a cashier terminal |
| `Bplus_backup` task scope and schedule | Read task XML: `schtasks /query /tn Bplus_backup /xml` |

---

# UPDATED UNDERSTANDING ESTIMATES

| Layer | Before S9 | After S9 |
|---|---|---|
| Database structure (AdaAcc) | ~75% | **~92%** |
| Transfer gap / data integrity | ~95% | **~97%** — gap resolved, branch breakdown complete |
| Config & deployment | ~70% | **~88%** — LAN map confirmed, IIS fully mapped |
| Executable business logic | ~35% | **~40%** — AdaPos4.0.exe confirmed NOT on server |
| Loyalty system | ~60% | **~55%** ⬇️ — realised loyalty DB is on 192.168.0.155, not here |
| Windows environment | ~20% | **~80%** — services, tasks, IIS, DBs all mapped |
| **Overall system** | **~65%** | **~78%** |

## Expedition ceiling status
| Target | Realistic max | Current | Gap |
|---|---|---|---|
| Database structure | 95% | 92% | 3% — a few more column maps |
| Transfer gap | 95% | 97% | ✅ Exceeded |
| Config & deployment | 90% | 88% | 2% — hosts file + 192.168.0.155 |
| Executable logic | 65% | 40% | 25% — AdaPos4.0.exe is on workstations only |
| Overall | 75–80% | **78%** | At ceiling |
