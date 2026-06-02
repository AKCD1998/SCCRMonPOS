# Stock Day Findings For Worksheet `สั่งสินค้า`

## Summary

- Confirmed target metric: `stock day` / `days of stock`
- Confirmed business direction: rule-based workflow, not AI forecasting
- Confirmed worksheet focus: `สั่งสินค้า`
- Source system identified: `ADA-SOFT Thai Retail POS v3.0/4.0`
- Database engine: SQL Server
- Database name: `AdaAcc`
- Coverage observed: Dec 2024 to May 2026
- Branches observed: 6
  - `000` = HQ / สำนักงานใหญ่
  - `001` to `005` = branch stores

## Relevant Sources Found

| Source | Table(s) | Row Count | Stock-Day Input |
|---|---|---:|---|
| Product Master | `TCNMPdt` | 6,661 | Product code, name, barcode, S/M/L units + factors, current stock, min/max, lead time, supplier |
| Unit Name Lookup | `TCNMPdtUnit` | 85 | Thai unit names such as `ชิ้น`, `กล่อง`, `ขวด`, `แผง` |
| Supplier Master | `TCNMSpl` | 268 | Supplier code and name |
| Branch Master | `TCNMBranch` | 6 | Branch code, branch name, HQ flag |
| Purchase Invoice | `TACTPiHD`, `TACTPiDT` | 7,203 / 19,103 | HQ order-in from suppliers: date, supplier, product, qty, unit, warehouse, branch |
| POS Sales | `TPSTSalHD`, `TPSTSalDT` | 428,364 / 835,544 | Store sell-out / demand: date, branch, product, qty sold, unit, stock factor |
| Stock Transfer | `TCNTPdtTnfHD`, `TCNTPdtTnfDT` | 6,722 / 70,909 | HQ to branch stock movements |
| Stock Card | `TCNTPdtStkCard` | 635,976 | All IN/OUT/balance stock movements |
| Report Stock Card | `TRptPdtStkCard` | 51,272 | Precomputed stock movement report output |
| Stock Count / Physical Check | `TCNTPdtChkHD`, `TCNTPdtChkDT` | 20 heads | Physical count vs system count |
| POS Daily Sales Summary | `TPSTSalSumDaily` | not checked | Daily aggregated sales per branch |

## Not Found Or Not In Use

| Table | Rows | Meaning |
|---|---:|---|
| `TCNMPdtBar` | 0 | Barcode table empty; barcode lives in `TCNMPdt.FTPdtBarCode1/2/3` |
| `TCNTPdtReqHD`, `TCNTPdtReqDT` | 0 | Operator request workflow not used |
| `TACTPoHD`, `TACTPoDT` | 0 | Purchase order workflow not used |
| `TDFTStkFiFoIn`, `TDFTStkFiFoOut`, `TDFTStkFiFoHis` | 0 to 2 | FIFO costing not active |
| `TCNTPdtDetail` | 0 | Not in use |
| `TCNMRateUnit` | 3 | Currency rounding only, not product unit conversion |

## Mapping To Stock-Day Inputs

### Product Master Source

Table: `TCNMPdt`

| Meaning | Column |
|---|---|
| Product code | `FTPdtCode` |
| Product name | `FTPdtName` |
| Barcode | `FTPdtBarCode1`, `FTPdtBarCode2`, `FTPdtBarCode3` |
| Small unit | `FTPdtSUnit` |
| Small factor | `FCPdtSFactor` |
| Medium unit | `FTPdtMUnit` |
| Medium factor | `FCPdtMFactor` |
| Large unit | `FTPdtLUnit` |
| Large factor | `FCPdtLFactor` |
| Stock code | `FTPdtStkCode` |
| Current stock | `FCPdtQtyNow` |
| Retail stock | `FCPdtQtyRet` |
| Warehouse stock | `FCPdtQtyWhs` |
| Min stock | `FCPdtMin` |
| Max stock | `FCPdtMax` |
| Supplier | `FTSplCode` |
| Lead time | `FCPdtLeadTime` |
| Active flag | `FTPdtStaActive` |

### Operator Demand / Sell-Out Source

Primary source: `TPSTSalHD` + `TPSTSalDT`

Relevant fields:

- Branch: `FTBchCode`
- Sale date: `FDShdDocDate`
- Product: `FTPdtCode`
- Qty: `FCSdtQty`
- Stock code: `FTSdtStkCode`
- Stock factor: `FCSdtStkFac`
- Unit name: `FTSdtUnitName`

Important:

- There is no operator request table in use
- POS sales is the only confirmed demand signal

### HQ Purchase / Order-In Source

Primary source: `TACTPiHD` + `TACTPiDT`

Relevant fields:

