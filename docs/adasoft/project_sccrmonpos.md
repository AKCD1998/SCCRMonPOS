---
name: SCCRMonPOS project overview
description: Architecture and goals for the SCCRMonPOS POS companion app, including the AdaPos screen-reader integration plan
type: project
originSessionId: a0bfc646-4529-48bd-adff-9b0978052bf6
---
SCCRMonPOS is a **C# .NET 4.8 Windows Forms tray application** that runs on a POS machine (FRONT2, 192.168.0.129, Windows 10/11, i5-8350U, 16 GB RAM). It bridges a legacy POS (AdaPos HyperMart 4.6006.30) to a mobile CRM/loyalty system.

**Current architecture:**
- `Program.cs` — single-instance mutex guard, WinExe entry point
- `TrayAppContext.cs` — headless tray app; owns scanner, API client, offline queue
- `ScannerInputService.cs` — WH_KEYBOARD_LL global keyboard hook; detects barcode scanner input by speed; fires PointScanDetected / RedeemScanDetected / RawScanDetected
- `MemberPointForm.cs` — two-step form: (1) member lookup, (2) cashier manually types bill amount → earn points API call
- `ApiClient.cs` — HTTP client for backend at sc-official-website.onrender.com
- `TransactionRepository.cs` — local CSV audit log
- `OfflineQueue.cs` — offline earn request queue (retried on next launch)
- `StaffAuthManager.cs` — DPAPI-encrypted staff token on disk
- `ProductEligibilityClient.cs` — drug/product exclusion screening API

**No NuGet packages** — pure .NET 4.8 framework references only.

**Current gap:** Cashier manually enters bill total in MemberPointForm. Goal: auto-read it from the AdaPos checkout screen.

**AdaPos integration plan:**
Why: AdaPos HyperMart 4.6006.30 is closed-source with no API/webhook/DB hook.
Approach (in order of preference):
1. Windows UI Automation (System.Windows.Automation) — read control text directly
2. Screen OCR via Tesseract — screenshot AdaPos window region, extract total
3. Direct DB access — find AdaPos local database (Access/SQLite/MSSQL)

**Diagnostic tool:** `tools/adapos_probe.py` — run on FRONT2 while AdaPos is open; tests all three approaches and writes `adapos_probe_results.txt`.

**How to apply:** The actual integration will be a new C# class `AdaPosWatcher.cs` added to the SCCRMonPOS project (not Python), wired into TrayAppContext to pre-fill MemberPointForm's bill amount field when a checkout total is detected.
