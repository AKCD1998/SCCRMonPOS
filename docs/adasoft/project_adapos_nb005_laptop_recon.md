---
name: branch-005-second-laptop-nb005-01-recon
description: "Full recon of NB-005-01 (192.168.0.231) — Branch 005 back-office laptop. Key finds: SQL connection compiled into VB6 binary (not in any config file); no receipt printer here (Godex G500 label + Brother inkjet only); Thai ID card reader shortcut; FTShdStaPrcDoc daily export error since May 2 (schema mismatch, silently failing); POSSRV logged as 192.168.0.219 on April 9 (IP discrepancy); 3 remote access tools installed."
metadata: 
  node_type: memory
  type: project
  originSessionId: 4eb79e91-534f-4357-83ab-417e0a3131b1
---

## Machine identity
- Hostname: **NB-005-01**
- Primary IP: **192.168.0.231** (was 192.168.0.238 before May 13–14 — DHCP)
- Branch: 005
- Role: **Pure back-office management workstation — NOT a cashier terminal**

---

## SQL Server connection — compiled into binary

No connection string exists in any INI, XML, config, or registry key.
- `AdaPurge.ini` → still points to `ADA74\Sql2008` (vendor dev server, never updated)
- `EJ.INI` → still shows `Branch=001` (same copy-paste error as POSSRV)
- `SkyConfig.INI` → Jet/Access `Sky.mdb` only, no SQL Server reference
- `HKCU\VB and VBA Program Settings\AdaPos20HPM\AdaPosBack` → only `Handle` and `BackColor`

**Conclusion:** AdaPosBack.exe and AdaPosFront.exe have the SQL Server address (POSSRV\SQLEXPRESS, 192.168.0.127) compiled into the VB6 binary. This is why it cannot be found in any config file. The connection works — AdaImportExport runs against AdaAcc daily without error.

---

## POSSRV IP discrepancy

| Date | Machine | IP in logs |
|---|---|---|
| 9 Apr 2026 | POSSRV | **192.168.0.219** |
| 30 Apr – 13 May 2026 | NB-005-01 | 192.168.0.238 |
| 14 May 2026 → today | NB-005-01 | 192.168.0.231 |

POSSRV appeared as **.219** on the branch opening day (Apr 9), not **.127** as documented later. Either:
1. POSSRV had DHCP on opening day and was later given a static .127, OR
2. The April 9 session was a vendor laptop doing initial AdaImportExport configuration

All machines at Branch 005 appear to be on DHCP — IP addresses change over time.

---

## Printers — back-office only, no receipt printer

| Printer | Driver | Port | Purpose |
|---|---|---|---|
| **Godex G500** | Godex G500 | USB003 | **Label/barcode/price tag printer** |
| **Brother DCP-T530DW** | Brother DCP-T530DW | LPR/515 | **Network inkjet for reports/documents** |
| Brother DCP-T530DW (Copy 1) | Same | WSD | Second driver instance, same physical printer |
| RustDesk Printer | RustDesk v4 | Virtual | Remote desktop |
| AnyDesk Printer | AnyDesk v4 | Virtual | Remote desktop |

**No receipt/ESC-POS/thermal slip printer on this machine.**
**No KDS connection, no AdaPrnSrv port (9100) configured.**

Receipt printers must be physically connected to POSSRV (which has AdaPrnSrv.exe installed). This machine is back-office only — it prints labels (Godex) and documents (Brother), not receipts.

---

## Machine role — confirmed back-office

**Desktop shortcuts:** AdaPosBack, AdaSmart, AdaImportExport, AdaSky, AdaBarCode, AdaTools, Excel, Word, PowerPoint, Chrome, AnyDesk, RustDesk, TeamViewer, LINE

**Notable shortcut:** "ตัวอ่านบัตรประชาชน" (Thai ID card reader) — for customer/member ID capture at back-office. Likely used for loyalty membership lookup, not POS cashier scanning.

**No AdaPosFront shortcut.** No cashier function on this machine.

