Approved customer contact aliases
===============================

`contact-phones.cjs` is an admin maintenance SQL generator, never a public API
or a worker action. Supply an explicitly approved member/code/primary/alternate
tuple. Keep customer data, generated SQL and native before/after evidence outside
Git. Test generated SQL on an owned native copy before applying it live.

Ada's 50-character telephone field stores `primary;alternate` on the same AR
customer. A 9-digit alternate is retained only for staff searching, not as an
authenticated phone. The approval table binds the exact native representation
to the existing member, code and immutable 10-digit assignment phone. Native
name, email, code, points, bill ownership and all other customer columns stay
unchanged. No runtime user receives write access to these approval tables.

The installer accepts only the reviewed existing procedure shapes and checks
their exact definition bytes inside a transaction (compatible with SQL
Server 2008 R2, without HASHBYTES' 8 KB input limit). It patches HQ create replay, HQ assignment snapshot and branch
assignment receipt replay, plus receipt attachment and snapshot contact checks.
Snapshots and acknowledgements still emit the
immutable primary phone; a changed unapproved native phone still fails review.
Legacy SC migrations and general profile validators retain their exact checks.

Apply all target installations first, then the approved tuples with `applySql`.
Replays are idempotent, conflicting approvals or changed customer phones abort.
Verify both numbers against the native lookup, SCCRM directory and staff search,
then replay assignment acknowledgements and check the running sync queues.
Re-provisioning base member-code procedures requires reinstalling this extension
with reviewed current definitions; do not run the base provisioner blindly over
an installed contact extension. A rollback restores only the original telephone
when it still equals the exact approved representation, then restores the saved
original procedures. Never roll back a subsequent Ada edit or a point balance.
