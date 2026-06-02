---
name: AdaCustomer.edmx — Full Parse Report
description: Complete Entity Framework model parse of the iPointz loyalty database. 18 tables fully mapped. Confirms this is loyalty-only schema — zero inventory/transfer/sales tables. Key schema details, column types, inferred FK relationships, anomalies noted.
type: project
originSessionId: external-audit-4
---

## File info
- Path: `C:\Inetpub\wwwroot\AdaiPointz\Database\AdaCustomer.edmx`
- Format: XML, Entity Framework 2.0, `ProviderManifestToken="2008"` (SQL Server 2008)
- Status: Fully readable plain XML — not encrypted

## Critical confirmation
This EDMX maps **exactly 18 tables** — all belonging to the **iPointz loyalty layer only**.
**Zero inventory, zero sales, zero stock transfer, zero purchase tables exist here.**
The POS tables (`TPSTSalHD`, `TACTPiHD`, etc.) live in `AdaAcc` — a separate database not covered by this model.

## Two confirmed separate databases
| Database | Contains | Accessed by |
|---|---|---|
| iPointz loyalty DB | These 18 tables | AdaUploadPoint / AdaDownloadPoint WCF services |
| AdaAcc (POS DB) | TPSTSalHD, TACTPiHD, stock tables etc. | AdaPos4.0 POS software + adapos-sync |

The join key between the two worlds: `TCNTCstPoint.FTPntRefDoc` = POS receipt number from AdaAcc.

---

## All 18 tables — summary

### Master data (TCNM)
| Table | PK | Key purpose |
|---|---|---|
| `TCNMBranch` | `FTBchCode` varchar(3) | Branch registry — `FTBchHQ` = 'Y'/'N', `FTBchWheStk` = warehouse stock code |
| `TCNMComp` | `FTCmpCode` varchar(3) | Company master — tax ID, VAT%, logo paths |
| `TCNMCst` | `FTCstCode` varchar(20) | Customer master — 68 columns. Card number, DOB, tier, running point totals |
| `TCNMCst_AutoID` | `FNCsaAutoID` decimal identity | Auto-increment member ID generator — separate from string customer code |
| `TCNMCstGrp` | `FTCgpCode` varchar(5) | Customer group (e.g. VIP, CORP) |
| `TCNMCstLev` | `FTClvCode` varchar(5) | Customer tier/level (e.g. GOLD, SILV) |
| `TCNMCstType` | `FTCtyCode` varchar(5) | Customer type classification |
| `TCNMPdt` | `FTPdtCode` varchar(20) | Product master — ~120 columns. 3 barcodes, 3 unit sizes + factors, 9 retail price tiers, 15 wholesale price tiers, min/max stock, lead time, multiple cost methods, promotion date windows |
| `TCNMRedItem` | `FTRdiBarCode` varchar(25) | Redeemable item catalog — barcode → product → points required |
| `TCNMSpl` | `FTSplCode` varchar(20) | Supplier master — 50+ columns, mirrors TCNMCst structure |

### Transactions (TCNT)
| Table | PK | Key purpose |
|---|---|---|
| `TCNTCstGiftHD` | (`FTBchCode`, `FTCghDocNo`) | Gift/redemption header — points used (`FCCghPntUsed`), balance at checkout (`FCCghPntAtChe`), counter name, approval code |
| `TCNTCstGiftDT` | (`FTBchCode`, `FTCghDocNo`, `FNCgdSeqNo`, `FTPdtCode`) | Gift/redemption detail lines — qty, points per item, coupon code used |
| `TCNTCstGiftSN` | (`FTCghDocNo`, `FTPdtCode`, `FTSrnCode`) | Serial numbers of physical gift items dispensed |
| `TCNTCstPoint` | (`FTBchCode`, `FTCstCode`, `FTPntRefDoc`, `FTSplCode`) | Point earning ledger — every earn event. `FCPntPointbyOne` = rate at time of transaction. `FTPntRefDoc` = POS receipt number (join key to AdaAcc) |

### Operations (TAOT)
| Table | PK | Key purpose |
|---|---|---|
| `TAOTItemRedemption` | `FCAidID` decimal identity | Redemption item catalog (prizes) — point cost, image URL, discount type, validity dates |

### System (TSys)
| Table | PK | Key purpose |
|---|---|---|
| `TSysAuto` | (`FTSatTblName`, `FTSatFedCode`, `FTSatStaDocType`) | Document auto-numbering config — format templates, last used number, reset rules |
| `TSysConfig` | (`FTSysCode`, `FTSysSeq`) | Key-value system settings store — bilingual names, default vs user values |
| `TSysMerchant` | `FTMcrCode` varchar(5) | Merchant/brand master |
| `TSysUser` | `FTUsrCode` varchar(20) | User accounts — `FTUsrPwd` varchar(50) likely plaintext/lightly encoded, `FNUsrLevel` bigint = permission level |

---

## Key columns of interest

### TCNMCst (Customer — 68 cols)
`FTCstCode`, `FTCstName`, `FTCstCrdNo` (loyalty card), `FDCstCrdIssue/Expire`, `FTBchCode` (home branch), `FTCgpCode` (group), `FTClvCode` (tier), `FCCstWhsAmt/WhsPoint` (wholesale totals), `FCCstRetAmt/RetPoint` (retail totals), `FCCstDailyAmt/DailyPoint`, `FDCstLastPoint`, `FTCstStaActive`, `FTCstPin`, `FNCstMemberID` bigint