**AdaLog activity for user dao1:** Reports, inter-branch stock transfers (โอนสินค้าระหว่างสาขา), stock adjustments — pure back-office.

---

## Sync capability — full set, not POSSRV-exclusive

| Tool | Present |
|---|---|
| AdaSky.exe | ✓ |
| AdaImportExport.exe | ✓ |
| AdaExportAuto.exe | ✓ |
| AdaImportAuto.exe | ✓ |
| Sky.mdb (1.38 MB, Apr 9 2026) | ✓ |
| FTP Inbox\005 subfolder | ✓ |

AdaImportExport run **manually every morning ~8:00–8:10 AM** by user dao1. AdaSky also on desktop for manual FTP sync. Nothing automated.

---

## ⚠️ ACTIVE BUG — FTShdStaPrcDoc daily export error

**Every morning since 2 May 2026**, AdaImportExport throws:
```
Invalid column name 'FTShdStaPrcDoc'.
```
Location: `wCNExport → W_EXPtTable2Text` — the export routine.

**What this means:**
- Column `FTShdStaPrcDoc` does not exist in AdaAcc on POSSRV
- The AdaImportExport template (likely updated by Adasoft) expects this column
- Schema version mismatch between the export template and the local database
- Has been silently failing **every day for 2.5 weeks** (since May 2)
- User dao1 cancels and moves on — error is unacknowledged

**Impact:** Whatever field `FTShdStaPrcDoc` represents is not being exported in the daily sync. The FTP zip sent to central HQ is missing this field's data from Branch 005 since May 2.

**Note:** `FTPthStaPrcDoc` (transfer processing status) is a known column. `FTShdStaPrcDoc` may be a similar field for a different document type — possibly schedule/order docs (`FTShd` prefix = schedule header?). Needs investigation.

---

## Application stability

| Date | App | Event |
|---|---|---|
| 2026-05-18 16:35 | AdaPosBack.exe v4.6006.0.30 | Application Hang (EventID 1002) — closed by Windows |
| 2026-05-18 16:54 | AdaBarCode.exe v4.5803.0.3 | Application Hang × 2 consecutive |

No hard crashes (EventID 1000) for AdaPos. Hangs are "not responding" timeouts, recovered without data loss. AdaPosBack version confirmed: **4.6006.0.30**.

---

## Security findings

**Three remote access tools installed simultaneously:**
- AnyDesk (virtual printer port AD_Port present)
- RustDesk (virtual printer port present)
- TeamViewer (desktop shortcut)

All three on one back-office machine = multiple unmonitored remote access vectors into the Branch 005 network. Any of these tools could be used to pivot to POSSRV\SQLEXPRESS.

**C:\Program Files (x86)\AdaSoft\AdaBarcode.net** — separate install done May 5, 2026. Duplicates tool in D:\AdaSoft\AdaTools. Minor — suggests someone installed it independently without knowing it was already present.

---

## What this tells us about receipt printing

Receipt printers are **not on the back-office laptop**. Since AdaPrnSrv.exe is installed on POSSRV and the cashier frontend (AdaPosFront) runs on POSSRV (or a dedicated cashier terminal we haven't scanned), the receipt printer is:
1. Physically connected to POSSRV via USB/serial, OR
2. On the same LAN as POSSRV reachable via TCP/IP (port 9100)

To confirm: scan POSSRV's `Get-Printer` / `Get-PrinterPort` output — that is where the receipt printer will appear, not on this back-office laptop.

---

## Updated Branch 005 network map

| Hostname | IP | Role |
|---|---|---|
| POSSRV | 192.168.0.127 (static after Apr 9) | SQL Server + AdaPosFront (cashier) + AdaPrnSrv |
| NB-005-01 | 192.168.0.231 (DHCP, was .238) | Back-office: AdaPosBack + AdaSmart + sync |
| Unknown | 192.168.0.219 | POSSRV on Apr 9 opening day, or vendor laptop |
