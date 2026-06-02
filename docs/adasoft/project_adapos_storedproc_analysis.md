---
name: StoreProcedures.rar — Full Analysis Report
description: Analysis of the StoreProcedures.rar archive from AdaWCFCstPoint. Archive is a 2013 deployment kit only — 1 procedure, 1 table DDL, 2 views. Core business logic (point calculation, expiry, tier, redemption) is NOT here — lives in compiled VB.NET DLLs or live AdaAcc stored procedures.
type: project
originSessionId: external-audit-5
---

## File info
- Path: `C:\Inetpub\wwwroot\AdaWCFCstPoint\StoreProcedures.rar`
- Archive size: 1,368 bytes | Modified: 2022-01-17
- All 3 files inside dated: 2013-07-11 (12-year-old setup kit)
- Status: Extracted successfully, no password

## CRITICAL CONCLUSION
**This archive is a deployment scaffolding kit — NOT a complete procedure library.**
The real business logic (point calculation rate, expiry rules, tier promotion, redemption workflow) is entirely absent from this archive. It lives in:
- `AdaWCFCstPoint_5406_01.dll` (compiled VB.NET) — most likely location
- Additional stored procedures in the **live AdaAcc database** not included in this archive

---

## File inventory
| Filename | Size | Type | Contents |
|---|---|---|---|
| `Create STP_CN_GetBrowseMaster.sql` | 908 bytes | Stored procedure | One generic dynamic SQL browse procedure (UTF-16 LE encoded) |
| `Create TCNTPointQueue.sql` | 636 bytes | Table DDL | CREATE/TRUNCATE for `TCNTPointQueue` sync queue table |
| `Create View AdaMember.sql` | 902 bytes | Two SQL VIEWs | Point balance calculation views |

---

## Object 1 — STP_CN_GetBrowseMaster (Stored Procedure)

**Purpose:** Generic dynamic browse — caller passes any table name, column list, and WHERE string. Assembles and EXECs the SQL.

```sql
DECLARE @tSql NVARCHAR(4000)
SET @tSql = 'SELECT ' + @ptFieldName
SET @tSql = @tSql + ' FROM ' + @ptTableName
IF @ptWhere <> ''
    SET @tSql = @tSql + ' WHERE ' + @ptWhere
EXEC(@tSql)
```

Parameters: `@ptTableName NVARCHAR(500)`, `@ptFieldName NVARCHAR(500)`, `@ptWhere NVARCHAR(500)`
Reads: Any table caller specifies | Writes: Nothing | Calls: Nothing

### ⚠️ CRITICAL SECURITY — SQL Injection
All three parameters concatenated directly into dynamic SQL with no sanitization, executed via `EXEC()` (not `sp_executesql` with parameterized values). Classic textbook SQL injection. Any caller who can reach this procedure can execute arbitrary SQL.
**Risk is CRITICAL** because the SA account (`sa`/`adasoft`) is already in use — escalation to `xp_cmdshell` is possible if SA is active.

---

## Object 2 — TCNTPointQueue (Table DDL)

**Purpose:** Sync upload queue — branch loyalty data pending upload to central server.

```sql
IF OBJECT_ID('TCNTPointQueue', 'U') IS NOT NULL
    TRUNCATE TABLE TCNTPointQueue  -- ⚠️ silently clears queue on re-run!
ELSE
    CREATE TABLE [dbo].[TCNTPointQueue] (...)
```

| Column | Type | Notes |
|---|---|---|
| `FNQueID` | bigint IDENTITY(1,1) | PK auto-increment |
| `FDQueDate` | datetime | Queue entry date |
| `FTQueTime` | varchar(8) | Time HH:MM:SS |
| `FTBchCode` | varchar(3) | Branch that generated the data |
| `FTQueXMLName` | varchar(200) | XML filename to upload |
| `FTQueXSDName` | varchar(200) | XSD schema filename |
| `FTQueUrl` | varchar(200) | Target WCF service URL |
| `FTQueStatus` | varchar(1) | Queue status (P=Pending/S=Sent/F=Failed likely) |

**Note:** This table does NOT appear in `AdaCustomer.edmx` — it is internal to the sync infrastructure, hidden from the EF model layer.
**⚠️ Risk:** Running this setup script on production silently wipes the entire pending sync queue with no warning.

---

## Object 3 — V_LastPrcMonthEndPoint (VIEW)

```sql
SELECT FTCstCode, MAX(FDPntDate) AS FDMaxPrcDate
FROM TCNTCstPoint
WHERE FTPntCardType = '3'
GROUP BY FTCstCode
```

**Purpose:** For each customer, finds the date of the most recent month-end checkpoint transaction (CardType='3'). This is the rolling window start — only transactions after this date count toward current balance.

---

## Object 4 — V_AllPointAmt (VIEW) — Core balance calculation

