---
name: session-10-sql-deep-dive-and-adasmart
description: "Session 10 combined report: core table DDL (TPSTSal*, TCNMPdt 240 cols, TCNMCst 113 cols), GL module confirmed as 2003 demo skeleton never used, F&B and Ticketing = 0 rows never configured, AdaSmart revealed as management approval + month-end tool (NOT BI dashboard), plaintext PIN in TCNMCst.FTCstPin, lot/expiry tracking in sales lines, VAT invoice table active (506 rows May 2026), 1288 customers with Branch 001 dominant. Run against POSSRV\\SQLEXPRESS (Branch 005 local DB), not central server."
metadata: 
  node_type: memory
  type: project
  originSessionId: 4eb79e91-534f-4357-83ab-417e0a3131b1
---

## Important context
All SQL in this session ran against **POSSRV\SQLEXPRESS (192.168.0.127)** — Branch 005 local database.
Central server (192.168.0.71) was unreachable from NB-005-01.
DDL (column structure) is identical to central — same schema. Row counts and data reflect Branch 005 only.

---

## Section 1 — Core Table DDL

### TPSTSalDT — Sales Detail (89 columns, key fields)
| Column | Type | Meaning |
|---|---|---|
| `FTBchCode` / `FTShdDocNo` | varchar 3/20 | Branch + document PK |
| `FNSdtSeqNo` | bigint | Line sequence |
| `FTPdtCode` / `FTPdtName` | varchar 20/100 | Product code + name |
| `FTSdtBarCode` | varchar 25 | Scanned barcode |
| `FCSdtQty` / `FCSdtSalePrice` | float | Quantity + unit price |
| `FCSdtDis` / `FCSdtChg` | float | Discount / surcharge |
| `FCSdtNet` / `FCSdtVat` | float | Net + VAT amount |
| `FCSdtCostIn` / `FCSdtCostEx` | float | Cost (inc/exc VAT) |
| **`FTSdtLotNo`** / **`FDSdtExpired`** | varchar / datetime | **Lot number + expiry date — batch tracking built in** |
| `FTPszCode` / `FTClrCode` | varchar 5 | Size + colour (fashion/garment variants) |
| `FCSdtQtySale` / `FCSdtQtyRet` | float | Qty sold vs. returned |
| `FTSdtStaPrcStk` / `FTSdtStaPrcStkCrd` | varchar 1 | Stock processed flags |

### TPSTSalHD — Sales Header (key fields)
| Column | Meaning |
|---|---|
| `FTPosCode` | POS terminal ID (varchar 3) |
| `FTUsrCode` / `FTSplCode` / `FTCstCode` | User / salesperson / customer |
| `FCShdMnyCsh/Chq/Crd/Ctf/Cpn/Cls/Cxx` | 7 tender types: cash, cheque, card, gift cert, coupon, closure, other |
| `FCShdGndCN/DN/AE/TH` | CN / DN / advance / deposit amounts |
| `FTShdStaPaid/Refund/StaDoc/StaPrcDoc/StaPrcGL` | Status flags: paid, refund, doc status, stock processed, **GL posted** |
| `FTShdCstName` / `FTShdCstAddr` | Customer name/address snapshot at time of sale |
| `FNShdDocPrint` | Print count (receipt reprint tracker) |
| `FTXbhDocNo` / `FTXphDocNo` | Cross-reference to purchase/delivery docs |
| `FTLogCode` | POS session/shift log reference |

### TPSTSalRC — Sales Receipt (payment breakdown per doc)
| Column | Meaning |
|---|---|
| `FTRcvCode` / `FTRcvName` | Tender type code + name |
| `FTBnkCode` / `FTBnkName` / `FTSrcBnkBch` | Bank + branch for cheque/transfer |
| `FCSrcFAmt` / `FCSrcAmt` / `FCSrcNet` | Face / received / net amounts |
| `FCSrcCardChg` | Card surcharge |
| `FCSrcRetAmt` / `FCSrcRetDocRef` | Return amount + reference |
| `FTRteCode` / `FCSrcRteFac` | Exchange rate (foreign currency support) |

