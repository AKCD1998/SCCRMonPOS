---
name: SC-StockDay-Ordering — Transfer Reconciliation Layer design document
description: Full architecture audit and design spec for adding inter-branch transfer reconciliation to the SC-StockDay-Ordering Node.js/React/PostgreSQL project. Includes DB schema, API routes, UI pages, integrity rules, POS relationship, roadmap, and risks.
type: project
originSessionId: external-audit-3
---

## Project identity
**SC-StockDay-Ordering** — a separate project from SCCRMonPOS.
Stack: Node.js 18 / Express / React 18 + Vite / PostgreSQL (Render.com) / monorepo.

---

## 1. Current stack (exact files)
| Layer | Technology | File |
|---|---|---|
| Frontend (admin) | React 18 + Vite | `apps/admin-web/src/App.jsx` |
| Frontend (branch) | React 18 + Vite | `apps/order-web/src/App.jsx` |
| Backend API | Express.js Node 18 | `server/src/index.js` |
| Database | PostgreSQL (Render.com) | `server/db/migrations/001_init.sql` |
| POS sync service | Node.js, reads SQL Server | `apps/adapos-sync/src/index.js` |
| Data mode | mock (active) | `.env` → `DATA_MODE=mock` |

## 2. Existing database tables (migration 001)
| Table | Purpose | Key fields |
|---|---|---|
| `branches` | Branch registry | `branch_code`, `branch_name`, `is_hq` |
| `products` | Product/SKU master synced from AdaAcc | `product_code`, `barcode_1/2/3`, `unit_small/medium/large`, `factor_small/medium/large`, `stock_current`, `min_stock`, `max_stock`, `lead_time_days`, `supplier_code` |
| `product_stock_snapshots` | Time-stamped stock history | `product_code`, `snapshot_at`, `stock_current` |
| `product_sales_summary` | Sales aggregates | `sold_qty_base`, `avg_daily_usage` |
| `product_purchase_summary` | Purchase aggregates | `purchased_qty_base` |
| `branch_order_requests` | Branch requests goods from HQ | `branch_code`, `requested_by`, `status` (only: `submitted`) |
| `branch_order_request_items` | Line items per order request | `product_code`, `requested_qty`, `requested_unit` |
| `staff_accounts` | User registry | `id`, `email`, `full_name`, `role` (admin/branch_staff), `branch_code` |
| `sync_runs` | Sync audit log | `sync_type`, `status`, `records_read`, `records_sent` |
| `sync_errors` | Sync error log | `error_message`, `error_details` JSONB |

## 3. Existing API routes (server/src/routes.js)
```
GET  /api/branches
GET  /api/products/search?q=
POST /api/order-requests
GET  /api/order-requests/:id
GET  /api/admin/order-requests
GET  /api/admin/stock-day
GET  /api/admin/products/:productCode/summary
GET  /api/admin/sync-status
POST /api/sync/products
POST /api/sync/sales-summary
POST /api/sync/purchase-summary
POST /api/sync/run-log
```

## 4. AdaPOS sync service — confirmed AdaAcc tables read
- `TCNMPdt` — product master (`queries.js:2-25`)
- `TPSTSalHD` + `TPSTSalDT` — sales header + detail
- `TACTPiHD` + `TACTPiDT` — purchase/goods-received header + detail
- Currently in dry-run mode with placeholder SQL. Real implementation pending on mother PC.

## 5. What is NOT in the project yet
- Authentication (intentional — `requestedBy: "Placeholder Staff"` hardcoded in `order-web/src/App.jsx:69`)
- Transfer workflow
- QR code generation / printing
- File / photo upload
- Approval logic
- Discrepancy handling
- Branch-level stock (global stock only, per `ARCHITECTURE.md:13`)

---

## 6. Transfer reconciliation verdict
**Yes — ready to extend. No refactor needed. Add new tables + new routes only.**

Philosophy already correct: "Orders are stored in our own app and do not write directly to adaPOS." (README)

**Two prerequisites before writing transfer code:**
1. Implement authentication (staff must be identified before confirming anything)
2. Switch `DATA_MODE=postgres` and confirm live DB connection is stable

---