```sql
SELECT A.FTCstCode,
    SUM(CASE FTPntCardType
        WHEN '1' THEN  FNPntPoint
        WHEN '2' THEN -FNPntPoint
        WHEN '3' THEN  FNPntPoint
        END) AS FNPoint,
    SUM(CASE FTPntCardType
        WHEN '1' THEN  FCPntAmtRcv
        WHEN '2' THEN -FCPntAmtRcv
        WHEN '3' THEN  FCPntAmtRcv
        END) AS FCAmt
FROM TCNTCstPoint A
LEFT JOIN V_LastPrcMonthEndPoint B ON A.FTCstCode = B.FTCstCode
WHERE NOT A.FDPntDate IS NULL
  AND A.FDPntDate >= ISNULL(B.FDMaxPrcDate, '1900/01/01')
  AND ISNULL(FTPntCardType, '') <> ''
GROUP BY A.FTCstCode
```

**Purpose:** Each customer's live point balance and total spend — the loyalty wallet.

### FTPntCardType decode (confirmed from this view)
| Value | Meaning | Effect on balance |
|---|---|---|
| `'1'` | Points earned (sale) | +FNPntPoint |
| `'2'` | Points used (redemption) | −FNPntPoint |
| `'3'` | Month-end checkpoint (closing balance) | +FNPntPoint (carry forward) |

### Month-end checkpoint pattern (confirmed)
Instead of summing all history from day 1, a batch job writes a CardType='3' row at month-end with the closing balance. After that, `V_AllPointAmt` only sums transactions since that checkpoint date. Classic running-balance checkpoint for large ledgers.
**The procedure that writes the CardType='3' rows is NOT in this archive** — likely in the compiled DLL or triggered from `uPrcExpirePnt.ascx` in AdaWebAbreast.

---

## Business logic questions — status after this archive

| Question | Status | Evidence |
|---|---|---|
| How are points per baht calculated? | ❌ Not found | Rate logic not in archive. `FCPntPointbyOne` is stored per row in `TCNTCstPoint` but the calculation is in the DLL |
| How do points expire? | ⚠️ Partial | `FTPntExpired`/`FTPntStaExpired` flags exist in EDMX. Expiry trigger not here. Month-end checkpoint (CardType='3') archives old rows |
| Tier/level promotion rules? | ❌ Not found | Nothing touching `FTClvCode` or `TCNMCstLev` |
| Gift/redemption workflow? | ❌ Not found | No procedure inserts CardType='2' rows or writes to `TCNTCstGiftHD/DT` |
| Month-end batch job? | ⚠️ Confirmed exists | View proves it. Procedure that writes it: not here |
| Cross-database write to AdaAcc? | ✅ Not done | No cross-DB references. Confirmed zero |
| Stock/inventory procedures? | ✅ Confirmed absent | Zero — matches earlier audit |
| Inter-branch transfer procedures? | ✅ Confirmed absent | Zero |

---

## Security and quality findings
| Issue | Severity | Detail |
|---|---|---|
| SQL Injection in STP_CN_GetBrowseMaster | CRITICAL | All 3 params concatenated + EXEC() — no sanitization |
| No TRY/CATCH anywhere | HIGH | Zero error handling in all 3 files |
| No transactions | HIGH | No BEGIN TRAN/COMMIT/ROLLBACK |
| TRUNCATE on re-run of setup script | MEDIUM | Silently clears production sync queue |
| 12-year-old code, never updated | INFO | All files dated 2013-07-11 |

---

## New table discovered (not in EDMX)
`TCNTPointQueue` — sync upload queue. Internal to sync infrastructure. EF model layer does not expose it.

---

## Recommended next queries (priority order)
Run on AdaAcc database:

```sql
-- 1. Find ALL stored procedures in live DB (may be many more than this archive)
SELECT ROUTINE_NAME, CREATED, LAST_ALTERED
FROM INFORMATION_SCHEMA.ROUTINES
WHERE ROUTINE_TYPE = 'PROCEDURE'
ORDER BY ROUTINE_NAME;

-- 2. Find ALL views in live DB
SELECT TABLE_NAME, VIEW_DEFINITION
FROM INFORMATION_SCHEMA.VIEWS
ORDER BY TABLE_NAME;

-- 3. Confirm CardType distribution in live data
SELECT FTPntCardType, COUNT(*) as cnt, SUM(FNPntPoint) as total_pts
FROM TCNTCstPoint
GROUP BY FTPntCardType;

-- 4. Check pending sync queue entries
SELECT TOP 5 * FROM TCNTPointQueue ORDER BY FNQueID DESC;

-- 5. Find ALL tables in AdaAcc (the big one)
SELECT TABLE_NAME
FROM INFORMATION_SCHEMA.TABLES
WHERE TABLE_TYPE = 'BASE TABLE'
ORDER BY TABLE_NAME;
```

Next file to investigate: **`AdaWCFCstPoint_5406_01.dll`** — extract strings to find point calculation formula and expiry logic.

---

## Updated understanding estimates
| Layer | Before | After |
|---|---|---|
| iPointz loyalty layer (schema) | ~85% | ~85% (unchanged) |
| iPointz business logic | ~10% | ~25% (CardType pattern now confirmed) |
| AdaAcc POS/inventory layer | ~20% | ~20% (unchanged) |
| Overall system | ~35% | ~40% |