### TCNMPdt — Product Master (240 columns — highlights)
| Column | Meaning |
|---|---|
| `FCPdtQtyNow` | **Denormalized current on-hand qty** (updated by STP_PRCxUpdQtyNow) |
| `FCPdtMin` / `FCPdtMax` | Reorder min/max qty |
| `FCPdtCostAvg/FiFo/Last/Def/Std` | **5 costing methods** all stored simultaneously |
| `FTPdtSUnit/MUnit/LUnit` | S/M/L unit codes (fashion sizing) |
| `FCPdtRetPriS1–S3/M1–M3/L1–L3` | **9 retail price levels** per size |
| `FCPdtWhsPriS1–L5` | **15 wholesale price levels** |
| `FTPdtPoint` / `FCPdtPointTime` | Loyalty points earned flag + multiplier per product |
| `FDPdtSaleStart/Stop` | Product sale period dates |
| `FTPdtOrdSun–Sat` | Supplier delivery day flags |
| `FCPdtLeadTime` / `FDPdtOrdStart/Stop` | Lead time + ordering window |
| `FTPdtStaSet` | Is a product bundle/set |
| `FTPdtNoDis` | Discount not allowed flag |
| `FTPdtPic` / `FTPdtSound` | Image + sound file paths |

### TCNMBranch — Branch Master (key fields)
| Column | Meaning |
|---|---|
| `FTCvrVersion` | Software version installed at each branch |
| `FTBchRegNo` | Tax registration number per branch |
| `FTBchPriority` | Branch priority ordering |

### TCNMCst — Customer Master (113 columns — highlights)
| Column | Meaning |
|---|---|
| `FTCstTaxNo` | Tax ID |
| `FTCstCrdNo` / `FDCstCrdIssue/Expire` | Membership card number + validity |
| `FDCstDob` | Date of birth |
| `FCCstWhsAmt` / `FCCstRetAmt` | Lifetime wholesale / retail purchase amounts |
| `FCCstDailyAmt/Point` | Daily accumulation trackers |
| `FNCstMemberID` | Numeric member ID (bigint) |
| **`FTCstPin`** | **⚠️ Customer PIN — stored in PLAIN TEXT** |
| `FCCstAmtLeft` | Outstanding credit balance |

### TCNMWaHouse — Warehouse Master (actual table name, not TCNMWhs)
| Code | Name | Type |
|---|---|---|
| 00001–00005 | Branch Warehouses 1–5 | 3 (branch stock) |
| 001/002 | Retail / Wholesale | 1 (original demo) |
| 003/004/005 | Damaged / Exchange / Gift | 1 (special) |

### Stock Card Tables — identical schema across 3 tables
`TCNTPdtStkCard`, `TCNTPdtStkCardBch`, `TCNTmpPrcStkCard` all share:
`FTBchCode`, `FTWahCode`, `FDStkDate`, `FTStkDocNo`, `FTPdtStkCode`, `FTStkType`, `FCStkQty`, `FCStkSetPrice`, `FCStkCostIn/Ex`, `FCStkVatable`, `FTStkStaSent`

### TACTPiHD / TACTPiDT — Purchase Invoice
Column structure mirrors Sales exactly (`FTXih*` prefix = purchase header, `FTXid*` = purchase detail).
**Row count: 0** — purchasing is managed via stock transfers, not formal AP invoices.

---

## Section 2 — Accounting / GL Module — CONFIRMED DEMO SKELETON

| Table | Rows |
|---|---|
| TGLMChtAcc | 154 (chart of accounts seeded) |
| TGLMBook | 4 (GV/JV/PV/RV books defined) |
| TGLMPeriod | 6 (all year 2003 only) |
| TGLMBudget | 60 (mostly zero) |
| TGLTJNHd | **3** (three journal entries) |
| TGLTJNDt | **6** (six journal lines) |
| TGLTAccHist | 154 (seeded) |

