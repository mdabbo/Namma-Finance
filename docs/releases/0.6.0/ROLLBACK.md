# Rollback notes — 0.6.0

Database migrations are forward-only. Rolling back the application binary while retaining a newer database is unsupported because an older binary may not understand schema 23.

Safe rollback procedure:

1. Stop NAMAA Finance completely.
2. Preserve the current database and its WAL/SHM files as incident evidence; do not overwrite them.
3. Use the application's validated restore workflow to restore the pre-upgrade safety backup.
4. Verify the backup checksum, SQLite integrity, foreign keys, application compatibility, and expected schema.
5. Install the previously approved, signed application version.
6. Reconcile financial control totals before entering new transactions.

Do not manually downgrade `PRAGMA user_version`, delete migration history, or copy individual financial rows between databases. If no compatible backup exists, retain the current application/database pair and escalate for a forward-fix migration.
