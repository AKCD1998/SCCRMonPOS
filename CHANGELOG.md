# Changelog

## 1.3.23 — 2026-11-11

- Save membership receipt history in SCCRM without waiting for Ada member or
  points readiness when the server enables the history-first capability.
- Show branch-scoped sync status, timestamped events and explicit retry under
  the extra menu. Keep receipt ownership, terminal scope and duplicate guards.
- Add an independent headless HQ receipt queue/receiver. Fill only a blank
  member code on an existing, paid, matching bill; never create sales or award
  points. Keep the existing two-second member lane unchanged.
- Verify copied native HQ/four-branch bills, narrow receiver permissions,
  repeated delivery, rejected ownership/item changes and unchanged customers.

## 1.3.22 — 2026-11-11

- Retry the selected member's unavailable points by the same UUID every five
  seconds. Refresh its assigned AR code and enable receipt confirmation once
  the server reports points ready, without another member search.
- Show a short waiting message instead of leaving the disabled button unexplained.
  Ignore late responses after selection changes, edits or closure; do not submit
  receipts, invent a zero balance, change Ada points or relax duplicate guards.

## 1.3.21 — 2026-11-10

### 2026-11-10 — Cashier chooses existing member or a different person

- Ask “เคยสมัครไว้แล้วใช่ไหม?” with names, phones and member codes. Buttons use
  ordinary Thai, never select an existing identity automatically, and allow the
  cashier to return to the unchanged signup draft.
- Bind the confirmed choice to an idempotent server request. Keep existing
  member data; open an explicit editor if an existing member has a medical draft.
- Deliver explicitly confirmed separate people through an audited HQ-created
  assignment kind while retaining native code/profile/replay guards. Keep fast
  member polling from the verified deployed fast-lane baseline.
- COPY-only HQ/005 acceptance runs native creation and delivery under restricted
  users, tests replay and preserves all 101 non-PIN columns of old customers.
  All COPY changes roll back. Live rollout and an app release remain separate.

### 2026-11-10 — Validate mobile numbers before new member registration

- Keep new-member Save disabled until the phone is a Thai mobile with 10 digits
  beginning 06, 08 or 09. Normalize formatted input and Thai digits before saving.
- Recheck the input before calling the API and keep the save gate closed during
  an in-flight request. Existing member edits can retain legacy contact numbers.

### 2026-11-05 — 1.3.20 Member date editing and medical drafts

- Read/write API birth dates as Gregorian ISO dates regardless of the Windows
  calendar. Thai Windows previously sent Buddhist years and misread API years.
- Clarify that the medical popup returns a draft to the member form. Keep an
  open medical draft from being discarded by the parent Save button.
- Verify real forms under Thai and English cultures and changed medical fields.
  Shared Ada contact phone edits and medical storage require the matching API
  deployment; no member merge, Ada write, point or purchase change is included.

### 2026-11-04 — 1.3.19 Refresh pending administrator update status on demand

- A click on the update menu now awaits a fresh (or already in-flight) fleet
  check before displaying status. Replace the cached modal wait message with a
  non-modal notification and identify the actual busy condition without PII.
- Exclude only the independent return-to-sales safety button from work-window
  detection. Retain unconfirmed receipts, edits, QR and API/refund save barriers.
- Cover timer/menu overlap, fresh readiness after busy status, a real cross-STA
  safety button in Application.OpenForms and preservation of a visible edit form.

### 2026-11-04 — 1.3.18 Compact purchase history and accessible window controls

- Reduce the purchase-history window from 880 to 616 pixels wide (30%), retaining
  native maximize and all history/item columns through existing scrolling.
- Keep the independent return-to-sales button clear of the active owned dialog's
  title bar, including when maximized. Preserve manual parking, hung-UI recovery
  and unsaved work. No member, receipt, SQL or points behavior changes.

### 2026-11-03 — Recover branch member delivery after SQL transport failures

- Preserve the outer SQL provider error when an inner Win32 error exists, so
  disconnects/timeouts reconnect and retry the same owned assignment. Keep
  authentication, permission and customer-identity conflicts held for review.
- Report unknown SQL error numbers without server/customer/credential messages.
  Expose held AR deliveries in worker status and mark them attention-required
  instead of healthy. No Ada profile overwrite, code change or point change.
- Add real nested SqlException fixtures and exact-packet reconnect checks.
  Copy acceptance and production readback remain separate rollout evidence.

### 2026-11-03 — 1.3.17 Terminal-specific registration QR

- Show a QR assigned to the approved branch/POS node so customer self-signup
  records its source automatically, without selecting a branch on the phone.
- Bundle all eight QR assets offline and verify decoded URLs and native identity
  mapping. Unknown origins stop before showing a customer sign. Keep the cashier
  overlay, manual close and administrator-requested update save barrier intact.
