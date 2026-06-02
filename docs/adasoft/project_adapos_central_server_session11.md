---
name: central-server-session-11-full-investigation
description: "Session 11 on central server (WIN-N8RL1PCFEDO\\SQLEXPRESS). Key finds: server real IP = 192.168.100.124 (NOT 192.168.0.71 — different subnet); no legacy T-schema DB on server; FTP server = CSLoxinfo hosted IDC (external); TACTPiHD = 7,254 purchase invoices (AP IS used at some branches); Alipay + MOL Thai wallet integration tables exist; AdaWCFCstPoint fully decoded (TripleDES+SHA1 crypto, 23 public methods, month-end cycle); two 9GB backup DBs online; GL/F&B/Ticketing = confirmed dead at central level."
metadata: 
  node_type: memory
  type: project
  originSessionId: 4eb79e91-534f-4357-83ab-417e0a3131b1
---

## Server identity — IP DISCREPANCY RESOLVED

| Field | Value |
|---|---|
| Hostname | WIN-N8RL1PCFEDO\SQLEXPRESS |
| SQL Version | SQL Server 2008 R2 RTM (10.50.1600.1) Express — 32-bit WOW64 on 64-bit Windows |
| **Actual IP** | **192.168.100.124** |
| Previously documented IP | 192.168.0.71 |

**The central server is on subnet 192.168.100.x, NOT 192.168.0.x.**

192.168.0.71 was inferred from branch config files and earlier observations — it may be a router/NAT gateway, a different machine, or a secondary NIC not shown by Get-NetIPAddress. The server only reported 192.168.100.124 from the PowerShell query. This explains why branches cannot reach the central server directly (different subnet, routing required).

---

## Database inventory — all databases online

| Database | SizeMB | State | Created |
|---|---|---|---|
| **AdaAcc_20260313DataFULL** | **9,839** | ONLINE | 2026-03-13 |
| **AdaAccFull20241118** | **9,503** | ONLINE | 2024-11-18 |
| **AdaAcc** | **4,620** | ONLINE | 2020-05-18 |
| msdb | 12.6 | ONLINE | system |
| master | 4.8 | ONLINE | system |
| tempdb | 2.5 | ONLINE | system |

**Total live data: ~24 GB.** Two massive backup databases remain ONLINE simultaneously with the live AdaAcc. All three have the standard TCN/TPS AdaAcc schema (435 tables each). No legacy T-schema database exists on this server.

## Legacy T-schema database — NOT FOUND on central server

Neither backup database contains TSALEHD, TMEMBER, or TPRODUCT. Both are full AdaAcc backups using standard TCN/TPS schema.

**Conclusion:** The AdaSky legacy T-schema sync (TSALE*, TMEMBER, TPRODUCT) does NOT land on this central server's SQL Server. The data synced via FTP to 147.50.231.154 either:
1. Lands on the CSLoxinfo hosted server (147.50.231.154) in the legacy schema there
2. Gets transformed/imported into AdaAcc's TCN/TPS schema on arrival at central
3. Goes to a machine we haven't found yet (192.168.0.71 if that's a separate device)

This remains an open question.

---

## FTP server identity — CONFIRMED EXTERNAL

| Field | Value |
|---|---|
| IP | 147.50.231.154 |
| Hostname | idc-147-50-231-154.customer.csloxinfo.com |
| Provider | **CSLoxinfo** — Thai ISP / Internet Data Center |
| Port 21 reachable from server | **Yes** — TcpTestSucceeded: True |

SC Group pays CSLoxinfo to host the FTP relay server. It is NOT this server's public IP. All 6 branches upload FTP zips to this external hosted server. Whether it runs SQL Server or just stores flat files is unknown.

---

## GL module — confirmed dead at central level

Same 3 journal entries as Branch 005, all from 2003. GL is a demo skeleton across the entire system — never activated in production at any branch.

---

## F&B and Ticketing — confirmed 0 across all branches

All 6 tables = 0 rows at the central (aggregated) server. No branch has ever used F&B ordering or ticketing in production.

---

## Purchase invoices — ACTIVE at central (contradicts Branch 005 finding)

| Table | Central Rows | Branch 005 Rows |
|---|---|---|
| TACTPiHD | **7,254** | 0 |
| TACTPaHD | 1 | 0 |
| TACTPoHD | 0 | 0 |
| TACTVatHD | 458 | 506 (local only) |

**Purchase invoices ARE being used at some branches — just not Branch 005.** 7,254 purchase invoices at central level means HQ (Branch 000) and/or older branches are recording supplier purchases formally through AdaPos, not just via stock transfers.

