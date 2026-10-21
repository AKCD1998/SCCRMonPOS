# Basic membership release — 2026-10-21

This release makes registration, search and profile editing use the existing
Supabase CRM identities, including customers who registered through the public
QR form. It keeps the existing API URL and staff-device login/PIN. The backend
accepts the staff session for profile reads/edits, so a separate POS API key is
not required for those actions. Legacy POS-key integrations remain supported.

Changes: `ApiClient.cs` handles single-member, wrapped and array responses and
both error formats; sends staff bearer auth for profile detail/edit; maps optional
capability flags. `MemberClaimForm.cs` preserves flags in grid selection, displays
unavailable points honestly and disables awarding. `NewMemberForm.cs` preserves
flags after edits and hides the medical entry for a profile whose storage is
unavailable. No AdaAcc schema or data is changed.

## Build and checks

Build `SCCRMonPOS/SCCRMonPOS.csproj` in Release with Visual Studio MSBuild and
.NET Framework 4.8 reference assemblies. Build `tools/MemberApiCheck.csproj` and
run `build-verify/member-api-check/MemberApiCheck.exe` for offline contract checks.
Its opt-in `--live` mode reads a synthetic-fixture configuration and credentials
from stdin only and uses the exact desktop ApiClient. It must be orchestrated
with a unique test QR identity and cleanup; never enter real customer details.

Backend changes live in the SC-official-website repository, `routes/loyalty.js`.
No database migration or new credential is needed. QR and POS share the same
UUID/member code. Existing QR consent and verification state stay unchanged.

### Verified production result

Backend commit `fcbfb08b6a1ed245d1c7348d0ea979e107ff3de2` was deployed live on
Render on 2026-10-21. The exact release executable passed 11 offline parser
checks and 20 live ApiClient checks against the original Supabase database.
These covered phone/name/code searches, QR profile edits, POS registration and
phone edits, duplicate rejection/rollback and rejection of unsupported medical
writes. Direct database reads confirmed persisted edits, unchanged QR consent
and verification state. All synthetic identities and the temporary staff device
were removed; zero fixture member rows remained. No AdaAcc access was used.

The backend suite passed 1,115 tests locally, with 20 skipped; the GitHub Backend
CI for PR 80 also passed. This verifies the desktop API contract and the live
backend/database. It does not claim that any installed POS terminal has received
the new executable or that its local window/PIN/configuration has been tested.

Release EXE SHA-256:
`3CEDC269107335BE51E8850BE77424E339CE3E7193AC0618CA843A6BCD364324`.

## Updating a POS terminal

The release executable is in `build-verify/pos-members-20261021/SCCRMonPOS.exe`.
Close the running companion before replacing it and retain the terminal's
existing `.exe.config` and `SCCRMonPOS.secrets.config` (or environment settings).
Use the existing configured staff PIN/device login. Open the tray icon or press
Ctrl+Alt+Q to search, register or edit. The device's local edit PIN still applies.

Only the executable and these instructions belong in a distributable archive;
never package tokens, secrets, runtime data, logs or the live test harness.
No installed terminal is automatically replaced by building this release.
Points, purchase history and health-record provisioning remain separate work.
