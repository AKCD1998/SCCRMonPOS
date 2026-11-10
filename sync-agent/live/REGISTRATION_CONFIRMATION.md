# Cashier registration confirmation — unreleased

The desktop asks **เคยสมัครไว้แล้วใช่ไหม?** whenever its authenticated
preflight finds an exact normalized contact phone, regardless of name spelling.
It shows each name, phone and code. Choices are **ใช่ ใช้ชื่อเดิม**,
**คนละคน สมัครใหม่**, and **กลับไปแก้ข้อมูล**. No choice is auto-submitted.
An inactive candidate is visible but cannot be selected as an active member.
Public QR pages never expose this staff-only candidate directory.

The server signs a ten-minute review binding the device, request UUID, draft
and candidate snapshot. The confirmation transaction rechecks these and locks
the selected identity. Selecting an existing SCCRM member returns its UUID
without overwriting its profile. Selecting an unlinked mirrored HQ Ada customer
creates its SCCRM directory identity and exact AR link. One exact-name pending
SCM signup may instead retain its UUID and previous-code alias after the
cashier explicitly selects that Ada entry. Conflicting claimed-bill ownership
refuses the operation. Existing-member medical drafts require an explicit edit.

Selecting a different person creates a separate UUID. If the unique account
phone is already occupied, `users.phone_number` stays NULL for the new person
and the verified-format contact goes into `member_profiles.contact_phone`.
Search/profile/edit and the Ada directory view read this contact. It does not
become another person's account login. Existing phone/email uniqueness is kept.

Private `sccrm_registration.confirmations` records the staff choice. A new
separate-person approval is valid only for its original name/phone/email hash.
The HQ worker bypasses phone-based matching only with that valid approval.
The native journal stores its request UUID and `hq_create_distinct` kind;
the immutable authority tuple hashes that kind. Branch approval and delivery
retain UUID, AR code, profile and replay checks. Legacy Ada profiles are never
overwritten. A changed draft/expired review must be reviewed again; a changed
profile before native creation is held rather than automatically linked.

## Validation recorded 2026-11-10

- Website: 110 checks in six Jest suites, including twelve tests using an
  isolated real local PostgreSQL database, migration replay/old enum upgrade,
  both choices, contact search/edit, exact multiple-phone matching, inactive
  rows, concurrent/lost-response retries, stale/tampered/other-device reviews,
  bill-owner conflicts and rollback.
- Desktop: `DesktopFeatureCheck` 188 checks and `MemberApiCheck` 23 offline
  contracts. Popup preview is generated at
  `build-verify/desktop-feature-check/previews/registration-choice.png`.
- Worker/authority: 68 passed, one unrelated optional adoption integration
  fixture skipped. Real local PostgreSQL queue/runtime tests include the new
  kind, restart, lost acknowledgement, fencing and independent offline targets.
- `node sync-agent/live/test-registration-native-copy.cjs`: 11 native checks on
  the marked HQ/005 SQL copies. Restricted create/delivery, separate AR code,
  replay, native lookup SQL eligibility and binary comparison of every old
  non-PIN column pass. All copy DDL and synthetic rows roll back. Evidence is
  `build-verify/registration-native-copy-result.json`.

These tests do not assert a live installation or live AdaPos screen result.

## Release order

Keep both feature gates off until every required component is in place. Do not
apply old fast-lane migrations merely because they accompany this branch:
that baseline was already verified against the running HQ service.

1. Review/commit the website and native changes; publish through the normal
   signed release/build process. Build tools require a committed source ID.
2. Apply only website migration
   `20261110091654_member_registration_confirmation.sql` in one transaction with
   the supplied short lock timeout. Verify private audit RLS, account-phone
   index, exact view contract and worker column/SELECT grants.
3. Back up the current owned native module definitions/configs. Re-provision
   the verified marked HQ/branch scopes with the standard target allowlist.
   `Provision-Native.ps1` runs the additive `RegistrationSchemaUpgrade.sql`
   before replacing owned procedures. No customer DML is performed by this
   provisioning operation. Apply the source compatibility wrapper through
   `Apply-Compatibility.ps1`, retaining its exact rollback backup ID/hash.
4. Deploy the worker/RPC, fanout assignment validator and matching API. Preserve
   all live secrets, configured endpoints, two-second member lane, unrelated
   history/points config and service identities. Set the HQ worker
   `registrationConfirmationEnabled=true` only after native scopes/grants are
   checked. Restart only owned SCCRM sync processes required to load this code.
5. Enable API `SC_OFFICIAL_MEMBER_REGISTRATION_CONFIRMATION_ENABLED=true` and
   verify staff-only preflight, search and an already confirmed live identity.
   Update one idle SCCRM terminal first, then the rest. The new desktop's
   signup requires the new endpoints; do not ship it ahead of backend readiness.
6. With an actual customer and cashier present, verify an approved choice in
   SCCRM and SQL/AdaPos. Do not create synthetic contacts on production.

To pause this feature, disable the API gate, stop dispatch of the new desktop
release, and restore the prior desktop where needed. Disable the worker gate
only after pending `hq_create_distinct` entries have been inspected. Preserve
confirmations, contact phones and completed AR assignments. To roll back
owned procedures restore reviewed module backups/compatibility backup with
the current-hash guard, without dropping customer rows, aliases or journals.
Never remove new shared-contact members or reassign old bills as rollback.
