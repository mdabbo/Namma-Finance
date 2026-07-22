# Rollback notes - 0.6.7

Database migrations are forward-only. Do not downgrade `PRAGMA user_version`, remove migration history, or manually copy individual financial rows.

For a safe rollback, close every NAMAA Finance process, preserve the current SQLite database together with its WAL and SHM files, and restore a validated backup created by the target application version. Confirm the backup checksum, `PRAGMA integrity_check`, foreign-key integrity, and financial control totals before entering new transactions.

Supabase schema additions should normally remain in place because they are backward-compatible constraints and columns. If an incident involves cloud synchronization, disable automatic sync, preserve both local and cloud evidence, and use a forward repair rather than dropping financial tables or constraints.