## 7. What can be reused
| Component | Status | Where |
|---|---|---|
| Branch table | ✅ Exists | `branches` |
| Product master + barcode + unit | ✅ Exists | `products` |
| Unit conversion factors | ✅ Exists | `products.factor_small/medium/large` |
| Staff/user registry with roles | ✅ Table exists | `staff_accounts` |
| Branch code on staff account | ✅ Exists | `staff_accounts.branch_code` |
| HQ flag on branch | ✅ Exists | `branches.is_hq` |
| Transaction pattern in Postgres | ✅ Used | `postgresRepository.js:139-210` |
| Product stock snapshots | ✅ Exists | `product_stock_snapshots` |
| Mock/real mode switch | ✅ Useful | `DATA_MODE` in config |
| Express router pattern | ✅ Clean | `routes.js` |
| JSONB error detail storage | ✅ In use | `sync_errors.error_details` |
| Authentication | ❌ Missing | Critical prerequisite |
| QR code generation | ❌ Missing | Add `qrcode` npm package |
| PDF printing | ❌ Missing | Add `pdfkit` |
| File/photo upload | ❌ Missing | Add Cloudinary or Render disk |
| Approval workflow | ❌ Missing | Must build |

---

## 8. Integration level recommendation
| Level | What it means | Verdict |
|---|---|---|
| Level 1 — Manual truth-layer | Our system records transfers; staff manually do POS entry; we store POS doc number | **Start here** |
| Level 2 — CSV import reconciliation | Import POS stock/transaction data, compare with transfer records | Prepare data model now; implement Phase 4 |
| Level 3 — RPA/AutoHotkey | Script automates POS data entry | Too risky for Phase 1 |
| Level 4 — Direct POS DB write | Write directly into AdaAcc | **Do not do this.** Read-only is the correct boundary. |

---

## 9. Database design — Migration 002
```sql
CREATE TABLE IF NOT EXISTS transfer_headers (
  id                TEXT PRIMARY KEY,
  transfer_no       TEXT UNIQUE NOT NULL,        -- e.g. "TR-000-20260519"
  from_branch_code  TEXT NOT NULL REFERENCES branches(branch_code),
  to_branch_code    TEXT NOT NULL REFERENCES branches(branch_code),
  status            TEXT NOT NULL DEFAULT 'DRAFT'
                    CHECK (status IN (
                      'DRAFT','REQUESTED','PACKED','IN_TRANSIT',
                      'RECEIVED_MATCHED','RECEIVED_WITH_DISCREPANCY',
                      'APPROVED_CORRECTION','CLOSED','CANCELLED'
                    )),
  note              TEXT,
  created_by        TEXT NOT NULL REFERENCES staff_accounts(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_different_branches CHECK (from_branch_code <> to_branch_code)
);

CREATE TABLE IF NOT EXISTS transfer_lines (
  id              TEXT PRIMARY KEY,
  transfer_id     TEXT NOT NULL REFERENCES transfer_headers(id),
  product_code    TEXT NOT NULL REFERENCES products(product_code),
  unit            TEXT NOT NULL,
  requested_qty   NUMERIC(14,4) NOT NULL DEFAULT 0,
  packed_qty      NUMERIC(14,4),
  received_qty    NUMERIC(14,4),
  discrepancy_qty NUMERIC(14,4)
                  GENERATED ALWAYS AS (received_qty - packed_qty) STORED,
  lot_no          TEXT,
  expiry_date     DATE,
  line_note       TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS transfer_events (
  -- IMMUTABLE: never delete or update rows in this table
  id            TEXT PRIMARY KEY,
  transfer_id   TEXT NOT NULL REFERENCES transfer_headers(id),
  event_type    TEXT NOT NULL CHECK (event_type IN (
    'CREATED','EDITED','REQUESTED','PACKED','DISPATCHED','RECEIVED',
    'DISCREPANCY_NOTED','CORRECTION_APPROVED','CORRECTION_REJECTED',
    'CLOSED','CANCELLED','POS_REFERENCE_ADDED','PHOTO_ADDED'
  )),
  old_value     JSONB,
  new_value     JSONB,
  staff_id      TEXT NOT NULL REFERENCES staff_accounts(id),
  reason        TEXT,
  ip_address    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS transfer_discrepancies (
  id            TEXT PRIMARY KEY,
  transfer_id   TEXT NOT NULL REFERENCES transfer_headers(id),
  line_id       TEXT NOT NULL REFERENCES transfer_lines(id),
  expected_qty  NUMERIC(14,4) NOT NULL,
  received_qty  NUMERIC(14,4) NOT NULL,
  diff_qty      NUMERIC(14,4) NOT NULL,
  diff_reason   TEXT,
  status        TEXT NOT NULL DEFAULT 'PENDING'
                CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  reviewed_by   TEXT REFERENCES staff_accounts(id),
  reviewed_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS transfer_attachments (
  id            TEXT PRIMARY KEY,
  transfer_id   TEXT NOT NULL REFERENCES transfer_headers(id),
  event_type    TEXT NOT NULL,   -- 'PACK_PHOTO','RECEIVE_PHOTO','DOCUMENT_SCAN'
  file_url      TEXT NOT NULL,
  uploaded_by   TEXT NOT NULL REFERENCES staff_accounts(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS transfer_pos_references (
  id               TEXT PRIMARY KEY,
  transfer_id      TEXT NOT NULL REFERENCES transfer_headers(id),
  pos_document_no  TEXT NOT NULL,
  pos_type         TEXT NOT NULL
                   CHECK (pos_type IN ('STOCK_ADJUST','TRANSFER_OUT','TRANSFER_IN')),
  branch_code      TEXT NOT NULL REFERENCES branches(branch_code),
  recorded_by      TEXT NOT NULL REFERENCES staff_accounts(id),
  recorded_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  note             TEXT
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_transfer_headers_status ON transfer_headers(status);
CREATE INDEX IF NOT EXISTS idx_transfer_headers_from_branch ON transfer_headers(from_branch_code);
CREATE INDEX IF NOT EXISTS idx_transfer_headers_to_branch ON transfer_headers(to_branch_code);
CREATE INDEX IF NOT EXISTS idx_transfer_lines_transfer ON transfer_lines(transfer_id);
CREATE INDEX IF NOT EXISTS idx_transfer_events_transfer ON transfer_events(transfer_id);
CREATE INDEX IF NOT EXISTS idx_transfer_events_staff ON transfer_events(staff_id);
CREATE INDEX IF NOT EXISTS idx_transfer_discrepancies_transfer ON transfer_discrepancies(transfer_id);
```

