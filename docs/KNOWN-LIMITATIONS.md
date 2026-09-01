# Known limitations

Current as of v0.7.1 (Beta), schema 28. Each entry states what the limitation
is, why it exists, and what to do about it.

## Database and migrations

### Pre-rebase and early-v0.7.0 databases are not upgradeable

Databases from the v0.6.x migration chain, and development databases that
recorded migration 5 under the previous `0005` checksum, are rejected at
startup with a checksum mismatch and must be recreated. This is deliberate: the
alternative is applying a baseline over a populated database.

See [MIGRATION-NOTES.md](./MIGRATION-NOTES.md) for the full table and the reset
procedure. v0.7.0 is unreleased, so no production database is affected.

### Historical audit rows keep their original application version

Rows written by a 0.6.x-era binary remain stamped `0.6.0` or `0.6.3`. They are
not restamped, because `audit_logs` is append-only by trigger and because the
old stamp is factually correct for those rows. Rows written from schema 27
carry `0.7.0`; rows written from schema 28 onward carry `0.7.1`.

Consequence: `application_version` in `audit_logs` is a record of *what wrote
the row*, not of the schema the database currently has. Reports that group by
application version should expect a mix on any database that predates schema 27.

### Pre-rebase backups are refused

A pre-rebase backup reports the same `schema_version` as a rebased database, so
the version alone cannot distinguish them. Restore validation checks the
migration lineage in `_sqlx_migrations` instead and fails with
`BACKUP_PREDATES_DATABASE_REBASE` before touching any file. To read such a
backup, check out the `pre-db-rebase-v0.6.7` tag and run that build.

## Financial records

### Role enforcement is client-side

Roles (ADMIN / ACCOUNTANT / ENGINEER) gate the UI. The shared Supabase database
still grants full access to any authenticated office login; per-role row-level
security is not yet implemented. See `docs/supabase-roles.sql`.

### The app lock does not encrypt the database

`set_app_lock` protects the application door with Argon2id. The SQLite file
itself is not encrypted, so anyone with filesystem access to the Windows account
can read it. Database or volume encryption is a separate deployment option.

### Older sync peers may not advertise protocol metadata

v0.7.1 clients can publish application version, schema version, and financial
protocol version through the optional `sync_peers` table. Older clients, or
Supabase projects that have not applied `docs/supabase-0018-sync-peers.sql`,
cannot provide that proactive signal.

This does not permit silent financial corruption: protected financial pulls
still pass through the local Rust domain validation paths. Invalid incoming
certificate, payment, allocation, assignment, person-payment, expense, approved
revision, and variation-order mutations are preserved as reviewable
`REMOTE_DOMAIN_REJECTED` conflicts instead of being applied.

## Mobile companion

The Expo app is **read-only** by design and is pinned to Expo SDK 54 because
that is the newest SDK the public Expo Go client supports. Arabic renders with
LTR layout, and there is no standalone APK yet. See
[PHASE4-MOBILE.md](./PHASE4-MOBILE.md).