- Branch: `FTBchCode` where HQ is typically `000`
- Purchase date: `FDXihDocDate`
- Supplier: `FTSplCode`
- Product: `FTPdtCode`
- Qty: `FCXidQty`
- Stock code: `FTXidStkCode`
- Stock factor: `FCXidStkFac`
- Unit name: `FTXidUnitName`
- Warehouse: `FTWahCode`

### Transfer To Branches

Source: `TCNTPdtTnfHD` + `TCNTPdtTnfDT`

Relevant fields:

- From branch: `FTPthBchFrm`
- To branch: `FTPthBchTo`
- Product: `FTPdtCode`
- Qty: `FCPtdQty`
- Unit name: `FTPtdUnitName`
- Stock factor: `FCPtdStkFac`

### Stock Balance Source

Available now:

- `TCNMPdt.FCPdtQtyNow` = live running stock balance
- `TCNMPdt.FCPdtQtyRet` = retail/shop balance
- `TCNMPdt.FCPdtQtyWhs` = warehouse balance

Warning:

- These appear to be global totals, not branch-specific balances
- If branch-level current stock is required, reconstruct from `TCNTPdtStkCard` by `FTBchCode`

### Unit Conversion Source

Unit conversion is built into `TCNMPdt`:

- Small unit = base unit
- Medium unit = `FCPdtMFactor` units per medium pack
- Large unit = `FCPdtLFactor` units per large pack/case

Transaction lines also carry normalization fields:

- Sales: `FCSdtStkFac`
- Purchase: `FCXidStkFac`
- Transfer: `FCPtdStkFac`

Always normalize quantity using:

`normalized_qty = qty * stock_factor`

### Branch / Date Dimensions

- Branch key: `FTBchCode`
- Branch lookup: `TCNMBranch`
- Purchase date: `FDXihDocDate`
- Sales date: `FDShdDocDate`
- Transfer date: `FDPthDocDate`
- Stock date: `FDStkDate`

## Minimum Calculation Structure

### A. Product Master

```sql
SELECT
  FTPdtCode        AS product_code,
  FTPdtName        AS product_name,
  FTPdtBarCode1    AS barcode,
  FTPdtSUnit       AS unit_small,
  FCPdtSFactor     AS factor_small,
  FTPdtMUnit       AS unit_medium,
  FCPdtMFactor     AS factor_medium,
  FTPdtLUnit       AS unit_large,
  FCPdtLFactor     AS factor_large,
  FCPdtQtyNow      AS stock_current,
  FCPdtMin         AS stock_min,
  FCPdtMax         AS stock_max,
  FCPdtLeadTime    AS lead_time_days,
  FTSplCode        AS supplier_code
FROM TCNMPdt
WHERE FTPdtStaActive = 'Y';
```

### B. Operator Demand Movements By Day

```sql
SELECT
  h.FTBchCode                      AS branch,
  h.FDShdDocDate                   AS sale_date,
  d.FTPdtCode                      AS product_code,
  d.FTSdtStkCode                   AS stock_code,
  SUM(d.FCSdtQty * d.FCSdtStkFac) AS qty_base_unit
FROM TPSTSalHD h
JOIN TPSTSalDT d
  ON h.FTBchCode = d.FTBchCode
 AND h.FTShdDocNo = d.FTShdDocNo
WHERE h.FDShdDocDate BETWEEN @start_date AND @end_date
GROUP BY h.FTBchCode, h.FDShdDocDate, d.FTPdtCode, d.FTSdtStkCode;
```

### C. HQ Purchase / Order-In

```sql
SELECT
  h.FTBchCode                      AS branch,
  h.FDXihDocDate                   AS purchase_date,
  h.FTSplCode                      AS supplier,
  d.FTPdtCode                      AS product_code,
  SUM(d.FCXidQty * d.FCXidStkFac) AS qty_base_unit
FROM TACTPiHD h
JOIN TACTPiDT d
  ON h.FTBchCode = d.FTBchCode
 AND h.FTXihDocNo = d.FTXihDocNo
WHERE h.FDXihDocDate BETWEEN @start_date AND @end_date
GROUP BY h.FTBchCode, h.FDXihDocDate, h.FTSplCode, d.FTPdtCode;
```

### D. Stock Snapshot

```sql
SELECT
  FTPdtCode,
  FCPdtQtyNow AS current_stock,
  FCPdtQtyRet,
  FCPdtQtyWhs
FROM TCNMPdt;
```

If branch-level stock is required later:

```sql
SELECT
  FTBchCode,
  FTPdtStkCode,
  SUM(
    CASE
      WHEN FTStkType = 1 THEN FCStkQty
      WHEN FTStkType = 2 THEN -FCStkQty
      WHEN FTStkType = 5 THEN FCStkQty
      ELSE 0
    END
  ) AS stock_on_hand
FROM TCNTPdtStkCard
GROUP BY FTBchCode, FTPdtStkCode;
```