- Source tracking requires the corresponding website deployment. Publishing and
  actual fleet installation are separate rollout checks; no commands are implicit.

### 2026-11-03 — 1.3.16 Fleet pilot target

- Prepare a distinct signed version for verifying the first administrator-issued
  update from the 1.3.15 bootstrap receiver. Keep its save barrier, device policy,
  Ada connection and member/point contracts unchanged. Actual terminal restart
  and running-hash acceptance remain separate recorded rollout checks.

### 2026-11-03 — 1.3.15 Administrator-requested branch updates

- Add a SCProductDev console for explicit per-terminal update commands and a
  persistent backend queue. Release notifications alone never install updates.
- Receive only authenticated device-specific commands, verify signed releases,
  and wait for unsaved receipts, member forms, API calls, customer QR display
  and refund work before reopening only SCCRM through its existing updater.
- Retain offline commands and staged files across restart, reuse lost-response
  requests, verify the running binary before reporting success, and expose
  non-secret device identity for scoped SMB diagnostics.
- Add copy-only queue and native replacement checks. Existing clients require
  one first installation; a real POS version transition is a separate release
  acceptance check and is not asserted by this entry.

### 2026-11-03 — HQ point-sync named SQL instances

- Accept each verified branch SQL named instance in the native point receiver
  adapter, alongside its legacy pinned TCP endpoint. Keep exact host, machine,
  database, restricted login/SID and allowed-action checks unchanged.
- Add 55 offline target-boundary checks covering named/legacy endpoints and
  rejected hosts, instances, ports, databases, identities, credentials and actions.
- Run the point model, ownership, endpoint and worker guards in a focused Windows
  CI workflow without production credentials or database access.
- Document named-instance service configuration for SQL Express port changes.
  Production rollout and readback remain separate operator checks.

### 2026-11-02 — 1.3.13 Branch 005 POS 002 approval

- Approve the user-identified FRONT2 device by its verified stable Tailscale
  node, hostname, IPv4 and read-only verified local Ada executable paths.
- Bind receipt access to branch 005 / POS 002. Copied POS 001 configuration
  cannot override the assignment or expose another register's receipts.
- Preserve all eight existing approvals and the Ada-authoritative points flow.
- Add approval and receipt-isolation checks for FRONT2. Release publication
  and installation on the POS remain separate verification steps.

### 2026-11-02 — 1.3.12 Ada-calculated points

- Use Ada's authoritative points metadata in member search, member details and
  purchase history. Preserve exact balances and show unavailable points as
  unavailable instead of substituting zero or an earlier balance.
- In Ada-authority mode, saving a receipt records purchase history and reads
  Ada's recorded award without previewing or awarding points a second time.
  Explain that the member must be selected in Ada before payment for Ada to
  calculate the award; the old manual earn form directs staff to that flow.
- Keep application updates optional and preserve existing installer/device,
  read-only Ada connection, receipt ownership and saved-claim protections.
- Add a separate headless HQ points worker with verified five-database native
  observations, explicit approved-code ownership, immutable opening baselines,
  compensation proofs, monotonic revisions and durable per-target delivery.
- Add least-privilege private Supabase storage and native append-only receivers;
  preserve customer profiles, original point entries and the archived SCCRM
  ledger. Pause ambiguous/changed sources rather than guessing a replacement.
- Include copy-only retry, restart, ACK-loss, duplicate, ownership, permission
  and full-column preservation checks, plus scoped service staging/stop controls.
- Check service boot privileges through catalog object IDs so the restricted
  worker does not need access to external schemas merely to inspect its rights.
- Prepare version 1.3.12.0 and release notes locally. HQ point-service rollout,
  native/UI verification and release publication are separate checks; this
  entry alone does not claim a deployed or published update.

### 2026-10-29 — Ada-assigned member codes

- Add an optional AR member-code authority and durable branch queue alongside
  the existing SC queue. Preserve old queue envelopes, mappings and SCCRM UUIDs.
- Publish verified Ada codes to SCCRM with exact old-code aliases and scoped
  customer-only mirror refresh. Keep publication-only legacy links out of
  branch delivery; phone matches never authorize a merge.
- Guard the two explicitly approved owned SC-to-AR migrations separately from
  new-member delivery. Preserve unrelated native customer fields, bill owners,
  purchase history and points rules.
- Coordinate pause/resume, sanitized status and atomic target enable states for
  both queues. Add reviewed staging/rollback support for only the dedicated
  fanout service, retaining native rows and durable state.
- Extend Linux PostgreSQL tests and Windows PowerShell validation in CI.
  Native-copy acceptance, live installation and AdaPos UI checks remain separate
  rollout requirements; this entry does not announce a new POS installer version.
- Preserve Thai cohort names through the operator's UTF-8/DPAPI pipe. Add a real
  Windows round-trip regression and an audited metadata-only correction tool
  which refuses members with assignments and never changes native customers.