**All 3 journal entries dated April 21, 2003** — the original Adasoft demo/setup date.
No accounting periods exist after 2003. No live transactions ever posted.

**`FTShdStaPrcGL` exists on every sale but is never set** — a GL integration hook was designed into the schema but was never activated or connected. Sales do not auto-post to the general ledger.

The chart of accounts is a standard Thai accounting template: Assets → Liabilities → Equity → Revenue → Expense, with Bangkok Bank, Kasikorn, SCB account names. Bilingual Thai/English.

**Implication for SC Group:** All financial reporting comes from raw POS tables (`TPSTSalHD`, `TACTVatHD`). No double-entry bookkeeping is happening inside AdaPos. The accountant is working from exports or manual reconciliation, not from the GL module.

---

## Section 3 — F&B / Kitchen Module

**All 5 tables: 0 rows.** `TFFMKitchen`, `TFFMFlavor`, `TFFMKitPos`, `TFFTOrderHD`, `TFFTOrderDT` — all empty.
AdaKDS.exe is installed on POSSRV but the database side is a blank slate. Module never configured.

Note: this is Branch 005 local DB only. Other branches may have F&B data on the central server — not yet verified.

---

## Section 4 — Ticketing Module

**All 4 tables: 0 rows.** `TTKMTicket`, `TTKMZone`, `TTKTBooking`, `TTKTSalPkg` — all empty.
Ticketing never configured at Branch 005. Central server not yet checked.

---

## AdaSmart — TRUE NATURE REVEALED

**AdaSmart is NOT a BI dashboard. It is the management approval and stock closing tool.**

- File: `D:\AdaSoft\AdaPos4.0HpmFhn\AdaSmart\AdaSmart.exe`
- Size: 50.6 MB | Version: **4.6006.0024** | Compiled: January 29, 2020
- **Never run on NB-005-01** (no registry keys) — likely run on POSSRV or a dedicated management terminal

### Features confirmed from form names
| Form | Feature |
|---|---|
| `wCNBchPdtTnf` | Inter-branch product transfer |
| `wCNBrwDoc/Mst/Pdt` | Document / master / product browsers |
| `wCNPdtMergeStkChk` | Product stock merge/check |
| `wCNPdtTIn/Tnf/TOut` | Product transfer in / transfer / out |
| `wCNPrcAjpOrAjs` | Price adjustment |
| **`wCNPrcMonthEnd`** | **Month-end stock closing process** |
| `wCNAutoPickList` | Auto pick list generation |
| `wCNChkApprove` / `wCNChkPdtDocApv` | **Document approval / product doc approval** |
| `wCNChkPoGen` | PO generation check |
| `wCNCstGrpPricing` / `wCNCstPriGrp` | Customer group pricing |
| `wCNCsmRet/Sale/SCN/SDN` | Customer consignment / CN / DN |
| `wCNBarCreate/Print` | Barcode create + print |
| `wCNBankTrn` | Bank transfer |

Crystal Reports viewer embedded (`CrystalActiveXReportViewer`). Bilingual Thai/English menu ("รายงานรวม... / All Reports...").

### Stored procedures called by AdaSmart
| Procedure | When called |
|---|---|
| `STP_DOCxTPSTSalDT1/9/Day` | POS sales processing (1=sale, 9=return, Day=daily batch) |
| `STP_DOCxTACTVatDT1/5/7/9` | VAT invoice processing |
| `STP_DOCxTCNTPdtTnfDT1/2/3/4` | Transfer document processing (all types) |
| `STP_DOCxTACTCsmDT1/5/7` | Consignment processing |
| `STP_PRCxSTK_MonthEnd` / `MonthEndEx` | **Month-end stock close** |
| `STP_PRCxSTK_ReMonthEndByDoc` | Re-run month-end by document |
| `STP_PRCxUpdQtyNow` / `ByDoc` | Update FCPdtQtyNow in product master |
| `STP_PRCxPdtCostAmt` | Recalculate product cost |
| `STP_PRCxGetDocApproveDone/NotApprove` | Approval status queries |
| `STP_SYNxAddLogChange` | **Sync change logging** |

