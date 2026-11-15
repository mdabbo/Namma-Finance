# Rollback notes — 0.8.0

A database upgraded to schema **30** cannot be opened by a 0.7.1 build, which
expects schema 29. It refuses with `SCHEMA_VERSION_MISMATCH`. Rolling back the
build alone is therefore not enough.

To return to 0.7.1: restore the Settings → Backup taken before the upgrade, and
run 0.7.1. Keep each database with the build that created it.

Sync is not reversible in the cloud: once a 0.8.0 device has pushed
`stage_progress_log` rows, a 0.7.1 device ignores them, but the rows remain.
