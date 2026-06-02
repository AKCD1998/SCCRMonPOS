# SCCRMonPOS

POS companion agent for FRONT2. Bridges AdaPos HyperMart 4.6006.30 to the SCCRM loyalty backend.

---

## Known Pain Points — Current Local POS Infrastructure

Documented during forensic inspection of AdaPos HyperMart 4.6006.30 on POSSRV (2026-05-18).
**Do not reproduce any of these in the next POS build.**

### 1. SA credentials stored in a plaintext INI file

`D:\AdaSoft\AdaPos4.0HpmFhn\AdaPos\AdaPurge.ini` contains the SQL Server `sa` (superuser)
username and password in plain text. Any user or process with read access to that folder
has full control of the database server — including the ability to drop tables or export
all sales and customer data.

**Next build:** Store database credentials encrypted (DPAPI, Windows Credential Manager,
or a secrets vault). Never ship a config file with credentials committed or readable by
non-admin accounts.

### 2. SQL Server superuser account (`sa`) used as the application account

AdaPos connects to SQL Server using the `sa` account — the built-in superuser with
unrestricted permissions on every database on the server. There is no least-privilege
principle applied anywhere.

**Next build:** Create a dedicated application login with only the permissions it needs
(e.g. `SELECT`/`INSERT` on specific tables). The `sa` account should be disabled or
renamed and never used by application code.

### 3. Default vendor password never changed

The `sa` password was the AdaSoft vendor default (`adasoft`), unchanged since installation.
Vendor defaults are publicly known and the first thing any attacker tries.

**Next build:** Enforce a password change on first deployment. Automate a check that
fails startup if a known-default credential is detected.

### 4. SQL Server port exposed on the LAN with no firewall rule

SQL Server Express on POSSRV listens on TCP port 49683 (dynamic) with no host firewall
restricting which IPs can connect. Any device on the 192.168.0.x network — including
phones connected to shop WiFi — can attempt a direct database connection.

**Next build:** Firewall the database port to allow only the specific POS terminal IPs.
Never expose a database port to a flat LAN that includes guest or customer WiFi.

### 5. POS network not isolated from general LAN

The POS terminals (FRONT2 at 192.168.0.129) and the database server (POSSRV at
192.168.0.127) sit on the same flat /24 subnet as other devices. There is no VLAN
separation between POS infrastructure and the rest of the network.

**Next build:** Put POS terminals and the DB server on a dedicated VLAN with strict
inter-VLAN routing rules. Customer WiFi must never be on the same broadcast domain
as POS equipment.

### 6. No read/write separation for integrations

Because no read-only account exists, any integration (including this one — SCCRMonPOS)
that needs to read sales data must either use `sa` or have credentials that also allow
writes. There is no safe way to grant a third-party service read-only access.

**Next build:** Design the DB schema with integration consumers in mind from day one.
Provide a documented, read-only view or API surface. Never require integrators to use
admin credentials.

---

## AdaPos HyperMart 4.6006.30 — Forensic Inspection Notes

Inspected 2026-05-18 on FRONT2 (192.168.0.129) against POSSRV\SQLEXPRESS (192.168.0.127:49683),
database `AdaAcc`. Saved here as a reference for building the next POS system from scratch.

### Infrastructure

| Item | Value |
|------|-------|
| Executable | `D:\AdaSoft\AdaPos4.0HpmFhn\AdaPos\AdaPosFront.exe` |
| Database engine | Microsoft SQL Server 2008 R2 Express (`POSSRV\SQLEXPRESS`) |
| Database name | `AdaAcc` |
| DB server IP | `192.168.0.127`, TCP port `49683` (dynamic, found via UDP 1434 SQL Browser) |
| Credentials | `sa` / `adasoft` (plaintext in `AdaPurge.ini`) |
| Secondary DB | `Sky.mdb` (Jet/Access, used by AdaSky sync agent only — not live POS data) |
| ODBC DSNs | None configured — AdaPos connects via direct TCP |
| Other DB engines | None (no MySQL, Firebird, Postgres services running) |

### Key Tables — Transactional Core (fully mapped)

| Table | Rows | Purpose |
|-------|------|---------|
| `TPSTSalHD` | 1,173 | Sale header — one row per completed receipt |
| `TPSTSalDT` | 2,633 | Sale line items — one row per product per receipt |
| `TPSTSalRC` | 1,175 | Payment detail — payment method, amount, PromptPay ref |
| `TPSTVoidDT` | 189 | Mid-checkout item removals (not cancelled bills — those never reach the DB) |
| `TPSTHoldHD` / `TPSTHoldDT` | 0 | Parked bills — live in POS RAM only, never written to DB |
| `TPSMRcv` | 13 | Payment method master (cash, PromptPay, card, coupon, etc.) |
| `TEJTJOURNAL` | 1,786 | Electronic journal index |
| `TPSTLogIn` | 89 | Cashier shift open/close log |