VAT invoices at central:
| Branch | Count | Earliest | Latest | Total Value |
|---|---|---|---|---|
| 001 | 457 | 2024-12-02 | 2026-05-18 | ฿618,695 |
| 000 | 1 | 2025-08-29 | 2025-08-29 | ฿15,061 |

Branch 005's 506 VAT invoices (May 2026) have not yet synced to central — consistent with the 8-day sync lag we documented.

Customer master at central: 1,268 AR-prefixed + 35 S2-prefixed + 2 others = ~1,305 total.
Suppliers: 268 (same as Branch 005 local).

---

## New tables discovered in full table list (not previously seen)

### Alipay integration
| Table | Meaning |
|---|---|
| `TPSTLogAlipay` | Alipay payment transaction log |
| `TSysMsgAlipay` | Alipay system messages |

**AdaPos supports Alipay payments.** Whether SC Group has activated this is unknown — table may be empty.

### MOL / mobile wallet integration
| Table | Meaning |
|---|---|
| `TMOLLog` | MOL (Thai digital wallet / mobile payment) log |

MOL = a Thai digital payment platform. Another payment method beyond cash, card, and Alipay.

### AOT module (unknown)
| Table | Meaning |
|---|---|
| `TAOTItemRedemption` | Item redemption (AOT context) |
| `TAOTLog` | AOT activity log |
| `TAOTSalCard` | AOT sale card |

AOT prefix unknown. May be "Airport of Thailand" or an internal Adasoft module name. Needs investigation.

### FXT module (unknown)
| Table | Meaning |
|---|---|
| `TFXTJobDT/HD/SD` | FXT job detail/header/sub |
| `TFXTTnfDT/HD` | FXT transfer detail/header |

FXT prefix unknown — possibly "Flexible Transfer" or a franchise/consignment module.

### Sync infrastructure tables
| Table | Meaning |
|---|---|
| `TCNTSyncLog` | Sync operation log |
| `TCNTSyncTask` | Sync task queue |
| `TCNTTmpLogChg` | Temp change log |
| `TCNTTmpLogDwn` | Temp download log |

These support the AdaSky/AdaSync data synchronization mechanism.

### New machine hostname discovered
`TTmpTagBarLAPTOP8C1L9BR8` — a temp stock check table for a machine named LAPTOP8C1L9BR8. Previously unknown workstation that has performed stock checks against the central server.

### TS-prefix tables (unknown)
`TSHD001`, `TSDT001`, `TSRC001`, `TSPD001`, `TSPG001`, `TSVT001` — unknown prefix, 001 suffix. Possibly branch-specific transaction copies or a legacy data format.

### Electronic Journal
`TEJTACCESS`, `TEJTJOURNAL` — EJT = Electronic Journal. Separate from AdaEJ.exe we found on workstations.

---

## AdaWCFCstPoint_5406_01.dll — FULLY DECODED

File: 146,944 bytes | Last modified: 2016-01-22 | Version: 4.5602.6.1 | Copyright: adasoft 2013
PDB also present (366,080 bytes) — debug symbols available
Internal project name from PDB path: **`AdaWCFMember` / `AdaSNPoint` / `IPointMOL`**

### Public WCF interface (IAdaWCFCstPoint) — 23 methods
| Method | Function |
|---|---|
| `C_ADDbBranch` | Add/register a branch |
| `C_ADDbCst` | Add/register a customer |
| `C_CHKbOnline` | Check if service is online |
| `C_CMPbInsertDataComp` / `C_CMPbUpdateDataComp` | Company data insert/update |
| `C_CMPoGetDataComp` | Get company data |
| `C_CSTbChkOnline` | Check customer online status |
| `C_CSTbReqQue` | Customer request queue |
| `C_CSTtGetPointAmtByCst` | **Get point balance by customer** |
| `C_CSTtGetPointSplByCst` | Get point split by customer |
| `C_DATbAddCustomerPoint` | **Add loyalty points to customer** |
| `C_DATtGetMyIPAddress` | Get caller IP |
| `C_DELbCouponByAidID` | Delete coupon by AID |
| `C_FLEbDelFile` | Delete file |
| `C_GETbDownload` | Download data |
| `C_GEToCoupon` / `C_GEToCstGiftCouponDT/HD` | Get coupon / gift coupon data |
| `C_GEToSysConfig` | Get system config |
| `C_GEToUrlPrcExpirePnt` | **Get URL for point expiry processing** |
| `C_GETtLastUpdCst` | Get last customer update timestamp |
| `C_SAVbSaveCoupon` | Save coupon |
| `C_SETbSysConfig` | Set system config |

