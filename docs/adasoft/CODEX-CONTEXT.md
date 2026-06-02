# AdaSoft System — Complete Reverse-Engineering Context

This folder contains the complete findings from a multi-session read-only investigation of
SC Group's Adasoft AdaPos HyperMart 4.0 POS/ERP system. Use these documents as authoritative
reference when building SC-StockDay-Ordering or any system that integrates with AdaAcc.

**All findings are based on direct database queries, file system scans, binary string extraction,
and .NET reflection — not guesswork.**

---

## What this project is

SC Group (1989) is a Thai pharmacy/retail chain running 6 branches. Their POS/ERP system is
Adasoft AdaPos HyperMart 4.0. We are building SC-StockDay-Ordering on top of it — a
Node.js/React/PostgreSQL system that adds inter-branch transfer reconciliation, stock day
ordering, and loyalty CRM without replacing AdaPos.

---

## Final confirmed facts (added last — highest confidence)

| Question | Answer |
|---|---|
| Receipt printer | **Epson TM-T82X**, USB to POSSRV (TMUSB001), Windows driver — not network/ESC-POS |
| What is 192.168.0.71? | **Does not exist** — no ARP, no DNS, no route. Was decommissioned or never real |
| Central server location | **Remote over WAN** — traceroute exits via 125.24.216.85 (TOT/CAT Thailand internet). Not on branch LAN |
| Alipay active? | **Never used** — 0 transaction rows. TSysMsgAlipay 75 rows = pre-loaded error templates only |
| MOL active? | **Never used** — 0 rows |

**Implication for adapos-sync:** The central SQL Server (192.168.100.124) is internet-hosted, not on-premises. Your Render.com backend can connect to it directly the same way a branch workstation does — no VPN needed.

---

## Read this first — architecture in 60 seconds

**Offline-first.** Each branch has its own local SQL Server (`POSSRV\SQLEXPRESS`) running a
copy of AdaAcc. There is NO live connection between branches and the central server.

**Manual FTP sync.** Data moves via zip files uploaded by AdaSky.exe to an external FTP server
at `ftp://147.50.231.154` (CSLoxinfo hosted IDC, Thailand). Staff trigger this manually —
no automation exists anywhere.

**Central server** at `192.168.100.124` (WIN-N8RL1PCFEDO\SQLEXPRESS) holds the aggregated
AdaAcc with all branches combined. This is what adapos-sync reads from — read-only.

**Two executables per branch:**
- `AdaPosBack.exe` — back-office management (48MB VB6)
- `AdaPosFront.exe` — cashier frontend (13MB VB6)

**Connection strings** are stored in `AdaTools\AdaIni.ada` — a Jet/Access binary database,
NOT a text INI file. This is why no connection string appears in any config file or registry.

---

## Document index — what to read for each task

| Task | Read this file |
|---|---|
| Understanding the database schema | `project_adapos_adaacc_live_investigation.md` |
| Transfer reconciliation gap | `project_adapos_query_investigation.md` |
| Building SC-StockDay | `project_scstockday_transfer_design.md` |
| Loyalty/CRM system | `project_adapos_storedproc_analysis.md` + `project_adapos_central_server_session11.md` |
| Table column DDL (TPSTSal*, TCNMPdt, TCNMCst) | `project_adapos_session10_sql_adasmart.md` |
| Sync mechanism / FTP | `project_adapos_nb005_final_scan.md` |
| Security issues | `project_adapos_audit.md` + `project_adapos_nb005_final_scan.md` |
| Branch workstation setup | `project_adapos_branch005_workstation.md` |
| Printer / peripheral integration | `project_adapos_nb005_final_scan.md` |
| AdaSmart / AdaTools / AdaMonitor | `project_adapos_session10_sql_adasmart.md` + `project_adapos_nb005_final_scan.md` |
| Central server full findings | `project_adapos_central_server_session11.md` |
| Overall memory index | `MEMORY.md` |

---

## Critical facts — copy these into any prompt

```
DATABASE: AdaAcc on WIN-N8RL1PCFEDO\SQLEXPRESS (192.168.100.124)
SQL VERSION: SQL Server 2008 R2 RTM (10.50.1600.1) — EOL, unpatched
SCALE: 435 tables, 76 views, 65 stored procedures
POS SALES: 429,054 headers (TPSTSalHD), 836,892 lines (TPSTSalDT)
PRODUCTS: 6,663 (TCNMPdt — 240 columns, 5 costing methods, 9 price levels)
CUSTOMERS: ~1,305 (TCNMCst — 113 columns, PIN stored in PLAIN TEXT)
BRANCHES: 6 (000=HQ, 001-005)
TRANSFERS: 6,737 docs (TCNTPdtTnfHD); 2,835/3,091 inbound NEVER PROCESSED (91.7%)
STOCK ADJUSTMENTS: 1,632 manual patches (TCNTPdtAjsHD) — staff fixing phantom stock
LOYALTY: 33 rows total, dead since Nov 2020 (TCNTCstPoint)
GL MODULE: 2003 demo skeleton — never used in production (TGLTJNHd = 3 rows)
F&B MODULE: 0 rows across all branches — never configured
TICKETING: 0 rows across all branches — never configured
PURCHASE INVOICES: 7,254 at central (TACTPiHD) — used at branches 000/001
```

