# Administrator-requested SCCRM updates

SCProductDev runs `SCCRM-Fleet-Control.exe`. The administrator selects terminals
and clicks **สั่งอัปเดตเครื่องที่เลือก**. This creates durable, device-specific jobs;
neither release announcements nor version polling create install commands.

The console uses a dedicated random admin credential protected for the current
Windows user with DPAPI. The server retains only its SHA-256 hash in the private
`sccrm_fleet` schema. Native terminals use their existing revocable staff-device
session, receive only their own command, and validate the publisher signature,
device policy, node identity and executable hash before replacement.

## One-time bootstrap

Versions through 1.3.13 cannot receive central commands. Install a reviewed,
fleet-capable version once on each terminal after staff have saved their work.
The normal combined installer and optional update button remain available.
Preserve the existing installation directory and `data/staff-config.json`.
The new client enrolls its authenticated staff-device identity and approved
Tailscale node. Duplicate or changed enrollments require review instead of
silently transferring commands to another user or machine.

The console lists all eight approved branch terminals, including terminals that
still need this first installation. It never labels an unenrolled terminal as
successfully updated. No customer, receipt, pharmacy, points or Ada setting is
changed by enrollment or update.

## Save barrier and execution

The tray app polls every 15 seconds. It may download a signed package while staff
work, but waits for API requests, receipt confirmation, owned member-edit forms,
customer QR display and background refund submissions to finish. A loaded,
unconfirmed receipt remains pending work even before a member is selected. An
idle membership window can close.
Readiness is checked again after the final network acknowledgement; work started
during that interval defers installation. The app's gate serializes final exit
against watcher callbacks. No process-name termination, shell command from the
server, AdaPos process control, SQL service change or operating-system reboot is
part of the protocol.

The existing updater waits for this exact SCCRM PID/start time to exit, verifies
the staged file, replaces only `SCCRMonPOS.exe`, retains a backup, and opens SCCRM
again. The new process reports success only when its running executable hash
matches the requested release. A failed replacement reopens the verified original.

Offline terminals retain their jobs for 14 days. Closing the SCCRM window leaves
the tray app running; fully exiting SCCRM defers the job until it next opens.
An offline or failed terminal does not block other terminals. Duplicate requests
and lost acknowledgements reuse the same durable request/job identity.

## Installation and operations

1. Verify the isolated PostgreSQL and native-file update tests.
2. Apply the dedicated backend migration; it defaults to paused and grants no
   access to browser database roles. The existing private backend owner connection
   is the only runtime reader/writer. Do not run unrelated migrations.
3. Build the console, then run `tools/Initialize-FleetConsole.ps1` on SCProductDev.
   Register only the generated public metadata (`id`, `station`, `token_hash`) in
   `sccrm_fleet.admin_keys`. Never export the raw credential.
4. Deploy the reviewed backend and bootstrap a pilot terminal. Enable the queue
   only after verifying the endpoints and its publisher key.
5. Test a real pilot version transition, its save barrier, restart, binary hash
   and continued AdaPos operation before reporting a production rollout complete.
6. Bootstrap remaining terminals; the console displays enrollment, version, last
   heartbeat, target version and pending/succeeded/failed state per machine.

**พักคำสั่งอัปเดต** pauses new installation handoffs. An already handed-off local
file replacement completes. Commands and backups are retained. Restoring the
previous backend/package does not delete these tables or any customer data.
Revoke a console credential by setting its `revoked_at`; issuing a replacement
credential does not require changing POS secrets or the publisher signing key.

After an authenticated poll, the client optionally writes non-secret operational
identity metadata to `Common Documents\SCCRM\device-identity.json`. This contains
only approved node/device identifiers, branch/POS, version, hash and timestamp,
so an SMB operator can verify identity without reading private token files.
