---
name: AdaPos goods transfer reconciliation audit
description: Full audit confirming that the Adasoft suite on the hub machine is a loyalty points system only — no goods transfer reconciliation exists. Includes รับส่งข้อมูล process investigation and recommended workflow specification.
type: project
originSessionId: external-audit-2
---

## Key finding
The Adasoft suite on the hub machine (AdaUploadPoint, AdaDownloadPoint, AdaAbreastTools) is a **customer loyalty points sync system only**. It does NOT contain any goods transfer, stock movement, or inter-branch reconciliation feature. This is confirmed by exhaustive extraction of every method, class, table name, WCF operation, and Thai UI string from all four compiled executables.

The "รับส่งข้อมูล" process that staff perform every morning refers to **loyalty points data sync** (sending/receiving customer point balances between branch and central server) — not physical goods movement.

## What this software actually does
| Feature | Evidence |
|---|---|
| Customer earns/spends loyalty points at POS | `C_DATbAddCustomerPoint`, `cmlTCNTCstPoint`, `TCNTCstPoint` table |
| Points uploaded branch → central server | `C_DATxSendPoint`, `C_DATxSendPointWithSpl`, `C_DATxThreadSendPoint` |
| Points downloaded central → branch | `C_HTPbDownloadCstPoint`, `C_HTPbUnzipAndUpdPoint`, `C_GETxDownload` |
| Coupon/gift redemption | `C_GEToCoupon`, `C_SAVbSaveCoupon`, `TCNTCstGiftHD/DT` |
| Branch registration | `C_BCHbAddBranch`, `C_BCHoListBranch`, `TCNMBranch` |
| Supplier linking for joint promotions | `C_UPDxSupplierData`, `cmlTCNMSpl` — NOT goods supply |

Thai UI strings confirm: "ชื่อเซอร์วิสสำหรับจัดการแต้มลูกค้า" = "Service name for managing customer points"

## Confirmed missing — goods transfer features
The following were searched exhaustively and NOT found anywhere in any binary, config, log, or data file:
- Transfer-out / transfer-in documents
- In-transit status
- Quantity tracking (expected vs actual)
- Partial receipt
- Rejection / dispute workflow
- Stock reconciliation
- Warehouse / location / lot / batch tracking
- Any table with: Transfer, Stock, Inventory, Goods, Warehouse, Movement, GRN, Receive, Issue, Adjustment

## Database tables found (AdaAbreastTools.exe)
`TCNMBranch`, `TCNMComp`, `TCNMCst`, `TCNMSpl`, `TCNTCstPoint`, `TCNTCstGiftHD`, `TCNTCstGiftDT`, `TCNTCstGiftSN`, `TCNTPointQueue`, `TAOTItemRedemption`

## WCF operations (complete list — none relate to inventory)
**IAdaWCFCstPoint (local branch):** C_ADDbBranch, C_CHKbOnline, C_CMPbInsertDataComp, C_CMPbUpdateDataComp, C_CMPoGetDataComp, C_CSTbChkOnline, C_CSTbReqQue, C_CSTtGetPointAmtByCst, C_CSTtGetPointSplByCst, C_DATbAddCustomerPoint, C_DATtGetMyIPAddress, C_DELbCouponByAidID, C_FLEbDelFile, C_GETbDownload, C_GEToCoupon, C_GEToCstGiftCouponDT, C_GEToCstGiftCouponHD, C_GETtLastUpdCst, C_SAVbSaveCoupon

**IAdaWCFNoIP (central cloud):** C_BCHbAddBranch, C_BCHbDelBranch, C_BCHoGetBranch, C_BCHoListBranch, C_COMbAddCompany, C_COMbDelCompany, C_COMoGetCompany, C_COMoListCompany, C_DATtGetMyIPAddress, GetData, GetDataUsingDataContract

## Live data integrity risks (current situation)
1. **One-sided stock records** — Branch A records "sent 10 strips," reduces stock immediately. Branch C may never formally confirm in-system.
2. **Correction transactions compound the problem** — instead of correcting originals, new records are added. History becomes unreadable.
3. **Stock can go negative or phantom-positive** between branches with no forced reconciliation.
4. **No in-transit freeze** — stock leaves Branch A's books before Branch C physically receives goods.
5. **Fake transactions for retroactive stock matching** — staff create fictitious records to force numbers to match. Corrupts purchasing history and dispensing records.
6. **No approval gate** — any staff member can create corrections; no second-person approval, no reason code, no manager sign-off.

## Where the real goods transfer feature might be
The actual POS inventory software runs on **cashier terminal computers**, not this hub machine. `AdaPos3.0/` and `AdaPos4.0/` directories exist on this machine but contain only empty folder stubs (created 2020, never used here). 

**To check on cashier terminals:**
- Main POS executable (likely `AdaPos3.0.exe` or `AdaPos4.0.exe`)
- Menu items: โอนสินค้า, รับโอน, ปรับยอด, ใบโอน
- SQL Server tables in `AdaAcc` database at `ADA47\SQL2008` for transfer-related tables

## Target workflow specification (for vendor discussion or custom build)
Correct inter-branch transfer flow:
1. Branch A creates Transfer-Out — Status: DRAFT (editable)
2. Branch A confirms send — Status: IN TRANSIT (read-only, stock reserved/committed but not yet deducted)
3. Goods travel physically
4. Branch C opens "Pending Transfers" list, sees document
5. Branch C enters ACTUAL received quantity (may differ from expected)
6. System detects discrepancy — requires reason code + optional manager approval
7. Branch C confirms receipt — Status: RECEIVED / PARTIAL
8. Branch C stock increases by ACTUAL quantity
9. Branch A stock decreases by ACTUAL confirmed quantity
10. Discrepancy record created; both expected and actual quantities stored permanently; original document never overwritten

**Rules:** Cannot cancel after IN TRANSIT without Branch C acknowledgement. All corrections need reason code + staff ID + timestamp.

## Key vendor questions to ask
1. Does your POS have a Transfer-Out document (item, qty, lot, expiry)?
2. Does your POS have a Transfer-In / Goods Receive document Branch C must complete?
3. Can Branch C enter actual qty differing from expected and have system flag the difference?
4. Is there a document status workflow (Draft → In Transit → Received / Partial / Disputed)?
5. Is stock deducted at send time or only after Branch C confirms receipt?
6. Is there a discrepancy report showing all transfers where sent ≠ received?
7. Is inter-branch transfer reconciliation included in our current licence, or an add-on?
8. If the feature exists but unused — can you train staff and configure it within 30 days?
9. If the feature doesn't exist — what is your roadmap / alternative recommendation?

## Files audited in this session
`AdaUploadPoint.exe` (145 KB), `AdaDownloadPoint.exe` (368 KB), `AdaUploadPointConfig.exe` (830 KB), `AdaAbreastTools.exe` (1.8 MB), `AdaAbreastTools/TH/AdaAbreastTools.resources.dll` (32 KB), `AdaUploadPointCfg.xml`, `AdaXML.Ada`, `AdaDownload.ada`