### E. Unit Conversion Lookup

```sql
SELECT
  p.FTPdtCode,
  p.FTPdtSUnit,
  p.FCPdtSFactor,
  p.FTPdtMUnit,
  p.FCPdtMFactor,
  p.FTPdtLUnit,
  p.FCPdtLFactor,
  u.FTPunName AS unit_name
FROM TCNMPdt p
LEFT JOIN TCNMPdtUnit u
  ON p.FTPdtSUnit = u.FTPunCode;
```

### F. Final Stock-Day Output

```sql
WITH sales AS (
  -- aggregate POS sales per product for selected period
),
purchases AS (
  -- aggregate purchase invoice qty per product for selected period
),
master AS (
  SELECT
    FTPdtCode,
    FTPdtName,
    FCPdtQtyNow AS stock_current,
    FCPdtMin,
    FCPdtMax,
    FCPdtLeadTime
  FROM TCNMPdt
)
SELECT
  m.FTPdtCode,
  m.FTPdtName,
  m.stock_current                                   AS current_stock,
  COALESCE(s.total_sold, 0)                         AS sold_qty,
  COALESCE(p.total_purchased, 0)                    AS purchased_qty,
  COALESCE(s.total_sold, 0) * 1.0 / @period_days   AS avg_daily_usage,
  CASE
    WHEN COALESCE(s.total_sold, 0) > 0
      THEN m.stock_current / (s.total_sold * 1.0 / @period_days)
    ELSE 9999
  END                                               AS stock_day,
  CASE
    WHEN m.stock_current <= m.FCPdtMin THEN 'Reorder soon'
    WHEN m.stock_current >= m.FCPdtMax THEN 'Overstock / slow moving'
    ELSE 'Normal'
  END                                               AS status
FROM master m
LEFT JOIN sales s ON m.FTPdtCode = s.FTPdtCode
LEFT JOIN purchases p ON m.FTPdtCode = p.FTPdtCode;
```

## Required Business Formulas

- `Ending Stock = Starting Stock + Purchased Qty - Sold Qty`
- `Average Daily Usage = Sold Qty / Number of Days`
- `Stock Day = Current Stock / Average Daily Usage`
- `Average Inventory = (Starting Stock + Ending Stock) / 2`
- `Turnover Rate = Sold Qty / Average Inventory`

## Can We Calculate Now?

| Input | Status | Source |
|---|---|---|
| Product code / name / barcode | Yes | `TCNMPdt` |
| Current stock on hand | Yes | `TCNMPdt.FCPdtQtyNow` or reconstructed from `TCNTPdtStkCard` |
| Sold qty / demand | Yes | `TPSTSalDT.FCSdtQty * FCSdtStkFac` |
| Average daily usage | Yes | calculated from POS sales and period days |
| Stock day | Yes | `current_stock / avg_daily_usage` |
| HQ purchase qty | Yes | `TACTPiDT.FCXidQty * FCXidStkFac` |
| Unit conversion | Yes | `TCNMPdt` factor fields |
| Min / max thresholds | Yes | `FCPdtMin`, `FCPdtMax` |
| Lead time | Yes | `FCPdtLeadTime` |
| Branch-level stock balance | Partial | reconstruct from `TCNTPdtStkCard` if needed |
| Operator request qty | No | request tables are empty |
| Pending purchase order qty | No | PO tables are empty |
| Starting stock for past period | Partial | estimate or reconstruct |

## Gaps And Risks

### 1. Global vs branch-level stock

- `FCPdtQtyNow` appears to be global stock
- If the worksheet must be branch-specific, stock must be reconstructed by branch from `TCNTPdtStkCard`

### 2. No operator request workflow

- `TCNTPdtReqHD/DT` has 0 rows
- Therefore `สั่งสินค้า` cannot be driven by operator-request documents
- Demand should use actual POS sales history

### 3. Unit mixing risk

- Transactions occur in mixed units such as `ชิ้น`, `กล่อง`, `แผง`, `ขวด`
- Never sum raw quantity across units
- Always normalize with `qty * stock_factor`

### 4. Thai Buddhist Era date anomaly

- Some POS rows show BE-style future-looking dates such as `2569-04-15`
- This can break `MAX(date)` logic and date-range filters
- Use a defensive date filter when querying sales

Example guard:

```sql
WHERE FDShdDocDate <= '2026-12-31'
```

### 5. Purchase data is HQ-only

- Supplier purchases are recorded at branch `000`
- This is HQ inbound, not direct per-branch receipts

### 6. Zero-sale products