### Sale Header — Column Reference (`TPSTSalHD`)

| Column | Meaning |
|--------|---------|
| `FTShdDocNo` | Receipt number (`S…` = sale, `R…` = return) |
| `FTShdDocType` | `'1'` = normal sale, `'9'` = return |
| `FTShdStaPaid` | Always `'3'` for any committed row (paid/finalized) |
| `FTShdStaRefund` | `'1'` = not returned, `'2'` = has a return against it |
| `FTShdPosCN` | On return receipts: the original sale receipt number |
| `FDDateIns` + `FTTimeIns` | Insert timestamp — use as polling watermark |
| `FDShdDocDate` + `FTShdDocTime` | Document timestamp (identical to insert time in practice) |
| `FTPosCode` | POS terminal ID (`001`, `002`) |
| `FTUsrCode` | Cashier login code |
| `FCShdGrand` | Total paid after all discounts — use for loyalty points calculation |
| `FCShdDis` | Header-level discount amount |
| `FCShdMnyCsh` | Cash portion of payment |
| `FCShdChn` | Change given back to customer |
| `FTBchCode` | Branch code |

### Sale Line Items — Column Reference (`TPSTSalDT`)

| Column | Meaning |
|--------|---------|
| `FTShdDocNo` | Links to header |
| `FNSdtSeqNo` | Line sequence number |
| `FTPdtCode` | Product code / SKU |
| `FTPdtName` | Product name |
| `FTSdtBarCode` | Barcode (EAN/UPC) |
| `FCSdtQty` | Quantity |
| `FCSdtSalePrice` | Shelf price before promotion |
| `FCSdtSetPrice` | Actual charged price after promotion — use for per-line analytics |
| `FCSdtNet` | Net line amount — use for loyalty points per product |
| `FCSdtDis` | Per-line explicit discount |
| `FCSdtRePackAvg` / `FCSdtDisAvg` | Allocated share of header discount |
| `FTPmhCode` | Promotion rule code that caused any discount |

### Payment Methods (`TPSMRcv`)

| Code | Method | Notes |
|------|--------|-------|
| `001` | Cash (เงินสด) | Most common |
| `002` | Credit card | Configured, 0 uses observed |
| `013` | PromptPay (พร้อมเพย์) | QR payment — second most common |
| `008` | Voucher (บัตรกำนัล) | Configured |
| `012` | Alipay | Configured |
| Others | Cheque, transfer, hire purchase, store debit | Configured but unused |

For PromptPay, the QR payment reference is in `TPSTSalRC.FTSrcRef`.
The header columns `FCShdMnyCsh`/`FCShdMnyCrd` are zero for PromptPay — must join `TPSTSalRC` to get the amount.

### Checkout Flow Outcomes

| Scenario | What happens in the DB |
|----------|----------------------|
| Normal paid sale | New row in `TPSTSalHD` with `FTShdDocType='1'`, `FTShdStaPaid='3'` |
| Item voided mid-checkout | Row in `TPSTVoidDT` linked to the final receipt — sale still completes normally |
| Bill cancelled before payment | Nothing written to DB — row never created |
| Bill parked (พักบิล Ctrl+F7) | Stored in `TPSTHoldHD`/`TPSTHoldDT` in RAM — if recalled and paid, becomes normal sale; if abandoned, leaves no trace |
| Return/refund | New `FTShdDocType='9'` receipt with `R…` doc number; `FTShdPosCN` = original receipt; original receipt `FTShdStaRefund` → `'2'` |

### Polling Query (integration watermark)

```sql
SELECT h.FTShdDocNo, h.FTShdDocType, h.FTPosCode, h.FTUsrCode,
       h.FDShdDocDate, h.FTShdDocTime, h.FDDateIns, h.FTTimeIns,
       h.FCShdGrand, h.FCShdDis, h.FCShdMnyCsh, h.FCShdChn,
       h.FTShdStaRefund, h.FTShdPosCN
FROM TPSTSalHD h
WHERE (h.FDDateIns > @lastDate)
   OR (h.FDDateIns = @lastDate AND h.FTTimeIns > @lastTime)
ORDER BY h.FDDateIns, h.FTTimeIns
-- Do NOT use FDDateUpd/FTTimeUpd as trigger — updated again by batch jobs hours later
```

### Gaps — Not Yet Inspected (priority order for next session)

1. **`TCNMCst` (1,288 rows) — customer master** ← most critical gap
   Schema unknown. `FTCstCode` appears on sale headers but its format is unknown (numeric ID? phone? barcode?).
   Cannot build the AdaPos-to-CRM customer linkage until this is read.