---

## 10. API routes to add (server/src/routes.js)
```
POST   /api/transfers                               create (DRAFT)
GET    /api/transfers/:id                           get detail
GET    /api/transfers?status=&branch=&date=         list with filters
PATCH  /api/transfers/:id/request                   DRAFT → REQUESTED
PATCH  /api/transfers/:id/pack                      REQUESTED → PACKED
PATCH  /api/transfers/:id/dispatch                  PACKED → IN_TRANSIT
PATCH  /api/transfers/:id/receive                   IN_TRANSIT → RECEIVED_*
GET    /api/transfers/pending/:branchCode           all IN_TRANSIT for this branch
GET    /api/transfers/:id/discrepancies
PATCH  /api/discrepancies/:id/approve               manager only
PATCH  /api/discrepancies/:id/reject                manager only
PATCH  /api/transfers/:id/close
POST   /api/transfers/:id/attachments               upload photo
GET    /api/transfers/:id/attachments
POST   /api/transfers/:id/pos-references            record POS doc number
GET    /api/transfers/:id/pos-references
GET    /api/transfers/:id/events                    immutable audit trail
GET    /api/admin/transfers/reconciliation          summary report
GET    /api/admin/transfers/pending-pos             closed but no POS ref
```

---

## 11. UI pages to build
| Page | Who uses it | Key actions |
|---|---|---|
| Transfer Dashboard | Admin/HQ | Count by status, overdue in-transit, pending approvals |
| Create Transfer | Branch A (sender) | Select branches, add product lines, save DRAFT |
| Packing Screen | Branch A (packer) | Enter actual packed qty, attach photo, mark PACKED → DISPATCHED |
| Printable QR Document | Branch A | Transfer no., QR code, product list, packed qty, lot, from/to |
| Pending Transfers Inbox | Branch C | All IN_TRANSIT addressed to this branch |
| Receiving Screen | Branch C | Scan QR or enter transfer no., enter actual received qty |
| Discrepancy Approval | Manager/Admin | Expected vs actual per line, approve/reject with reason |
| Transfer Detail + Events | Any staff | Full immutable timeline |
| Transfer History | Admin | Search by branch, date, product, status |
| Reconciliation Report | Admin | Status, matched/discrepancy, POS ref Y/N, overdue flag |
| Pending POS Reference | Admin | CLOSED transfers with no POS doc number recorded |

