# Changelog

## Unreleased

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
