# Rollback notes — 0.7.0

Database migrations are forward-only. Do not downgrade `PRAGMA user_version`,
edit migration history, or copy individual financial rows between databases.

## Rolling back the application

0.7.0 replaced the migration chain, so rolling back is a **build** change, not a
database change. Check out `pre-db-rebase-v0.6.7` (or `pre-ui-redesign-v0.6.0`
for the pre-redesign tree), rebuild, and use a database created by that build.

A database created by 0.7.0 cannot be opened by a pre-rebase build: its
`_sqlx_migrations` lineage records `baseline_schema` at version 1, which those
builds do not recognise. Likewise a pre-rebase database cannot be opened by
0.7.0. Keep each database with the build that created it.

## Rolling back data

Close every NAMAA Finance process, preserve the current SQLite database together
with its `-wal` and `-shm` files, and restore a validated backup created by the
**same** application line. Confirm the backup checksum,
`PRAGMA integrity_check`, foreign-key integrity, and financial control totals
before entering new transactions.

Restore refuses a backup whose migration lineage predates the rebase, failing
with `BACKUP_PREDATES_DATABASE_REBASE` before it touches the live file. That
check is a safeguard, not an error to work around: restoring such a backup would
leave an application that cannot start.

## Cloud

Supabase schema is unchanged by this release, so no cloud rollback is required.
If an incident involves synchronization, disable automatic sync, preserve both
local and cloud evidence, and apply a forward repair rather than dropping
financial tables or constraints.