---

## The single most important finding

> **2,835 of 3,091 inbound transfer receipts (91.7%) were never processed into stock.**
> The `FCPthQtyRcv` field does not exist — the system cannot record received ≠ dispatched.
> 1,632 manual stock adjustments confirm staff have been patching phantom inventory by hand.
> This is an architectural gap, not a configuration problem. SC-StockDay exists to fix this.

---

## What adapos-sync does (read-only boundary)

adapos-sync connects to AdaAcc at the central server (192.168.100.124) as a read-only consumer.
It NEVER writes to AdaAcc. It reads:
- `TCNTPdtTnfHD/DT` — transfer documents
- `TPSTSalHD/DT` — sales transactions
- `TCNMPdt` — product master
- `TCNMBranch` — branch list
- `TCNMWaHouse` — warehouse list
- `TCNTPdtStkCard` — stock card movements

**Read-only is the law.** Never write to AdaAcc from any SC-StockDay component.

---

## Security issues (do not expose in production code)

- SQL injection in `STP_CN_GetBrowseMaster`, `STP_CN_GetBrowseHD`, `STP_CN_GetBrowseDT`
- `sa`/`adasoft` credentials in plaintext across all branch config files (`AdaPurge.ini`)
- `xp_cmdshell` permanently enabled by AdaPrnSrv/AdaTools at startup
- Customer PINs stored in plaintext (`TCNMCst.FTCstPin`)
- SQL Server 2008 R2 RTM — end of life, no patches since 2019
- FTP credentials in `AdaSky\Sky.mdb` (password: `mysky` to open the Access file)
- Three remote access tools (AnyDesk, RustDesk, TeamViewer) on back-office laptops

---

## Transfer document types

| Type | Thai | Meaning |
|---|---|---|
| 4 | โอนสินค้าระหว่างสาขา | Inter-branch outbound dispatch |
| 7 | รับโอนสินค้าระหว่างสาขา | Inter-branch inbound receipt |
| 1 | รับเข้าสินค้า | Product in (warehouse receive) |
| 2 | เบิกออกสินค้า | Product out (warehouse issue) |
| 3 | โอนสินค้าระหว่างคลัง | Warehouse-to-warehouse (same branch) |

Processing status: `FTPthStaPrcDoc = '1'` means processed. Empty string = unprocessed.
Document approval: `FTPthStaDoc = '1'` — all documents are approved, this field is useless as filter.

---

## Stock card movement types (FTStkType)

| Value | Meaning |
|---|---|
| '1' | Stock increase (in) |
| '2' | Stock decrease (out) |

Written to `TCNTmpPrcStkCard` staging → then approved into `TCNTPdtStkCard`.

---

## Loyalty point system (CardType)

| CardType | Meaning | Effect |
|---|---|---|
| '1' | Points earned (sale) | +FNPntPoint |
| '2' | Points redeemed | −FNPntPoint |
| '3' | Month-end checkpoint | +FNPntPoint (carry-forward) |

Formula: 1 point per 100 baht (`FCPntPointbyOne = 100`)
Balance view: `V_AllPointAmt` — sums from last CardType='3' checkpoint date.
System dead since November 2020. WCF sync broken since March 2026.

---

## Key stored procedures

| Procedure | What it does |
|---|---|
| `STP_DOCxTCNTPdtTnfDT4` | Process inter-branch transfer (Types 4/7/8) |
| `STP_PRCxUpdQtyNow` | Recalculate `FCPdtQtyNow` in product master |
| `STP_PRCxSTK_MonthEnd` | Month-end stock closing |
| `STP_SYNxAddLogChange` | Log sync change |
| `STP_CN_GetBrowseMaster` | ⚠️ SQL INJECTION — dynamic browse |

---

## FTP sync architecture

```
Branch POSSRV\SQLEXPRESS (local AdaAcc)
    ↓ AdaImportExport.exe → XML/CSV export
    ↓ AdaSky.exe → zip → Ada{SrcBranch}-{DstBranch}-{YYMMDD}-{HHMMSS}.zip
    ↓ FTP upload to ftp://147.50.231.154 (CSLoxinfo, Thailand)
    ↓ Central server picks up and imports
Central WIN-N8RL1PCFEDO\SQLEXPRESS (AdaAcc — all branches aggregated)
    ↓ adapos-sync reads this READ-ONLY
SC-StockDay PostgreSQL database
```

Sync lag: branches may be 1–8+ days behind central. Label all data with sync timestamp.
