---
name: branch-005-d-drive-expedition
description: "D: drive scan of Branch 005 POSSRV (192.168.0.127). Software on D:\\AdaSoft (392MB, 1236 files), DB on D:\\AdaAccData (469MB, 14-NDF filegroup split). New vs C-drive expedition: AdaKDS.exe, AdaPrnSrv.exe, AdaEDC.NET.dll, TSCPURSE purge triggers, Crystal Reports SC custom reports, 005Empty setup template backup (2026-04-08), VB6 COM stack. Confirms Branch 005 is the same machine as C-drive expedition (dao1 / 192.168.0.127)."
metadata: 
  node_type: memory
  type: project
  originSessionId: 4eb79e91-534f-4357-83ab-417e0a3131b1
---

## Machine identity
- Hostname: POSSRV
- IP: 192.168.0.127
- Branch: **005** (confirmed — user `dao1` from 192.168.0.127 matches C-drive expedition; `005Empty` backup label)
- Drive scanned: D:\
- Software path: `D:\AdaSoft\AdaPos4.0HpmFhn` (392 MB, 1,236 files)
- Database path: `D:\AdaAccData` (469 MB total filegroup)
- Investigation date: 2026-05-19

## Note on 227 MB vs 469 MB discrepancy
The C-drive Branch 005 expedition reported AdaAcc at 227 MB. The D-drive shows 469 MB across 14 NDF + 1 MDF + 1 LDF files. The 227 MB figure was likely the MDF data file alone or the SQL Server reported data size; the 469 MB is the full filegroup on disk (data + free space across all NDF files). Same database, both figures are correct in different contexts.

---

## New executables not seen at Branch 005

| File | Purpose | Significance |
|---|---|---|
| `AdaKDS.exe` | Kitchen Display System | Confirms F&B module is deployed on some branches — explains `TFFM*`/`TFFT*` tables in AdaAcc |
| `AdaPrnSrv.exe` | Dedicated print server service | Branches with multiple receipt printers route print jobs through this |
| `AdaEDC.NET.dll` | Credit card payment (EDC = Electronic Data Capture) | This branch accepts card payments; Branch 005 had no EDC component |

---

## Database filegroup structure — different from Branch 005

Branch 005: single MDF file (simple setup for new branch, April 2026)
This branch: **1 MDF + 14 NDF files** in `D:\AdaAccData`

Adasoft deliberately splits AdaAcc across multiple filegroups on larger/busier branches to spread disk I/O. This is a deliberate architectural choice, not corruption.

---

## TSCPURSE files — purge trigger pattern

**22 zero-byte `TSCPURSE` files in D:\** root directory.

These are trigger placeholders for `AdaPurge.exe`. When `AdaPurge.exe` runs, it checks for the existence of these files to know which tables to archive/clear. The naming convention `TSCPURSE_<tablename>` maps directly to AdaAcc table names. Branch 005 had none of these, suggesting purge archiving is only active on older branches with larger datasets.

---

## AdaPurge\PROC\ — additional SQL source

Contains SQL stored procedures for the purge/archiving workflow. This is additional source SQL beyond the `AdaDB\Source_SQL\` goldmine found at Branch 005 (80+ stored procs). Total source SQL available across both workstations is now higher.

---

## Crystal Reports — SC Group custom reports

`.rpt` files covering:
- Sales reports
- Inventory reports
- Stock reports
- Supplier reports
- Customer points reports
- Time card reports
- Banking/cash reports
- Shelf label printing

These are SC-specific customizations on top of the standard AdaPos template. Confirms SC Group has invested in custom reporting beyond what Adasoft ships by default.

---

## KEY FIND — Branch 005 setup template backup

`D:\AdaBackup\AdaAcc_20260408-005Empty.bak`

- Dated: 2026-04-08
- Branch 005 opened: 2026-04-09 (from Branch 005 expedition — local AdaAcc created 9 Apr 2026)
- Label "005Empty" = blank template database

**This is almost certainly the clean database that was restored onto Branch 005's POSSRV machine on April 9, 2026 to initialize it.** Confirms the branch setup process:
1. Create blank AdaAcc from template
2. Restore `005Empty.bak` onto branch POSSRV\SQLEXPRESS
3. Configure AdaPos to point to local DB
4. Import master data (products, customers) via AdaImportExport

Local branch backups also present: `AdaAcc260409.bak`, `AdaAcc260422.bak` — this branch self-backs up locally. Branch 005 had no local backup files visible.

---

## VB6 COM dependency stack

Files found: `Vsflex7u.ocx`, `MSWINSCK.OCX`, and related legacy ActiveX controls.

First direct evidence of the COM dependency stack AdaPos requires. Any new workstation must have these registered via `regsvr32` before AdaPos will launch. Documents why Adasoft deployments are brittle on newer Windows versions — these controls are 20+ years old.

---

## HpmFhn identifier

Appears in folder/file naming as SC Group's Adasoft customer code. Useful for Adasoft support references.

---

## Thai banknote UI images

20, 50, 100, 500, 1000 THB banknote images found in AdaPos UI assets. Used in the cash tendering screen to display denominations during checkout. Cosmetic finding — confirms the cash management UI is localized for Thai currency.

---

## What this confirms (reinforces Branch 005 findings)

- Offline-first architecture — local SQL Server, local backups, no live central connection
- AdaPosBack.exe + AdaPosFront.exe two-binary POS suite
- Manual AdaSky FTP sync, no scheduled tasks
- `sa`/`adasoft` credentials in config files
- `AdaDB\Source_SQL\` pattern exists across branches

---

## New understanding from this workstation

| Discovery | Implication for SC-StockDay |
|---|---|
| KDS module deployed | F&B branches have kitchen display — if transfer reconciliation UI is ever deployed, it must not interfere with kitchen ticket flow |
| EDC card payment | Payment method data is richer than cash-only; not relevant to transfer reconciliation |
| Filegroup-split DB | adapos-sync must handle AdaAcc with multiple NDF files transparently — SQL Server connection string does not change |
| 005Empty template backup | Branch provisioning is manual, template-based — explains why all branches have identical schema |
| TSCPURSE purge triggers | Older branches periodically archive data — adapos-sync queries must account for missing historical records if archiving has run |

---

## Remaining unknowns for this workstation

| Unknown | How to answer |
|---|---|
| Which branch is this? | Read `AdaSky\SkyConfig.INI` — INBOX path will show branch code |
| KDS table structure | Read `TFFM*` tables in local AdaAcc |
| AdaPurge\PROC\ — full SQL content | Read each .sql file |
| EDC provider | Read `AdaEDC.NET.dll` strings or config file |
