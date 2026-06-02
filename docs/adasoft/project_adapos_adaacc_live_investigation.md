---
name: AdaAcc Live Database — Full Investigation Report
description: Read-only investigation of AdaAcc on SERVER\SQLEXPRESS (WIN-N8RL1PCFEDO\SQLEXPRESS, SQL Server 2008 R2 RTM). 435 tables, 76 views, 65 stored procedures confirmed. Transfer system exists with 6,737 real documents. POS extremely active (429k sales). Loyalty system effectively unused (33 point rows). Full transfer procedure logic decoded.
type: project
originSessionId: external-audit-6
---

## Instance
- Server: `SERVER\SQLEXPRESS` = `WIN-N8RL1PCFEDO\SQLEXPRESS`
- Version: SQL Server 2008 R2 RTM
- Note: `ADA47\SQL2008` mentioned in earlier configs is unreachable — different machine
- Database: `AdaAcc`

---

## Scale confirmed
| Object | Count |
|---|---|
| Tables | 435 |
| Views | 76 |
| Stored Procedures | 65 |
| Functions | (not recorded) |

---

## Table prefix map — full business scope
| Prefix | ~Count | Business domain |
|---|---|---|
| `TACT*` | ~60 | Accounting: Purchase Invoice (Pi), Sales Invoice (Si), VAT, Cash/Bank |
| `TCNM*` | ~50 | Master data: Branch, Company, Customer, Product, Supplier, Warehouse, Zone |
| `TCNT*` | ~80 | Transactions: Transfer, Point, Gift, Check, Order, Stock, Barcode |
| `TPST*` | ~40 | POS: Sales HD/DT/RC, Coupon, Login, LogSum, Hold, Shift, Void |
| `TRPT*` | ~20 | Report templates and summary data |
| `TSYS*` | ~30 | System: Config, User, Menu, Log, SQL, Backup, Version |
| `TGL*` | ~10 | General Ledger: Chart of Accounts, Journal, Budget, Period |
| `TFFM/TFFT*` | ~10 | Food & Beverage: Kitchen, Flavor, Order queue |
| `TTK*` | ~8 | Ticketing: Zone, Booking, Print |
| `TDFT*` | ~8 | Deferred/buffer staging tables |
| `TTmp*` | ~15 | Temporary processing tables |
| `Tmp_Chk*` | ~5 | Per-machine temp check tables (SERVER, DESKTOP-AE76TEI, DESKTOP-HLE0KNM, SL001) |

---

## Row counts — confirmed
| Table | Rows | Meaning |
|---|---|---|
| `TPSTSalHD` | 429,054 | POS sales headers — **very active** |
| `TPSTSalDT` | 836,892 | POS sales detail lines |
| `TCNTPdtTnfHD` | 6,737 | Inter-branch transfer headers — **real live data** |
| `TCNTPdtTnfDT` | 71,153 | Transfer detail lines |
| `TACTPiHD` | 7,224 | Purchase invoices received |
| `TCNMPdt` | 6,663 | Products in catalog |
| `TCNMCst` | 1,305 | Customer master records |
| `TCNMBranch` | 6 | 6 branches |
| `TCNTCstPoint` | 33 | Loyalty point transactions — **effectively unused** |
| `TCNTCstGiftHD` | 0 | Zero gift redemptions ever |
| `TCNTCstGiftDT` | 0 | Zero gift redemption lines |
| `TCNTPointQueue` | — | **Table does not exist** — setup script never deployed |

---

## Branch list
| FTBchCode | FTBchName | FTBchHQ | FTBchWheStk |
|---|---|---|---|
| 000 | สำนักงานใหญ่ (HQ) | 1 | 001 |
| 001 | สาขาที่ 1 | 2 | 00001 |
| 002 | สาขาที่ 2 | 2 | 00002 |
| 003 | สาขาที่ 3 | **NULL** | 00003 |
| 004 | สาขาที่ 4 | 2 | 00004 |
| 005 | สาขาที่ 5 | 2 | 00005 |

Branch 003 has NULL `FTBchHQ` — possibly inactive or misconfigured.

---

## CardType distribution — point ledger decoded
| FTPntCardType | RecCount | TotalPoints | EarliestDate | LatestDate |
|---|---|---|---|---|
| 1 | 5 | 2,521 | 2020-08-26 | 2023-07-30 |
| 2 | 5 | 3,024 | 2023-07-30 | 2023-07-30 |
| 3 | 0 | — | — | — |
| **6** | **23** | **0** | **2020-06-30** | **2026-03-31** |

**CardType 6 — new discovery:** Not in original 3-type model. 23 rows, all 0 points. Reference document format `AR000-000009-20260331214447` = Accounts Receivable document, not a sale. Likely a loyalty event tied to AR transactions. Definition unknown — not in any file read so far.