- Products with no sales in the selected period produce effectively infinite stock day
- These should be classified as `Overstock / slow moving`, not allowed to generate divide-by-zero errors

### 7. Sync/service risk

- `AdaUploadPoint` service logs show `Invalid URI: hostname could not be parsed`
- This may indicate broken sync and stale branch-level data

## Recommended V1 Workflow

### Scope

Build worksheet `สั่งสินค้า` as a stock-day decision sheet using:

- `TCNMPdt`
- `TPSTSalHD`
- `TPSTSalDT`
- optionally `TACTPiHD` and `TACTPiDT` for purchased/order-in visibility

### Step 1. Pull active product master with stock

```sql
SELECT
  FTPdtCode,
  FTPdtName,
  FTPdtBarCode1,
  FCPdtQtyNow AS stock_now,
  FCPdtMin,
  FCPdtMax,
  FTPdtSUnit,
  FCPdtSFactor,
  FTPdtMUnit,
  FCPdtMFactor,
  FTPdtLUnit,
  FCPdtLFactor,
  FTSplCode
FROM TCNMPdt
WHERE FTPdtStaActive = 'Y';
```

### Step 2. Aggregate POS sales for 30/60/90 days

```sql
SELECT
  d.FTPdtCode,
  SUM(d.FCSdtQty * d.FCSdtStkFac) AS sold_qty_30d
FROM TPSTSalHD h
JOIN TPSTSalDT d
  ON h.FTBchCode = d.FTBchCode
 AND h.FTShdDocNo = d.FTShdDocNo
WHERE h.FDShdDocDate >= DATEADD(day, -30, GETDATE())
  AND h.FDShdDocDate <= GETDATE()
GROUP BY d.FTPdtCode;
```

### Step 3. Calculate stock day and status

```text
avg_daily = sold_qty_30d / 30
stock_day = stock_now / avg_daily

IF stock_now <= FCPdtMin
  THEN "Reorder soon"
ELSE IF stock_day is extremely high OR stock_now >= FCPdtMax
  THEN "Overstock / slow moving"
ELSE
  "Normal"
```

### Step 4. Final worksheet columns

- `product_code`
- `product_name`
- `barcode`
- `unit`
- `current_stock`
- `sold_30d`
- `avg_daily_usage`
- `stock_day`
- `purchased_qty_period`
- `min_stock`
- `max_stock`
- `lead_time_days`
- `supplier`
- `status`

## Claude Prompt Version

Use this when handing the findings to another coding agent.

```text
Use this confirmed database understanding as ground truth. Do not rescan broadly unless needed to verify a specific field/table.

Goal:
Build the simplest V1 workflow for worksheet `สั่งสินค้า` to calculate `stock day` for management.

Confirmed business rule:
- Use stock day / days of stock
- Do not build AI or forecasting
- Use rule-based calculations only

Confirmed source system:
- ADA-SOFT Thai Retail POS
- SQL Server database: `AdaAcc`

Confirmed available data:
1. Product master: `TCNMPdt`
2. POS demand / sell-out: `TPSTSalHD` + `TPSTSalDT`
3. HQ purchase / order-in: `TACTPiHD` + `TACTPiDT`
4. Branch transfer data: `TCNTPdtTnfHD` + `TCNTPdtTnfDT`
5. Stock movement log: `TCNTPdtStkCard`

Confirmed non-usable / not used:
- `TCNTPdtReqHD/DT` = 0 rows
- `TACTPoHD/DT` = 0 rows
- `TCNMPdtBar` = empty
- `TCNMRateUnit` is currency rounding only

Important rules:
- Demand signal must come from POS sales
- Normalize all transaction qty using `qty * stock_factor`
- Do not sum mixed units without normalization
- Watch for Thai Buddhist Era date anomalies in POS data
- `FCPdtQtyNow` is likely global stock, not per-branch stock

Required formulas:
- Average Daily Usage = sold_qty / period_days
- Stock Day = current_stock / average_daily_usage
- Ending Stock = starting_stock + purchased_qty - sold_qty
- Average Inventory = (starting_stock + ending_stock) / 2
- Turnover Rate = sold_qty / average_inventory

Build scope for now:
- Global-level stock day is enough for V1
- Use `TCNMPdt` + `TPSTSalHD/DT` first
- Add `TACTPiHD/DT` only if needed for purchased/order-in visibility
- Do not attempt branch-level stock day unless necessary

Expected output:
1. Recommend the exact minimal SQL/views/dataset needed for worksheet `สั่งสินค้า`
2. Define final output columns
3. Define status rules:
   - `Reorder soon`
   - `Normal`
   - `Overstock / slow moving`
4. Keep the solution simple and understandable for management
5. Do not propose AI, forecasting, or unnecessary architecture
```
