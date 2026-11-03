# Fast HQ membership path

The member lane polls every 2 seconds using its own PostgreSQL connection and
hidden SQL RPC process. The five-minute customer/history import has separate
connections and cannot occupy that lane. The existing fanout service continues
to consume the immutable HQ creation journal and dispatch each branch separately.
No AdaSmart window, desktop action or POS client upgrade is required.

For an online, responsive HQ and online branches, 10–20 seconds from a valid
SCCRM registration to branch delivery is the operational target, not an
unconditional deadline. Measure registration `users.created_at`, native HQ
`assigned_at`, and each durable job's `completed_at` independently. SQL/network
failures, offline branches, backlog and identity conflicts can take longer.

## Existing Ada customers

The private migration adds a narrow capability for `sccrm_hq_live_sync` only.
An active personal Ada customer may be linked automatically when normalized
name and telephone agree, other supplied personal data do not conflict, and
there is exactly one unowned code or one previously consolidated synthetic
identity. Automatic matches additionally require a verified staff-device
registration or a public QR contact with no email, password, verification or
portal session. A self-claimed app/email login requires explicit admin linkage
and cannot obtain old purchase history from a name/phone match. Linking never
upgrades a QR contact's authentication or fills in its login email.
The selected customer is read again from the pinned HQ SQL source
without PIN before publication. A stale source/member fingerprint aborts.

If a synthetic imported contact owns the code, the registered SCCRM UUID and
its login are retained. Only an imported contact with no phone/email/login,
session, health/consent record, points or claims may be retired. Its profile
and previous link approvals are preserved in audit metadata, and every already
approved Ada code follows the registered UUID. Original Ada rows, native codes,
bill owners, source history, point balances and user profiles remain unchanged.

An explicit admin link on the member website is also picked up without another
registration. The publication keeps the old SCM code as an exact UUID-bound
lookup alias. Company/person conflicts, multiple unowned codes, other canonical
owners, real personal-data conflicts and active-account conflicts stay in review.

Legacy publication uses `approved_existing` and `deliver_to_branches=false`.
It does not bulk-copy old Ada customers or overwrite an existing branch profile.
The fast all-branch delivery target applies to new HQ-created AR000 members;
legacy codes remain mapped to the databases in which they already exist.
An expired legacy Ada card is not renewed as a side effect of linking.

## Installation, status and rollback

1. Apply the ordered `supabase/migrations` scripts for fast existing links,
   the temporary publication fence, registration provenance and verified
   legacy-device provenance. The provenance scripts safely restore the narrow
   publication grant while retaining authenticated older POS devices.
   Apply only after the isolated-copy proof passes with the exact file digests.
   The private schemas and dedicated runtime role must already be owned.
2. Back up the owned HQ package and manifest. Replace only the reviewed live
   worker, RPC, scheduler, existing-member helper and polling configuration.
   Preserve encrypted credentials, source identity and every other service.
3. Restart only `SCCRMHQMemberSync`; the fanout, points, AdaPos, SQL Server and
   Shopee processes remain running. Read `live/status/status.json` and the
   append-only `live/status/member-outcomes.jsonl` for the two lane states and
   observed/confirmed times. The encrypted runtime directory is unchanged.
4. To pause only this member/history service, use its existing
   `live/runtime/pause.request`, or stop `SCCRMHQMemberSync`. This does not stop
   AdaPos, SQL Server or Shopee. For rollback restore its backed-up files and
   polling config, then restart that service. Leave the additive private
   functions and completed member links in place; do not delete customers,
   assignments or purchase history to roll back code.

Existing cards at a POS need a fresh member search to pick up current database
results. Do not promise that a modal already open in AdaPos refreshes itself.