**CardType 3 has zero rows** — month-end checkpoint process has never been run on this database. `V_AllPointAmt` view therefore scans all transactions back to 1900-01-01 (its fallback).

**Last actual point-earning transaction (Type 1):** 2023-07-30 — nearly 3 years ago. Last loyalty record of any kind: 2026-03-31 (Type 6, 0 points). Loyalty system is functionally dead.

---

## Inter-branch transfer system — FULLY DECODED

### Transfer document types (from STP_DOCxTCNTPdtTnfDT4 comments)
| FTPthDocType | Thai | English |
|---|---|---|
| '1' | รับเข้าสินค้า | Product In — receive into warehouse |
| '2' | เบิกออกสินค้า | Product Out — issue from warehouse |
| '3' | โอนสินค้าระหว่างคลัง | Transfer between warehouses (same branch) |
| '4' | โอนสินค้าระหว่างสาขา | Transfer between branches |
| '7' | รับโอนสินค้าระหว่างสาขา | Receive transfer between branches |
| '8' | จ่ายโอนสินค้าระหว่างสาขา | Dispatch transfer between branches |
| '17' | ใบจัด (Call center) | Call center dispatch |

### How transfer processing works (confirmed from stored procedure code)
**`STP_DOCxTCNTPdtTnfDT1`** — Type 1 (Product In):
- Reads `TCNTPdtTnfDT` where `FTPthDocType='1'`
- Inserts into `TCNTmpPrcStkCard` with `FTStkType='1'` (stock increase), warehouse = `FTPthWhTo`
- Formula: `FCStkSetPrice = NET - DiscAvg - FootAvg - RePackAvg` per line

**`STP_DOCxTCNTPdtTnfDT2`** — Type 2 (Product Out):
- Inserts into `TCNTmpPrcStkCard` with `FTStkType='2'` (stock decrease), warehouse = `FTPthWhFrm`

**`STP_DOCxTCNTPdtTnfDT3`** — Type 3 (Warehouse-to-warehouse):
- Creates **two** entries atomically: `FTStkType='2'` (out from `FTPthWhFrm`) + `FTStkType='1'` (in to `FTPthWhTo`)
- Only type with both legs in one call

**`STP_DOCxTCNTPdtTnfDT4`** — Type 4/7/8/17 (inter-branch):
- Detects which branch is running it (`@ptBchCode`), then:
  - If sending branch (`FTPthBchFrm`): records stock OUT
  - If receiving branch (`FTPthBchTo`): records stock IN
  - If HQ and neither branch: records HQ view
- **Each branch runs this procedure independently on their own DB copy**
- Sending branch approves outbound → their DB updated
- Receiving branch approves inbound → their DB updated
- **No atomic cross-branch transaction. No mechanism to verify both halves match.**
- **No CHECK, no cross-reference, no status flag confirming receiving branch confirmed receipt.**

### ⚠️ Critical architectural gap confirmed
The two halves of every inter-branch transfer are recorded **separately on different machines**. There is no reconciliation layer. This is the root cause of the fake-transaction pattern described in the original audit question.

---

## Gift/redemption processing — confirmed
`STP_DOCxTCNTCstGiftDT`:
- Removes physical stock from `AdaAcc` directly (`FTStkType='2'`, stock decrease)
- Cost recorded as 0 (gifts dispensed at zero cost to stock card)
- Serial numbers tracked in `TCNTCstGiftSN` → `TCNTmpPrcSrnCard` with status 31, qty -1
- Stock document type 22 = "แลกสินค้า" (Gift Point Changing)
- Has `BEGIN TRY / BEGIN CATCH` — errors logged to `TSysPrcLog`
- **Gift redemption and POS sales are in the same AdaAcc database — not a separate loyalty DB**

---

## New tables confirmed to exist (not in EDMX)
### Inter-branch transfer
`TCNTPdtTnfHD` (6,737), `TCNTPdtTnfDT` (71,153), `TCNTPdtTnfSN`, `TCNTOrderTnfHD/DT`, `TCNTTmpPdtTnfHD/DT`

### Stock adjustment
`TCNTPdtAjcHD/DT` (cost adjust), `TCNTPdtAjpHD/DT` (price adjust), `TCNTPdtAjsHD/DT` (stock adjust), `TCNTPdtAjuHD/DT` (unknown type)

### Stock checking / physical count
`TCNTPdtChkHD/DT/SN`, `TCNTPdtChkSalHD/DT/SN`, `TCNTPdtRcvChkHD/DT/SN`

### POS sales (confirmed active)
`TPSTSalHD` (429,054), `TPSTSalDT` (836,892), `TPSTSalRC`, `TPSTSalHD_B/DT_B/RC_B` (backup copies), `TPSTCoupon`, `TPSTCpnType`

### General Ledger (full accounting module)
`TGLMChtAcc`, `TGLMBook`, `TGLMPeriod`, `TGLMBudget`, `TGLTJNHd/DT`, `TGLTAccHist`

