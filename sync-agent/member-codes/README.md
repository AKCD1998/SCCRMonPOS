# Assigned Ada member codes

This optional extension lets a verified SCCRM member use an Ada-assigned
`AR000-######` code as the visible SCCRM member code. The member UUID stays the
identity for sessions, points, claims and purchase history. Existing
`SCM-POINT-v1-` / `SCM-REDEEM-v1-` scanner protocols are unchanged.

Implementation and copy acceptance are separate from live rollout. CI does not
contact HQ, SQL Server, Supabase, AdaPos or Shopee. A successful CI run does not
prove that an AdaPos terminal can find a member. Record native-copy and live
readback evidence independently before declaring an installation ready.

## Authority and code allocation

HQ000 creates the AR code using its verified `ARBCH-######` native format.
Allocation, the new native customer and its owned assignment journal commit in
one SQL transaction. The allocator uses the native primary-key range and unique
collision checks; the application does not assume that Ada clients share its
application lock. `FTSatLastRun` is a branch-format flag, not a numeric counter.
No client chooses an arbitrary AR code or merges a customer from a phone match.

The source identity is pinned to the owned HQ database marker. A tuple binds its
assignment UUID, member UUID, exact AR code, profile fingerprint, HQ identity,
creation time, kind and contract version. Only name, phone and email enter the
profile fingerprint. The tuple SHA256 is an audit binding, not a digital
signature or proof that an untrusted caller contacted HQ.

Three separate permissions enforce that boundary:

- The native source actor reads only the owned HQ assignment journal and an
  assigned-customer snapshot without PIN columns.
- The Supabase authority login persists immutable assignments/canonical metadata
  and invokes two narrow publication capabilities. Separate branch authority
  logins approve those exact tuples but cannot create native customers.
- The existing delivery login consumes an approved tuple through its branch's
  restricted receiver. It cannot mint authority, edit mappings or enable a
  target. The HQ `000` migration credential stays on the operator workstation
  and is excluded from the encrypted service payload.

Passwords never go in arguments, source, status or these documents. Operator
credentials are read from verified existing configuration and remain in memory
or private encrypted runtime files.

## Compatibility and preservation

The original `sccrm_fanout` SC envelopes, checkpoint, jobs, idempotency scope and
append-only mappings stay intact. AR delivery uses the separate private
`sccrm_member_codes` schema and its own fenced queue/checkpoint. The ordinary
path creates new members only, with zero native opening points and the approved
100-calendar-year membership validity. Points rules and bill ownership do not
change.

The only native code-renaming exception is the separately authorized cohort of
two SCCRM-created SC customers. It requires exact UUID/old-code/profile and
ownership checks, no foreign customer references and an immutable native
allowlist. Native code changes are limited to those two owned rows; other
non-PIN columns and old SC audit mappings are preserved. It is not a bulk
renumbering or customer-deletion operation. Unrelated legacy Ada customers are
never propagated by this extension.

Explicitly approved existing Ada links can use `kind=approved_existing` with
`deliver_to_branches=false`. These are publication-only assignments, not a
reason to send legacy customers to branches. The queue also enforces this flag
through a database foreign key. Old SC/SCM codes can remain exact UUID-bound
lookup aliases; arbitrary AR/phone aliases are refused.

## Runtime and publication

The optional `memberCodes.enabled` flag defaults to off. Enabling it requires
the separate authority secrets, owned schema/HQ identity and matching SC/AR
target identities and enable states. Provisioning populates the AR target table;
the worker cannot bootstrap or enable targets itself. Operator enable/disable
updates both target tables atomically. A detected mismatch pauses both engines.

HQ assignments are polled independently each second. Immutable authority state
and durable jobs must commit before the source checkpoint advances. Bounded
backfill reconciles missing jobs for enabled targets after restart or re-enable.
Each branch has an independent lease and retry schedule; offline authorization
or delivery does not block another branch. Code/profile/assignment collisions
are held for review, not automatically merged or renumbered.

Publication runs separately from branch dispatch. It reads only the assigned
native customer, verifies the AR/name/phone/email tuple, refreshes one customer
through the existing customer-only mirror function, and links that exact AR code
to the same SCCRM UUID. No PIN, bill or points-ledger write occurs. If the mirror
link or public profile is missing/conflicting, publication remains pending.
Successful publication changes only `member_profiles.member_code`, saves the
former code as an alias and appends an audit event. It never creates a new user
UUID. Completed publications are not repeatedly refreshed.

The backend alias lookup is gated by
`SC_OFFICIAL_MEMBER_CODE_ALIASES_ENABLED`. Lookup must verify that an alias and
its canonical profile resolve to the same UUID. Alias code is indexed and
unique; no phone-directory scan is required.

## Verification and operations

From `sync-agent`, pure tests run with `node --test member-codes/assignment.test.cjs
member-codes/operator.test.cjs member-codes/service.test.cjs`. Durable tests also
require an explicitly local `sccrm_fanout_test_*` PostgreSQL URL on a non-5432
port in `SCCRM_MEMBER_CODES_TEST_DATABASE_URL`. They create fresh isolated test
databases, use synthetic fixtures and do not call the native copies. CI supplies
this URL using its disposable PostgreSQL service.

Native acceptance additionally needs the fixed, marked SQL copies on HQ. Verify
create/replay, offline recovery, ACK loss, restart, code/phone/profile conflicts,
all original 101 non-PIN columns, exact two-member renaming guards and searchable
membership validity. Native UI acceptance must separately re-run AdaPos's member
search without attaching a customer to a live bill. Copy timings, historical
backfill age and fresh live HQ-commit-to-ACK timing are different measurements.

Only the existing `SCCRMHQMemberFanout` Windows service hosts this extension.
The original `SCCRMHQMemberSync`, SQL Server, AdaPos and Shopee automation stay
running. The update path requires a reviewed clean commit, native-copy proof,
hash-checked staging and a backup of the old code/config/encrypted credentials.
Stage before transferring the new encrypted credentials, then activate the
staged package; do not start enabled code against the old credential envelope.

Read the fanout service's `status/status.json` for sanitized `memberCodes`,
waiting/review counts and source/publication status, or use the explicit
`member-codes/operator.cjs status` command. Pausing the dedicated fanout service
drains in-flight work; queues and native members remain. Disable one branch with
the fanout operator rather than editing SQL enable flags independently.

Rollback restores reviewed application files/configuration and retains all
native members, aliases, queue state and audit records. It does not reverse an
already approved native AR rename. Before reverting to a version without AR
support, coordinate the HQ creator wrapper and pause AR delivery; otherwise new
AR assignments remain queued until the compatible runtime returns. Never delete
customers, reset cursors or drop either queue to roll back code.
