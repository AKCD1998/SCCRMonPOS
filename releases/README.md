# Optional desktop update channel

`stable.json` is created only by an explicit administrator publish command.
It is an RSA-SHA256-signed envelope pointing to an immutable GitHub release
asset. Missing/unreachable/invalid manifests never prevent normal membership use.

Clients check 15 seconds after startup and every five minutes. They notify once
per release per day; downloading/restarting requires a staff click. Version
numbers are labels: a recommended older signed binary can be offered as a
rollback, with the same opt-in behavior and without changing the database.

See `docs/CUSTOMER_DISPLAY_AND_UPDATES.md` for bootstrap, publishing and rollback.

## Automatic StockDay download center

`web-catalog.json` is a separate RSA-SHA256-signed envelope, using the same
existing administrator key. Its payload contains `schemaVersion: 1`,
`generatedAt`, `recommendedReleaseId`, and up to 100 `releases` with publication
dates, plain-text highlights, `deviceAccessVersion`, and installer URL/hash/size.
Legacy releases remain historical notes without installer links.

`tools/Publish-PosRelease.ps1` now builds Setup as well as the desktop executable,
uploads all release assets, verifies the published installer digest, generates
the website catalog, and commits both announcements together. The catalog is
published only after the installer exists. The first three bullet points in the
release notes become website highlights; notes without bullets use their first
three non-empty lines. No StockDay or shared-backend deployment is required for
subsequent releases. The website checks for new signed metadata every minute.

An explicit rollback changes the recommended desktop and website version
together. The website labels a rollback as recommended, rather than latest.
To import already-published releases once, run
`./tools/Update-WebReleaseCatalog.ps1 -Bootstrap`, verify the result, and commit
`releases/web-catalog.json`. This downloads old installers only to verify hashes;
it does not execute or install them. The normal publish command maintains the
catalog thereafter. Never change `stable.json` manually when announcing a new
release; use the publishing command so both channels stay consistent.

If publication creates a GitHub release but a later step fails, the old website
recommendation remains in place. Inspect the existing release before retrying;
do not recreate or overwrite its assets. With its staged `stable.json` and Setup,
run `Update-WebReleaseCatalog.ps1 -ReleaseId <tag> -ManifestPath <manifest>
-InstallerPath <setup> -RecommendReleaseId <tag>`. Copy that staged `stable.json`
to `releases/stable.json`, then review, commit and push **both** announcement
files together. The normal publisher requires a clean checkout, so do not call
its rollback path while these recovery files are still uncommitted. If the
announcement commit already exists and only its push failed, inspect/fetch the
remote and push the existing commit instead of generating another release.
