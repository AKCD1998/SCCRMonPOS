# Terminal registration QR (1.3.17)

The customer display uses one public referral per approved branch POS:
`https://sc-official-website.onrender.com/join/r/BBB-PPP`.
Branches 001/003/004/005 each have POS 001/002. The compiled verified stable
Tailscale node selects the referral; SQL addresses, shared databases and copied
local configuration cannot change the QR source. HQ/unknown nodes fail closed.

All eight QR images are bundled; display needs no QR service or network request.
Regenerate with `py tools/Generate-RegistrationQr.py` using qrcode 8.2 and OpenCV
for independent decoding. `--web-output PATH` also copies the identical assets
into the website's backend/public/member-registration/referrals directory.
Desktop checks cover all approved node mappings and resource loading.

Deploy the matching website's terminal-referral migration/routes before releasing
the desktop. The server resolves referrals again on submit and persists source
in the existing signup transaction. It keeps generic legacy links working.
Printable per-terminal signs: `/join/r/BBB-PPP/qr`. These public source labels
are shareable, contain no secrets and do not prove physical customer location.

The existing cashier glow/manual close behavior is unchanged. Fleet commands
wait while the customer QR is open and while staff have unfinished SCCRM work.
Publishing 1.3.17 only announces it; the operator must issue update commands.
