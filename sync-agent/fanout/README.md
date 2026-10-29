# HQ-to-branch membership fanout

This independent add-on consumes only the committed `SCCRM_LiveMemberLink`
creation log on HQ000. It never scans the legacy customer directory for outbound
delivery, changes points, reads customer PINs, replaces the current live worker,
or uses a desktop/browser. Native Ada's old batch customer tasks were observed
but not enabled: no bounded one-member create/acknowledgement contract was proven.

The dedicated service is `SCCRMHQMemberFanout`, under `LocalService` in Session 0.
Its folder is `D:\SCCRM-HQ-LiveSync-20261024\fanout`. Existing Node/pg binaries
in the parent folder are shared read-only; child processes belong to this service's
own Windows job object. Stopping this service affects no other service/process.

## Authority and preservation

- Source: only native SCCRM creations with full member UUID and its exact
  `SC-<first16 UUID hex>` HQ code. Initial discovery found three such rows, not
  all 1,443 HQ customers. The known historical synthetic UUID is durably held.
- Destinations represent actual databases, with a distinct owned identity marker
  for each one. Two different branch servers are named POSSRV; machine name alone
  is insufficient. See `BRANCH_DISCOVERY.md` for config/SQL provenance.
- A private `sccrm_fanout` schema in the existing Supabase stores immutable source
  envelopes, per-target jobs, attempt events, mapping and a source checkpoint.
  Runtime grants are scoped to this schema with RLS, append-only mapping and
  column-limited lease/state updates. The runtime cannot enable destinations.
- Each destination has its own non-privileged SQL login, an owned target marker
  and member-link table, and one static receiver procedure. Native direct
  SELECT/INSERT/UPDATE/DELETE/ALTER and customer PIN access are denied.
- The procedure creates only a previously absent customer, with HQ home branch
  000, zero opening points, and whitelisted profile fields. It never rewrites,
  deletes or renumbers a native customer, changes bills, or transfers points.
- A pre-existing code/phone or changed source/native profile goes to review.
  Phone matching never creates a mapping. Existing AR codes need explicit human
  selection; this automatic create-only path cannot approve or merge them.

## Delivery and recovery

The source is polled independently every second. It does not wait for the older
30-second outbound or five-minute purchase-history loop. A source checkpoint is
advanced only after the immutable envelope and jobs are committed. Source UTC
timestamps and canonical lowercase UUID ordering match SQL Server and Postgres.
Enabling a later destination catches up only approved persisted source envelopes.

Each target has an independent fenced lease. Workers use SKIP LOCKED and unique
member/target keys. An offline branch retries with exponential backoff up to five
minutes without blocking healthy branches. Connection loss after a native commit
replays the same native mapping and compares actual name/phone/email; it cannot
create another row. Identity/profile mismatches and unknown errors are held.
Pausing/disabling or restarting preserves queued work and all native customers.

Secrets are read during explicit provisioning from verified existing configuration,
kept in memory, and encrypted at rest. The HQ bootstrap uses machine-DPAPI-protected
RSA plus authenticated hybrid AES encryption; no key/password goes in command
arguments or source. Do not print the result of `admin-source.readAdmin()` or
`secrets.localSecrets()`.

## Verification before rollout

The copy lab creates only `SCCRM_FanoutCopy_20261029_<branch>` databases on HQ,
with 101 non-PIN customer columns copied from each native database. It never
backs up/restores production or opens MDF/LDF files. A copy-only database user
cannot access AdaAcc. Original sources and copies have independent typed row
hash baselines, with exact original-code preservation checked after tests.

On 29 October 2026, core queue tests passed 22/22; native copies passed 70/70.
Actual receiver create/replay and mapping were exercised for 001/003/004/005,
including offline/reconnect, lost acknowledgement, worker restart, duplicate
phone, code collision, changed native name, lease expiry and stale acknowledgement.
All original copied rows retained all 101 non-PIN columns. The copy source-commit
to ACK measurements were 5.932 / 5.971 / 5.948 / 5.922 seconds respectively.
These are copy measurements, not a claim of fresh production SLA or native UI
acceptance. Deployment must separately verify Session 0, an actual service-only
restart, live SQL readback and the AdaPos member-search screen.

Local core tests: `node --test fanout/engine.test.cjs fanout/copy-lab.test.cjs fanout/worker.test.cjs`.
The opt-in `engine-postgres.test.cjs` requires a fresh local `sccrm_fanout_test_*`
database. Native integration accepts only fixed owned SQL copies and a fresh local
Postgres database. All runtime/raw reports stay in ignored, private `runtime/`.

## Explicit operator commands

From the reviewed repository's `sync-agent` folder:

1. `node fanout/operator.cjs provision-copy`
2. `node fanout/operator.cjs test-copy`
3. `node fanout/operator.cjs provision-live 005 001 003 004`
4. `powershell -NoProfile -File fanout/Deploy-Service.ps1`
5. Install only the dedicated service from the staged, hash-verified package.
6. `node fanout/operator.cjs transfer-secrets`
7. `node fanout/operator.cjs enable 005`

All destinations start disabled. Validate the real 005 pilot first, then enable
only destinations that passed copy tests, current connection/identity checks and
live readback. Provisioning alone writes no native customer rows. Normal updates
must use a reviewed new package; the initial deployer refuses an existing folder.

## Status, stop and rollback

Read `D:\SCCRM-HQ-LiveSync-20261024\fanout\status\status.json` on HQ, or run
`node fanout/operator.cjs status` on the authorized operator workstation. Status
shows source/target counts, waiting/review reasons and exact member/code identity;
it never includes passwords or phone/email. Protected SQL queue/mapping and
native links retain the detailed audit trail.

On HQ, stop only `sc.exe stop SCCRMHQMemberFanout`, or choose that exact service
in Services. Resume with `sc.exe start SCCRMHQMemberFanout`. Disable one target
with `node fanout/operator.cjs disable 005`; no customer/mapping is removed.

Rollback means stop this add-on or restore its previously reviewed code while
retaining encrypted credentials, queue and mappings. Do not delete native rows,
drop the queue, reset checkpoints or re-run broad Ada customer sync as rollback.
Existing members remain searchable. AdaPos commonly requires re-running its
customer search after delivery; prove the actual behavior at pilot time, and do
not select a customer onto a live bill merely to demonstrate search.

Production timing reports must distinguish historical catch-up age (HQ commit
may be days earlier), queue-to-receipt time and a genuinely new HQ creation. A
fresh live <10-second claim requires a new real verified member event; synthetic
customers may be created only in the copies.