### SQL fragments embedded in AdaSmart
- Stock below minimum: joins `TCNMPdt`, `TCNTPdtStkCard`, `TCNMWaHouse`, `TCNMBranch`, compares `FCQtyBalance + order qty < FCPdtMin`
- Dynamic view creation: `CREATE VIEW [dbo].[StockInWhaBch]` / `DROP VIEW [StockInWhaBch]` — AdaSmart creates and drops temp views at runtime
- Period filter: `CONVERT(VARCHAR(10),GETDATE(),111) BETWEEN FDPrdStart AND FDPrdEnd`
- Loyalty expiry check: `WHERE FTPntExpired = 'N'`
- Customer group pricing joins

**No external config file** — connection string compiled into binary, same pattern as AdaPosBack/AdaPosFront.

---

## Bonus Findings

### TACTVatHD — VAT Invoice Register (506 rows, ACTIVE)
- Doc prefix: `S26005-xxxxxx` = sales invoices, branch 005, year 2026 (Thai BE)
- Date range: May 1–13, 2026
- Total: ฿180,486 with ฿11,807.55 VAT = **7% VAT confirmed**
- Issuing clerk: user dao1
- Branch 005 issues B2B tax invoices — active only ~6 weeks

### Customer Master Distribution (1,288 records)
| Branch | Customers |
|---|---|
| AR001 (Branch 001) | **841** — dominant |
| AR003 (Branch 003) | 294 |
| AR004 (Branch 004) | 101 |
| AR005 (Branch 005) | **7** — very new |
| S22xx (HQ/system) | ~25 |

Branch 001 holds 65% of all customers. Branch 005 has only 7 — either very new or customers not yet migrated.

### AP/AR formal document tables — all empty
`TACTPiHD` (purchase invoices), `TACTPaHD` (payment), `TACTPoHD` (PO), `TACTSoHD` (sales order), `TACTSiHD` (sales invoice) — all 0 rows. Purchasing is managed via stock transfers, not formal AP workflow. These tables are structural placeholders never activated.

### Promotions — all empty
`TCNTPmtHD/DT/CD`, `TCNTPdtPmtHD/DT` — all 0 rows. One branch-price override: product 630030140 for Branch 005 at ฿255.

### Supplier master — 268 records

---

## Key implications for SC-StockDay and SC Group operations

| Finding | Implication |
|---|---|
| **Lot tracking (FTSdtLotNo/FDSdtExpired) in sales lines** | Expiry date tracking is built into every sale — critical for pharmacy; are staff actually scanning lot numbers? |
| **GL never connected** | Accountant has zero data from AdaPos GL; manual reconciliation or separate accounting system |
| **FTShdStaPrcGL hook exists but unused** | Could theoretically activate GL posting without schema changes — but requires Adasoft to configure |
| **AdaSmart runs month-end close** | If month-end is not run, FCPdtQtyNow and stock card running balances drift; must verify if anyone runs it |
| **AdaSmart never launched on NB-005-01** | Back-office laptop cannot perform month-end or document approval — must be done on POSSRV or another machine |
| **PIN in plaintext** | Any staff member with DB access can read all customer PINs |
| **9 retail price levels + 15 wholesale levels** | SC Group has a sophisticated pricing structure; SC-StockDay should not oversimplify product pricing |
| **F&B and Ticketing = 0 rows** | These modules can be fully ignored for SC-StockDay at Branch 005 |
| **7 customers at Branch 005** | New branch; loyalty/CRM features at Branch 005 are essentially unused |
