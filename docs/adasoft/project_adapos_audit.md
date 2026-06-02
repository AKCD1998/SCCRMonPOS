---
name: AdaPos sync gateway audit findings
description: Full audit of the AdaUploadPoint/AdaDownloadPoint sync service on the hub machine — broken since March 2026, security issues, recommended fixes
type: project
originSessionId: external-audit
---

Audit performed on the AdaSoftware hub/gateway machine (not a cashier POS terminal). The POS software itself (AdaPos 3.0 / 4.0) runs on separate cashier machines; this machine is a sync gateway that relays transaction data to the cloud.

**Why:** User submitted a full offline-resilience audit question and received this report from Claude on another machine. Saved here for continuity.

## Critical finding
Sync has been completely broken since at least March 2026. Root cause: `<StaticWebServerIP>` and `<DynamicWebServerIP>` in `AdaUploadPoint/AdaUploadPointCfg.xml` are blank. Every 30-second retry generates an invalid URL (`http://:80/AdaWCFCstPoint/...`) and logs `Connect to Service Fail : Invalid URI`. The `AdaDownload.ada` state file shows the last confirmed successful sync was January 17, 2022 — over 4 years ago.

## Architecture summary
- `AdaUploadPoint.exe` Windows Service — wakes every 30 s, reads pending records from `AdaSky/Outbox/` queue folders, uploads to `http://abreast.ada-soft.com/AdaWSNoIP/...` via WCF/SOAP.
- `AdaDownloadPoint.exe` Windows Service — downloads updated member/points data back into local SQL Server (`AdaAcc` database on instance `ADA47\SQL2008`).
- POS terminals write transactions locally → Outbox folder → upload service picks up. Cashiers can transact offline; stale member balances are the main risk during outages.
- Retry: linear, every 30 s, unlimited, no backoff, no staff alert.

## Security issues (critical before any live deployment)
| Issue | Severity | Location |
|---|---|---|
| Plaintext `sa`/`adasoft` SQL credentials | CRITICAL | `AdaDownloadPoint.exe.config:7` |
| All WCF traffic is plain HTTP | HIGH | All endpoints, `security mode="None"` |
| SQL Server 2008 (EOL July 2019) | HIGH | `ADA47\SQL2008` |
| Member DB fields all blank in `AdaXML.Ada` | HIGH | `W_DBMemberServer` etc. |

## Must fix before demo
1. Set `StaticWebServerIP` in `AdaUploadPointCfg.xml` — this alone unblocks all sync.
2. Verify `AdaWCFCstPoint` service is running and reachable on the LAN server.
3. Confirm POS app connection strings are not pointing to VS design-time `localhost:8731` addresses.
4. Add a visible "Last synced: X min ago" indicator — staff have no way to know sync is failing.

## Must fix before real branch deployment
1. Replace `sa/adasoft` with a least-privilege SQL account; use DPAPI or integrated auth.
2. Enable HTTPS on all WCF endpoints.
3. Upgrade SQL Server 2008 to a supported version.
4. Add GUID-based idempotency keys on transactions (current dedup is timestamp-only — clock drift risk).
5. Add alert after 5+ consecutive sync failures (~2.5 min).
6. Set log rotation limit (`LogStep20260306.txt` grew to 24 MB unchecked).
7. Configure member DB connection in `AdaXML.Ada`.

## Nice to have
- Exponential backoff on retries.
- "OFFLINE MODE — points may not be current" warning on cashier screen.
- Migrate from WCF/SOAP to REST + JWT.
- Automated end-to-end sync smoke test before each branch goes live.

## How to apply
When working on SCCRMonPOS integration with AdaPos or suggesting fixes to the sync layer, refer to these findings. The SCCRMonPOS project talks to a *different* backend (sc-official-website.onrender.com), but the AdaPos local DB and WCF services on the LAN are relevant if the AdaPosWatcher.cs integration plan is pursued.