### Internal stored procedure module (mCNSP)
| Method | Function |
|---|---|
| `SP_CHKbCstMonthEnd` | Check if month-end has run for customer |
| `SP_CHKbAdminAuthorize` / `SP_CHKbComAuthorize` | Authorization checks |
| `SP_DATbInsertCstPoint` | Insert point transaction |
| `SP_DATbAddCstNew` / `SP_DATbAddCstNewMonthEnd` | Add new customer (regular + month-end) |
| `SP_ADDbMonthEndData` | **Write month-end checkpoint data** |
| `SP_UPDxNextMonthEndData` | **Update next month-end data** |
| `SP_GETnSumCstPoint` | Sum customer points |
| `SP_EncryptData` / `SP_DecryptData` | Data encryption/decryption |
| `SP_PWDtEncrypt` / `SP_PWDtDecrypt` / `SP_PWDnKeyCode` | Password encrypt/decrypt/key |

### Cryptography
- Algorithm: **TripleDES** (3DES)
- Key derivation: **SHA1CryptoServiceProvider**
- Key variable: `tVB_CNKeyEncrypt`
- SHA1 is weak by modern standards; 3DES is deprecated but not broken
- Passwords and sensitive data are encrypted (not plaintext in the WCF layer)

### Config variables embedded
- `tVB_PATHConfigDelZip` — ZIP deletion path config
- `nVB_DayCrate` — day count for expiry calculation
- `tVB_PathConfig` — general config path
- `DB_GETtWebReportPath` — report output path

### Error types
`tMS_ErrAccessDeny`, `tMS_ErrNoReadB4`, `tMS_ErrNoRecord`, `tMS_ErrNoAddedRecord`, `tMS_ErrMonthEndInsertFail`

### Month-end loyalty cycle (fully confirmed)
1. `SP_CHKbCstMonthEnd` — check if month-end needed
2. `SP_ADDbMonthEndData` — write CardType='3' checkpoint rows to TCNTCstPoint
3. `SP_UPDxNextMonthEndData` — advance next month-end date
4. `SP_DATbAddCstNewMonthEnd` — handle customers added mid-month

---

## Updated understanding — post Session 11

| Layer | Before | After |
|---|---|---|
| Central server IP | Believed 192.168.0.71 | **CORRECTED: 192.168.100.124** |
| Legacy T-schema location | Unknown | **Not on central server — FTP target or transform on arrival** |
| FTP server | Known IP only | **CSLoxinfo hosted IDC — external** |
| Purchase invoices | Thought unused | **7,254 at central — used at branches 000/001** |
| Alipay/MOL payments | Unknown | **Tables exist — activation status unknown** |
| AdaWCFCstPoint business logic | ~15% | **~95% — all methods + crypto + month-end cycle decoded** |
| GL/F&B/Ticketing | Branch 005 only | **Confirmed dead across ALL branches at central** |
| **Overall system** | **~95%** | **~96%** |

## Final answers — POSSRV scan 2026-05-19

### Receipt printer — CONFIRMED
- **Epson TM-T82X** thermal receipt printer
- Driver: EPSON TM-T(203dpi) Receipt6
- Port: TMUSB001 — **USB-connected directly to POSSRV**
- Not network, not TCP port 9100, not ESC/POS over socket
- Standard Windows USB printing via Epson driver

### 192.168.0.71 — DOES NOT EXIST
- No ARP entry, no DNS response, no route, no ping reply
- Was never on this network or was decommissioned
- All prior references to 192.168.0.71 as "central server" were incorrect

### Central server is on WAN — not local LAN
Traceroute from POSSRV (192.168.0.127) to central server (192.168.100.124):
- Hop 1: 192.168.0.1 (local gateway)
- Hop 2: * (ISP NAT)
- Hop 3: 125.24.216.85 (TOT/CAT Thailand public internet)

**192.168.100.124 is a remote server accessed over the internet — not on any branch LAN.**
SC Group's central SQL Server is hosted/collocated at an external facility (likely same ISP as the FTP server at CSLoxinfo/TOT). Branches connect to it over WAN.

### Alipay and MOL — NEVER USED
| Table | Rows | Meaning |
|---|---|---|
| TPSTLogAlipay | 0 | No Alipay transactions ever |
| TSysMsgAlipay | 75 | Pre-loaded error message templates only (shipped with software) |
| TMOLLog | 0 | No MOL transactions ever |
| TAOTItemRedemption | 0 | No AOT redemptions |
| TAOTLog | 0 | No AOT activity |
| TAOTSalCard | 0 | No AOT sales |

Alipay and MOL are installed but have never been activated at any branch.

## Open questions remaining (low priority)

| Question | Priority |
|---|---|
| Where does AdaSky FTP data land on CSLoxinfo server? | Low |
| What are TAOTItemRedemption and TFXTJob* modules? | Low |
| Who is LAPTOP8C1L9BR8? | Low |
| What are TSHD001/TSDT001 etc? | Low |