---

## 12. Data integrity rules (enforced in API layer)
1. `transfer_events` rows are never updated or deleted — append-only
2. Status moves forward only: `DRAFT → REQUESTED → PACKED → IN_TRANSIT → RECEIVED_* → APPROVED_CORRECTION → CLOSED` (except CANCELLED with manager approval after IN_TRANSIT)
3. `packed_qty` is locked once status = IN_TRANSIT
4. `received_qty` is locked once receive is submitted
5. Discrepancy approval requires non-empty `reason` field — API rejects without it
6. Every status-changing PATCH must include authenticated `staff_id`
7. POS reference is informational in Phase 1 (not blocking CLOSED) — flagged in reconciliation report
8. `product_code` on transfer lines must exist in `products` table (FK enforced)
9. Qty stored with unit label; normalized to base unit for discrepancy calculation using `products.factor_*`

---

## 13. POS relationship
- **Do not write to AdaAcc.** Read-only is already the correct boundary in this project.
- Level 1: Staff record in our system → manually enter AdaPOS stock adjustment → record AdaPOS doc number back in our system.
- Level 2 (Phase 4): Extend `adapos-sync` to pull stock adjustment tables from AdaAcc. Likely tables to verify on the mother PC:
```sql
SELECT TOP 5 * FROM TCNTStAdjHD;  -- stock adjustment header
SELECT TOP 5 * FROM TCNTStAdjDT;  -- stock adjustment detail
SELECT TOP 5 * FROM TCNTTrfHD;    -- transfer header (if exists)
SELECT TOP 5 * FROM TCNTTrfDT;    -- transfer detail (if exists)
```
- Do NOT automate POS write (Level 3/4) until Level 1 has run cleanly for 3+ months.

---

## 14. Implementation roadmap
| Phase | Scope | Est. time |
|---|---|---|
| **1** | JWT auth + transfer CRUD (create/pack/dispatch/receive) + migration 002 | 4–6 weeks |
| **2** | QR code generation (`qrcode` npm), printable PDF (`pdfkit`), QR scanner on receiving screen (`html5-qrcode`) | 2–3 weeks |
| **3** | Discrepancy approval UI, photo upload (Cloudinary), POS reference recording, manager approval events | 2–3 weeks |
| **4** | Extend adapos-sync to import AdaAcc stock adjustments, reconciliation comparison logic, reconciliation report | 3–4 weeks |
| **5** | Require POS ref before CLOSED, LINE/email alerts for pending approval, branch-level stock reconstruction, offline support | ongoing |

**Smallest safe version that delivers real value:** Phase 1 + Phase 2, one branch pair first (HQ → Branch 000). Three features only: create → pack + print QR → receive + record qty. Discrepancy is visible immediately. Stops fake correction transfer pattern.

---

## 15. Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Staff skip system, keep using paper | High | High | Phone-friendly UI, QR scan = one action |
| Auth not ready → anonymous approvals | High (if skipped) | Critical | Do not deploy Phase 1 without login |
| Product code mismatch vs AdaPOS | Medium | High | FK enforced; verify unit/factor before comparing qty |
| Unit conversion error (กล่อง vs แผง) | Medium | High | Always store base unit qty using `factor_*` columns |
| Stock snapshot stale | Medium | Medium | Label "as of [timestamp]" clearly in UI |
| POS doc number recorded wrong | Medium | Medium | Reconciliation report detects mismatch in Phase 4 |
| Manager approves without investigating | Medium | High | Require minimum reason text + log IP + show full history |
| Staff enter received = packed to avoid paperwork | Medium | High | Phase 2 photo adds friction; culture issue too |
| Offline branch can't load receiving screen | Low (Phase 1) | Medium | Cloud-only constraint; document it in Phase 1 rollout |
| PostgreSQL on Render free tier sleeps | Low | Medium | Upgrade to paid instance before live deployment |
| Duplicate transfer created by mistake | Low | Low | Unique `transfer_no` constraint; UI warns on same branch pair + same day |
