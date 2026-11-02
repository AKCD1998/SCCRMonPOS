# Ada-authoritative points integration

This directory contains the source reader, native model, global projection,
private PostgreSQL store, and an append-only native receiver. The components have
been tested on local PostgreSQL and marked SQL Server copies. That does not mean
that a production points service or production receiver has been deployed.
Member/profile synchronisation remains a separate service.

## Reading and verifying native data

`Read-NativePoints.ps1` is SELECT-only and accepts no caller-provided SQL. It reads
the approved customer-code/point/home-branch/date fields, the explicit 23-column
`TCNTCstPoint` projection, and `VCN_TCNMPdtCstPointAmt`. It does not read customer
PINs, names, phones, email or health details. Where receiver tables exist, it also
reads their fixed metadata and receipt columns. Partial or unexpected receiver
metadata is refused rather than treated as absent.

The exporter obtains credentials from an injected runtime reader or the existing
verified effective-config operator reader. The operator dependency loads lazily
and is not needed when the runtime reader is injected. Credentials pass through
stdin without being written or displayed. Machine/database identity, native
schema/key and normalized view-definition hash are pinned. Each connection and
command is bounded at eight seconds, with a one-second lock timeout, low deadlock
priority and MAXDOP 1 on data projections. No long source transaction, RCSI change,
firewall change or SQL service restart is used.

Customer, point, view and owned-receipt projections are read twice and exact
fingerprints compared. An unstable capture is held. This is an observed stability
check, **not an atomic multi-query or cross-database snapshot**. Native-view
comparison and the receiver's intrinsic-balance precondition provide additional
checks against a source moving between statements. Failure requires a fresh
read, not an assumed successful capture.

Bigints and numeric values remain decimal strings; database calendar timestamps
keep their calendar fields without a UTC `Z`. Raw exports are gitignored under
`points/runtime/`, protected by a private Windows DACL. Console summaries contain
counts, hashes and sanitized errors. Operator discovery still uses existing
operator credentials; a restricted runtime reader is provisioned separately.

Capture metadata is normalized from PowerShell's seven fractional UTC digits to
ISO milliseconds before validation or storage. PostgreSQL source observations and
delivery freshness comparisons therefore use exactly the same instant. Native
business-calendar dates do not pass through that normalization.

Explicit read-only commands from `sync-agent`:

```powershell
node points/export.cjs Live
node points/analyze.cjs Live
```

The legacy `Copy` default reads only the marked branch-000 UI sandbox. The API
`readSnapshot(branch, { mode: 'Copy', copyKind: 'PointCopy' })` also reads existing
`SCCRM_PointCopy_20261102_000/001/003/004/005` databases on HQ after validating their
copy marker and identity. It creates no copies or DDL. `Provision-PointCopy.ps1`
is a **different, copy-writing operator**, not the SELECT-only exporter. Existing
advanced copies must not be reseeded.

## Native model and global projection

`model.cjs` reproduces the verified native view: `FCCstRetPoint` plus type-1 point
rows minus type-2 point rows when expired and processed flags are both `N`.
Wholesale/daily points and monetary fields are not added to retail points. Other
types do not contribute to the view; unknown nonzero types are held for review,
while zero type-6 rows do not award points.

Balances and transaction points must be integral and representable. Nulls,
fractions, overflow, unsafe JavaScript numbers, view mismatches, orphan owners and
conflicting source evidence are held. The native receiver further limits targets,
deltas and generations to the exact safe-integer range of the native float view
(`abs(value) <= 9007199254740991`). Fractional-point support is not implemented.

`projection.cjs` combines native events identified by originating branch,
customer code, document and supplier. Replicas deduplicate only when **all
business fields** agree. Amount/eligibility or owner conflicts are held rather
than resolved by phone, arrival order or timestamps. SCCRM's previous earnings
ledger is excluded; SCCRM does not calculate a competing award or redemption.

An opening repeated across databases is used once. Conflicting openings require
an explicit source selection, or the opt-in `allowNativeHomeBranch` policy using
the actual native home-branch field and its verified source. The AR prefix and
latest update timestamp do not choose an opening.

An explicit approved `ownerMap` can publish one shared balance across the existing
Ada codes of a previously approved member family. Events are unioned; copied
database balances are not summed. More than one nonzero carried opening inside
a family is held. Missing canonical codes or conflicting ownership mappings are
also held. This does not merge/delete profiles, alter customer codes or create
mappings. The projection's `aliasesMerged:false` means no profile/mapping mutation,
not that approved family points are ignored.

## Owned corrections and loop prevention