### TCNMPdt (Product — ~120 cols)
`FTPdtCode`, `FTPdtBarCode1/2/3`, `FTPdtSUnit/MUnit/LUnit`, `FCPdtSFactor/MFactor/LFactor`, `FCPdtQtyNow/QtyRet/QtyWhs`, `FCPdtMin/Max`, `FCPdtLeadTime`, cost methods: `FCPdtCostAvg/FiFo/Last/Def/Std`, retail prices: `FCPdtRetPriS1-3/M1-3/L1-3`, wholesale: `FCPdtWhsPriS1-5/M1-5/L1-5`, `FTPdtPoint` (eligible flag), `FCPdtPointTime` (multiplier)

### TCNTCstPoint (Point ledger)
`FTBchCode` varchar(**6**) — anomaly: wider than `TCNMBranch.FTBchCode` varchar(3)
`FCPntPointbyOne` — points-per-baht rate stored at transaction time
`FCPntAmtRcv` — baht amount that generated points
`FNPntPoint` bigint — points earned
`FTPntRefDoc` varchar(40) — **POS receipt number = join key to AdaAcc**
`FDPntSplStart/Expired` — supplier point validity window
`FTPntStaExpired` — expiry processed flag

### TCNTCstGiftHD — Cross-branch coupon tracking
`FTBchCodeClaimCoupon` + `FTRefDocNoClaimCoupon` — tracks which branch issued a coupon when it is claimed at a different branch. Cross-branch coupon reconciliation is partially modeled.

---

## Inferred FK relationships (no formal Association elements in EDMX)
```
TCNMCst.FTBchCode         → TCNMBranch.FTBchCode
TCNMCst.FTCgpCode         → TCNMCstGrp.FTCgpCode
TCNMCst.FTCtyCode         → TCNMCstType.FTCtyCode
TCNMCst.FTClvCode         → TCNMCstLev.FTClvCode
TCNMCst.FTMcrCode         → TSysMerchant.FTMcrCode
TCNMComp.FTBchCode        → TCNMBranch.FTBchCode
TCNMPdt.FTSplCode         → TCNMSpl.FTSplCode
TCNMRedItem.FTRdiPdtCode  → TCNMPdt.FTPdtCode
TCNMRedItem.FTSplCode     → TCNMSpl.FTSplCode
TCNMSpl.FTBchCode         → TCNMBranch.FTBchCode
TCNTCstGiftHD.FTBchCode   → TCNMBranch.FTBchCode
TCNTCstGiftHD.FTCstCode   → TCNMCst.FTCstCode
TCNTCstGiftHD.FTSplCode   → TCNMSpl.FTSplCode
TCNTCstGiftHD.FTUsrCode   → TSysUser.FTUsrCode
TCNTCstGiftDT.(FTBchCode+FTCghDocNo) → TCNTCstGiftHD (composite)
TCNTCstGiftDT.FTPdtCode   → TCNMPdt.FTPdtCode
TCNTCstGiftDT.FCAidID     → TAOTItemRedemption.FCAidID
TCNTCstGiftSN.FTCghDocNo  → TCNTCstGiftHD.FTCghDocNo
TCNTCstPoint.FTBchCode    → TCNMBranch.FTBchCode  ⚠️ width mismatch varchar(6) vs varchar(3)
TCNTCstPoint.FTCstCode    → TCNMCst.FTCstCode
TCNMCst_AutoID.FTCstCode  → TCNMCst.FTCstCode
```

---

## Anomalies
1. **`TCNTCstPoint.FTBchCode` is varchar(6)** but `TCNMBranch.FTBchCode` is varchar(3). PK mismatch — suggests branch codes may be prefixed in the point ledger, or the schema was extended without updating all tables. Potential data integrity gap.
2. **`TSysUser.FTUsrPwd`** varchar(50) with `FTUsrEncript` varchar(1) flag — password likely plaintext or lightly encoded. Same vulnerability pattern as `sa/adasoft` in AdaDownloadPoint config.
3. **No stored procedures in EDMX** — all business logic (point calculation, expiry, tier promotion) is in `StoreProcedures.rar` or VB.NET DLLs.
4. **`FTAidVerion` typo** in TAOTItemRedemption — direct copy from source code with the typo preserved.

---

## What this file cannot tell us
- Point calculation rules (how `FCPntPointbyOne` is determined per campaign/product)
- Point expiry trigger logic (`FTPntStaExpired` flag exists but processing logic unknown)
- Tier promotion thresholds (what spend moves a customer from SILV → GOLD)
- Index strategy — no index info in EDMX
- Actual data volumes in each table
- Whether iPointz tables and AdaAcc tables are in the same SQL Server database instance or separate DBs

---

## Updated understanding estimates
| Layer | Before EDMX | After EDMX |
|---|---|---|
| iPointz loyalty layer | ~65% | ~85% |
| AdaAcc POS/inventory layer | ~20% | ~20% (unchanged — not in this file) |
| Business logic / stored procedures | ~10% | ~10% (still in StoreProcedures.rar) |
| Overall system | ~15% | ~35% |

---

## Recommended next steps (priority order)
1. **`SELECT * FROM INFORMATION_SCHEMA.TABLES` on AdaAcc** — confirm whether these 18 tables share AdaAcc with the POS tables, and discover all remaining tables
2. **Extract `StoreProcedures.rar`** — now the single most valuable unexplored artifact. Contains all calculation, expiry, and promotion logic.
3. **`SELECT COUNT(*) FROM TCNTCstPoint`** — assess how much loyalty data accumulated during the sync outage years
4. **Check `TCNTCstPoint` for 6-char branch codes** — `SELECT DISTINCT FTBchCode FROM TCNTCstPoint WHERE LEN(FTBchCode) > 3` — determine if the width anomaly has live data
