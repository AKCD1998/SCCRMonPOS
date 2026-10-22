# SCCRM device policy — 21 October 2026

Release 1.3.0 adds the installer/runtime device policy and the corresponding
StockDay admin inventory. The initial candidate was tested locally before the
user authorized publication. No remote installation, AdaSoftware execution, or
AdaAcc write was performed for this change.

## Approved devices

These five Windows devices belong to `akcd1998.github`. Fresh read-only SMB
inspection found the actual executables below. Permission binds each stable
Tailscale node ID, hostname, and IP; the two POSSRV names are distinct computers.

| Hostname | Tailscale IPv4 | Stable node ID |
| --- | --- | --- |
| SERVER004 | 100.113.59.42 | n3AqXUmdkF11CNTRL |
| SC_001 | 100.81.137.41 | nKAsnKMrkZ11CNTRL |
| POSSRV | 100.106.107.80 | nSKeeNSVgt11CNTRL |
| POSSRV | 100.77.101.94 | nFCuxvTVA521CNTRL |
| server | 100.90.166.72 | ndEzc41bWC21CNTRL |

Evidence at audit time `2026-10-21T10:46:48Z`:

| Local path on each approved device | File version | Length |
| --- | --- | --- |
| `D:\AdaSoft\AdaPos4.0HpmFhn\AdaPos\AdaPosFront.exe` | 4.6006.0032 | 13,701,120 |
| `D:\AdaSoft\AdaPos4.0HpmFhn\AdaPos\AdaPosBack.exe` | 4.6006.0030 | 48,521,216 |
| `D:\AdaSoft\AdaPos4.0HpmFhn\AdaSmart\AdaSmart.exe` | 4.6006.0024 | 50,626,560 |

No branch identity was inferred solely from a duplicate or generic hostname.
Approval confirms software presence, not that database monitoring or a staff PIN
has been configured. The original 1.3.0 installer starts with monitoring disabled;
the combined 1.3.2 installer enables it only after verifying a read-only connection.

## Devices still blocked

| Hostname | Tailscale IPv4 | Evidence limitation |
| --- | --- | --- |
| DESKTOP-T5APRP8 | 100.69.240.36 | Historical AdaSmart evidence; current file read could not be reconfirmed |
| NB-005-01 | 100.93.216.27 | Online; no readable match at audited executable paths |
| Shop001 | 100.105.88.86 | Online; no readable match at audited executable paths |
| MSI | 100.97.100.5 | No currently verified executable evidence |
| SC004 | 100.72.52.34 | Offline during this audit |
| Natthanon | 100.65.38.66 | Offline; no verified current executable evidence |

These six are pending, not assertions that AdaSoftware is absent.
Developer computer ScProductDev (`100.110.167.95`) is denied and was used for the
real negative installer/startup checks.

## Enforcement in 1.3.0

- Inno Setup extracts only a temporary checker, executes `--check-device`, and
  requires exit code **42** before installing application files. Exit 0 is not
  accepted because legacy EXEs ignore unknown arguments and can return 0.
- The application performs the same check before loading staff sessions,
  starting the AdaPos watcher, opening forms, or running an update helper.
- Every 60 seconds it checks again. A failed check exits the application and
  disposes its watcher/forms before showing a warning. A check may take up to
  eight seconds while waiting for Tailscale.
- Identity comes from the native protected HKLM Program Files location's
  `Tailscale\tailscale.exe status --json --peers=false`, not a browser-supplied
  IP or a program resolved through PATH. This also handles a 32-bit .NET process
  on 64-bit Windows.
- Require the company tailnet, running/online self identity, exactly one approved
  stable node ID, recorded hostname/IP, and that IP on an active local adapter.
- At least one audited local AdaPosFront/AdaSmart path must be a readable PE
  executable of at least 1 MiB with file-version metadata. No executable on a
  remote share is accepted. AdaSoftware is never launched by this check.
- Missing Tailscale, disconnected devices, unreadable Ada files, policy errors,
  and pending/denied devices fail closed. There is no configuration, environment,
  or command-line allow override.
- Signed updates must declare `deviceAccessVersion: 1`; the protected client
  refuses an older unmarked release during check, staging, and apply.

The backend inventory in PaaSRTSM is the reviewed audit record. The desktop
resource contains only the approved identities and necessary Ada paths. Keep
those approved entries identical when preparing a release. Pending inventory and
release metadata are not needed in the desktop binary.

## Limits that affect rollout

The original public **1.2.0 installer and EXE remain unrestricted**. A new release
cannot retrofit checks into an already downloaded binary or revoke its existing
backend credentials. Do not label the original asset as restricted or replace it
under the same 1.2.0 name.

This policy protects the supplied 1.3.0 installer/application under a trusted
Windows/Tailscale installation. It is not server-side device attestation and does
not prevent a local administrator from modifying source/binaries. Existing
server-side staff/POS authentication remains required. Restricting legacy or
custom clients at the CRM API would require a separate server authorization and
credential migration; this candidate does not claim that enforcement.

The policy is compiled into the application. The admin page displays a dated
snapshot and cannot remotely revoke a running binary. Adding/removing a device
requires another reviewed release. Tailnet disconnection/local Ada removal is
detected by the running application's periodic check.

## Verification

- StockDay frontend: 128 tests passed; Vite production build passed.
- Admin API: real auth middleware tests verify anonymous 401, branch-role 403,
  admin 200, no-store headers, five approved devices, no unrestricted download.
- Desktop: DeviceAccessCheck 18 checks, DesktopFeatureCheck 34 checks, and
  MemberApiCheck 11 offline checks passed.
- Real developer-device `--check-device` returned 20 (denied).
- Candidate Setup ran with a task-local `/DIR` and silent flags: exit 1,
  `InitializeSetup returned False`, and no target application directory created.
- No positive installation or runtime test was performed on branch computers.

Initial local candidate: `build-verify/installer/1.3.0/SCCRMonPOS-Setup-1.3.0-DEVICE-POLICY-CANDIDATE.exe`
(2,144,674 bytes). SHA-256:
`E7649885D54F406E55B42B608D5DDCE7B58B0639F7EF6532E2A023142408470B`.
Machine-readable negative-test evidence and the application hash are recorded in
`build-verify/device-policy-verification.json`. The backend inventory and
embedded approved identities were compared successfully after the final build.

## Release procedure

1. Reconcile the three isolated branches against their latest remote branches;
   review only this task's changes and commit them. Do not include canonical
   checkout changes from other tasks.
2. Publish reviewed desktop source and prepare a new signed `pos-1.3.0` release
   with `tools/Publish-PosRelease.ps1`. Build the installer using the verified
   release and `tools/Build-Installer.ps1`; upload it as a new release asset.
   The local `CANDIDATE` build is not the official signed-release package.
3. Verify the uploaded installer bytes/hash, then set the backend inventory's
   installer status/downloadUrl to that verified 1.3.0 asset. Never use the 1.2.0
   link as the protected download.
4. Deploy PaaSRTSM first. This patch adds no database migrations. Its deployment
   pipeline may run the existing migration command, so inspect the current live
   migration ledger and pending repository migration filenames before triggering
   production deployment. Do not run the Windows migration runner.
5. Verify anonymous/branch rejection and authenticated admin inventory on the
   real API, then deploy StockDay and verify CR → แอดมิน with an admin account.
6. Separately perform a supervised positive installation/startup test on one
   approved device before recommending installation across branches.

Working branches: `codex/stockday-pos-admin-20261021`,
`codex/pos-device-admin-20261021`, and `codex/pos-device-guard-20261021`.