### Food & Beverage module
`TFFMKitchen`, `TFFMFlavor`, `TFFMKitPos`, `TFFTOrderHD/DT`

### Ticketing module
`TTKMTicket`, `TTKMZone`, `TTKTBooking`, `TTKTSalPkg`

### Active machine temp tables (confirms multi-terminal usage)
`Tmp_ChkDTSERVER`, `Tmp_ChkDTDESKTOP-AE76TEI`, `Tmp_ChkDTDESKTOP-HLE0KNM`, `Tmp_ChkDTSL001`

---

## Key views
| View | Purpose |
|---|---|
| `VCN_TCNTMoveMent_DF` | All stock movement documents |
| `VCN_TCNTPdtBalance_DF` | Current product stock balance |
| `VCN_TCNTPdtInventory_DF` | Inventory view |
| `VCN_TCNTPdtStkCard_Std` | Stock card running balance per product |
| `VCN_TCNTSaleHD/SaleDT` | Sales header/detail |
| `VCN_TCNTPurChaseHD/DT` | Purchase header/detail |
| `VShwDT_TCNTPdtTnfDT` | Transfer detail display view |
| `VCN_TCNMPdtCstPointAmt` | Product point amount — point-per-product config |

---

## Stored procedures — 65 total, grouped
| Prefix | Count | Purpose |
|---|---|---|
| `STP_CN_*` | 5 | Generic browse + document numbering |
| `STP_DOCx*` | 38 | Document processing — write to `TCNTmpPrcStkCard` staging |
| `STP_PRCx*` | 13 | Post-processing — stock approval, month-end, qty recalc |
| `STP_MSGx*` | 2 | Error/process logging |
| `STP_SYNx*` | 1 | Sync log recording |
| `STP_SYSn*` | 1 | Database backup |
| `STP_BACKUPDB` | 1 | Legacy backup |
| `SP_ReIndex` | 1 | Index rebuild (uses cursor) |
| `STP_CRExView*` | 1 | View creation utility |

---

## Security and quality findings (live database)
| Issue | Severity | Detail |
|---|---|---|
| SQL Injection in 3 browse procedures | CRITICAL | `STP_CN_GetBrowseMaster`, `STP_CN_GetBrowseHD`, `STP_CN_GetBrowseDT` — all three deployed in live DB, all use `EXEC()` with concatenated parameters |
| SQL Injection in backup procedures | HIGH | `STP_BACKUPDB`, `STP_SYSnBackupDB` — dynamic SQL via `EXEC @tstr` |
| No transactions in transfer procedures | HIGH | `STP_DOCxTCNTPdtTnfDT1-4` write to staging inside `TRY/CATCH` but no `BEGIN TRAN` — partial writes possible on failure |
| Duplicate-approval check commented out | HIGH | All 4 transfer procedures: FK check `FTPthStaPrcDoc='1'` removed (note: "RQ1401-002 56-09-01 — checking on application side"). DB will not catch double-processing. |
| SP_ReIndex uses CURSOR on 435 tables | MEDIUM | Blocking operation on 5+ GB DB with 835k+ rows. No scheduling metadata visible. |
| SQL Server 2008 R2 RTM (unpatched) | HIGH | EOL, no patches since 2019 |

---

## Branch code anomaly — resolved
Only `'000'` (length 3) exists in `TCNTCstPoint.FTBchCode`. The varchar(6) column width in the EDMX was overly generous — not a live data issue.

---

## What is still unknown
| Question | How to answer |
|---|---|
| Transfer type distribution (how many Type 4 inter-branch vs internal?) | `SELECT FTPthDocType, COUNT(*) FROM TCNTPdtTnfHD GROUP BY FTPthDocType` |
| Receiving branch confirmation rate (how many transfers are unconfirmed?) | `SELECT FTPthStaDoc, COUNT(*) FROM TCNTPdtTnfHD GROUP BY FTPthStaDoc` |
| Actual point calculation rate | Read the 5 type-1 rows in `TCNTCstPoint` for `FCPntPointbyOne` values |
| Stock card currency | Row count + date range of `TCNTPdtStkCard` / `TCNTPdtStkCardBch` |
| CardType 6 definition | Read application DLL or AdaWebAbreast source |
| Who are DESKTOP-AE76TEI, DESKTOP-HLE0KNM, SL001? | Check machine names against branch list |

---

## Updated understanding estimates
| Layer | Before | After |
|---|---|---|
| iPointz loyalty layer (schema) | ~85% | ~85% |
| iPointz business logic | ~25% | ~30% (CardType 6 still unknown) |
| AdaAcc POS/inventory layer (schema) | ~20% | **~75%** — 435 tables mapped, transfer procedures decoded |
| AdaAcc business logic (procs) | ~10% | **~55%** — 38 DOC procedures + transfer logic confirmed |
| Overall system | ~40% | **~65%** |
