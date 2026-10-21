# Optional desktop update channel

`stable.json` is created only by an explicit administrator publish command.
It is an RSA-SHA256-signed envelope pointing to an immutable GitHub release
asset. Missing/unreachable/invalid manifests never prevent normal membership use.

Clients check 15 seconds after startup and every five minutes. They notify once
per release per day; downloading/restarting requires a staff click. Version
numbers are labels: a recommended older signed binary can be offered as a
rollback, with the same opt-in behavior and without changing the database.

See `docs/CUSTOMER_DISPLAY_AND_UPDATES.md` for bootstrap, publishing and rollback.