2. **`TSysConfig` (372 rows) — system configuration**
   Almost certainly contains: branch name, points earn rate, VAT rate, rounding rules.
   Integration logic should derive these from here rather than hardcoding.

3. **`D:\AdaSoft\AdaPos4.0HpmFhn\AdaDB\Source_SQL\` — schema creation scripts**
   Authoritative column-level documentation for every table including those with 0 rows.
   Reading these fills all remaining schema gaps in one pass.

4. **`TCNTCstPoint` (17 rows) — points transaction log**
   Only 17 rows against 1,173 sales — likely manual adjustments, not the primary points ledger.
   Schema and purpose unknown.

5. **`TCNMPdt` (6,661 rows) — product master**
   Product categories, eligibility flags (alcohol, tobacco, lottery exclusions), price levels.
   Needed for points-exclude logic in the next build.

6. **`TPSTLogInDT` (868 rows) — shift detail log**
   Likely drawer open/close, float counts, cash declarations. Relevant for shift reconciliation.

7. **`TCON001` / `TCON002` (186 rows each) — purpose unknown**

8. **`TTmpSlpSignOut` (26 rows) — likely end-of-shift summary slip**

9. **`FNShdSign = 1` on 7 sale headers** — meaning unknown, possibly supervisor-override flag

10. **AdaSky FTP sync format** — what data is zipped and sent to HQ nightly, and whether HQ pushes loyalty data back via the INBOX path

11. **AdaMonitor component** — purpose unknown, may expose a real-time event socket

### System Architecture — Hub and Spoke

**AdaPosFront.exe** (cashier terminal, FRONT2) and **AdaPosBack.exe** (back-office management, installed on POSSRV or a separate admin PC) connect to the exact same `AdaAcc` database on `POSSRV\SQLEXPRESS` using the same `sa`/`adasoft` credentials. There is only one operational database. The front writes sales into it; the back reads from it for reporting, inventory, and customer management. There is no reporting replica or second database.

**Data flow — branch ↔ HQ:**

| Direction | Mechanism | What moves | Timing |
|-----------|-----------|------------|--------|
| Branch → HQ | AdaSky FTP to `httpdocs/scgroup/005` | Sales transactions, audit logs | Nightly batch |
| HQ → Branch | FTP push back down | Product master, barcodes, prices | Nightly — can lag 1–2 days |

**Why the HQ sync lag does not affect the CRM integration:**

The CRM integration never reads from the product master (`TCNMPdt`) for points calculations. It reads `FCSdtSetPrice` and `FCSdtNet` from `TPSTSalDT` — the actual prices charged to the customer at the moment of sale, already baked into the receipt row at payment time. Whatever the POS billed is what the DB contains. A stale product master has zero effect on loyalty point accuracy.

The only scenario where a stale product master could matter is if the CRM needs to categorize products for points eligibility (e.g., exclude alcohol, double points on a department) and a category flag changed overnight before the sync ran. In practice, categories almost never change — only prices and new barcodes do. This is not a real operational risk.

**Effective data latency for CRM purposes:**

| Data needed | Source | Latency |
|-------------|--------|---------|
| What was sold | `TPSTSalDT.FCSdtNet` | Zero — written at payment confirmation |
| What was paid | `TPSTSalRC.FCSrcAmt` | Zero — written at payment confirmation |
| Who bought it | `TPSTSalHD.FTCstCode` | Zero — written at payment confirmation |
| Points calculation | Derived from net amount | Zero |

The CRM integration reads from local `AdaAcc` and is effectively real-time. AdaPosBack.exe sees the same rows at the same time — going through it gains nothing for live data.

**What AdaPosBack.exe is still worth inspecting for:**

- Its INI/config files may confirm there is no second DB or reporting mirror
- Its `Source_SQL` scripts may be more complete than the front-office copy — fastest path to full schema documentation
- The back-office UI reads `TSysConfig` and presents its 372 rows as labeled settings — its source or INI may name those config keys, filling the interpretation gap

### Notes for Next POS Build

- Every committed row in the sale header is a real paid transaction. No staging rows, no draft state visible in the DB. Design your own schema the same way — write atomically on payment confirmation.
- Cancelled bills never reach the DB in AdaPos. Design your system the same way — only persist what is actually paid.
- AdaPos uses `FDDateIns`/`FTTimeIns` (date + separate time string) as its insert timestamp. In the next build use a single `DATETIME2` or `TIMESTAMPTZ` column — split date/time fields are a source of subtle bugs in watermark queries.
- Returns are new receipts with a back-reference to the original, not modifications of the original. This is the correct pattern — never mutate a completed financial record.
- The electronic journal (`TEJTJOURNAL`) exists but its binary `.EJ` files on disk were not decoded. Consider a structured audit log from day one so integrations don't need to reverse-engineer a binary format.
