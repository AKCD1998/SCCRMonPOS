# Changelog

## Unreleased

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