`compensation.cjs` verifies the raw native view before deriving an intrinsic
snapshot. A correction can be excluded only when a marked receiver receipt proves
its exact originating branch/code/document/supplier, operation, generation,
previous/target/delta arithmetic, native type and absolute amount, `N/N` flags,
`SCCRM_POINT_SYNC_V1` insertion user, zero rate/amount and prior native balance.
The insertion-user label alone never proves ownership. A zero-delta receipt must
have no native point row.

Only proved correction rows are removed and their delta subtracted from the
captured view. An exact replica in another database can be excluded using its
verified origin receipt; a changed replica is held. Missing or altered owned rows,
unexpected metadata or unverified actual views fail closed. A previous global
correction therefore cannot become a new purchase award on the next read.

Mathematical exclusion is separate from operational delivery. If a proved owned
correction appears in another source, the store durably holds that code and its
approved family with `POINT_FOREIGN_PROJECTION_REPLICATION_REVIEW`. It does not
counter-adjust the foreign copy: an ongoing vendor replication path could cause
alternating corrections forever. Pure analysis still exposes the intrinsic
balance, while the operational cache is review/null and queued delivery is fenced.

`native-receiver.sql` is an append-only receiver: it adds a separate native point
transaction and receipt, not an update to `TCNMCst` or original point records. Its
target identity, expected intrinsic balance, operation identity and monotonic
generation guards protect retries, concurrent native purchases and late older
operations. It has been exercised against marked copies; production provisioning
and service cutover are separate work.

## Private durable store

`schema.sql` and `store.cjs` persist current source snapshots, source hash/count
audit, immutable source openings, native events, balances, a change journal and
global health. `applySnapshots` requires all five verified sources, recomputes the
supplied projection and writes under one transaction/advisory lock. Lost
acknowledgements can be replayed. Missing historical events are retained and held,
never deleted or silently subtracted into a ready balance.

`source_openings` establishes each source/code's initial retail opening once.
A later opening change, including on a non-home copy, holds that code and its
approved family. A native point changing its processed flag from `N` also holds
the code/family, because a vendor period-end may have folded it into carried
points. These review reasons persist across replays and value reversions; no
opening-baseline reset or vendor-rollup approval workflow is implemented here.
An ordinary expiry flag change remains native expiry math, not an assumed rollup.

`balance_values.generation` advances only when a code's projection version changes.
It is allocated from a monotonic PostgreSQL sequence and recorded in the same
journal entry; rollback can leave harmless sequence gaps. Unchanged replays and
owned-correction acknowledgements preserve generation. Journals and changed native
events are written in batches. Quiet cycles update five source observation rows
and one global heartbeat without rewriting snapshot payloads, balances, opening
baselines or audit entries.

The `balance_cache` security-invoker view uses the oldest of five observations.
An unavailable global state preserves that age and hides usable balances. All
nine tables have RLS and PUBLIC/anonymous grants are revoked. A reader needs
explicit schema/view/underlying-table privileges and policies. No broad
runtime/API role is created by `schema.sql`; deployment grants and policies must
be provisioned explicitly. Runtime opening-baseline access needs SELECT/INSERT,
not UPDATE/DELETE.

## Tests and evidence

Pure tests and the isolated localhost PostgreSQL integration:

```powershell
node --test test/ada-native-points-model.test.cjs test/ada-native-points-export.test.cjs test/ada-native-points-compensation.test.cjs test/ada-point-projection.test.cjs
$env:SCCRM_POINTS_COPY_TEST='1'
node --test test/ada-native-points-store.integration.test.cjs
```

The opt-in store test first validates local `127.0.0.1:55502/sccrm_points_copy`, then
creates a fresh child database. It never connects to SQL Server or Supabase. It
covers replay, late native awards, flag changes, contradictory replicas, owner
changes, removal holds, transaction rollback, lost ACK, connection restart,
generation stability, proved correction/replica loop prevention, opening/processing
rollup holds, RLS and immutable original source/user/807-point-ledger fixtures.

Private evidence files include:

- `runtime/store-copy-result.json`: focused PostgreSQL copy checks.
- `runtime/native-copy-result.json`: native receiver checks and hashes proving all
  13,907 original point rows and 101 non-PIN profile columns remained unchanged.
- `runtime/native-point-copies/export-copy-summary.json`: marked native-copy reads.
- `runtime/native-point-copies/recompute-result.json`: all-five copy recomputation;
  example `AR000-000017` is intrinsic 7+3=10, with zero owned SP correction rows in
  the native-event projection.

These reports demonstrate their stated copy tests. They do not establish a
production deployment, live UI verification or a production latency guarantee.
