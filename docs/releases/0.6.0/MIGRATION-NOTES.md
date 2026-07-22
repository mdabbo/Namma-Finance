# Database migration notes — 0.6.0

The current SQLite schema is version **23**. Existing migrations are immutable and remain forward-only; this release adds no migration.

Upgrade paths covered by automated tests include populated legacy databases and each sensitive intermediate schema. The complete v0.1 upgrade test applies migrations 0003 through 0023 to the same database and verifies retained client, project, contract, and approved-certificate records, followed by SQLite integrity and foreign-key checks.

Before upgrading:

1. Create a manual backup and retain its SHA-256 checksum.
2. Close all other running NAMAA Finance instances.
3. Install the signed 0.6.0 package and allow startup migrations to complete.
4. Open Settings and verify database schema version 23.
5. Reconcile contract totals, certificate collections, customer credit, and expenses against the pre-upgrade report.

Never edit or remove a migration that may have run on a user database. Any future schema correction must use a new migration number greater than 23.
