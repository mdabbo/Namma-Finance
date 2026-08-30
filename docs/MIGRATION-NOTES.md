# Migration notes

The current schema identity is **27**, built by five forward-only migration
files. `PRAGMA user_version`, `app_metadata.schema_version`,
`CURRENT_SCHEMA_VERSION` in `src-tauri/src/lib.rs` (27) and
`CURRENT_MIGRATION_VERSION` (5, the highest migration file) must always agree;
`test/migrations.test.ts` and `test/release.test.ts` assert it.

| # | File | Schema after | Purpose |
| --- | --- | --- | --- |
| 1 | `0001_baseline.sql` | 24 | Complete schema: tables, indexes, views, triggers, settings bootstrap, expense-category reference rows |
| 2 | `0002_seed_reference_data.sql` | 24 | Currencies, audit context, version metadata, `PRAGMA user_version` |
| 3 | `0003_assignment_lifecycle.sql` | 25 | Assignment lifecycle columns and constraints |
| 4 | `0004_cancellation_evidence_integrity.sql` | 26 | Cancellation evidence integrity |
| 5 | `0005_audit_version_baseline.sql` | 27 | Truthful audit application version |

## Which databases must be recreated

**Every database created before the v0.7.0 rebase, and every development
database created from an earlier v0.7.0 commit.** v0.7.0 is unreleased, so no
production database is affected.

| Database | Action |
| --- | --- |
| Pre-rebase (v0.6.x, migration chain `0001_initial`…`0024_*`) | **Recreate.** The plugin rejects the version-1 checksum mismatch and the app will not start. See [DATABASE-REBASE-0.7.0.md](./DATABASE-REBASE-0.7.0.md). |
| v0.7.0 development database that already recorded migration 5 with the **previous** `0005` checksum | **Recreate.** See below. |
| v0.7.0 development database that stopped at schema 26 (migration 5 never applied) | Upgrades normally — the corrected `0005` applies cleanly, including when finalized 0.6.x audit rows are present. |
| Fresh database on this build | Nothing to do: it is created at schema 27. |

### Why the previous `0005` checksum means a reset

`tauri-plugin-sql` records a checksum per applied migration. `0005` was
corrected in place (it is unreleased and appears in no release tag), so its
checksum changed. A database that already recorded version 5 under the old
checksum will be rejected at startup with a checksum mismatch. That is the
intended, loud failure — the baseline checksum policy is unchanged and no
migration file that has ever shipped is rewritten.

To reset, move the database aside and start the app; it recreates a clean
database at schema 27:

```powershell
$root = "$env:APPDATA\com.mepfinance.app"
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$dest  = Join-Path $root "reset-backup-$stamp-schema27"
New-Item -ItemType Directory -Path $dest | Out-Null
Move-Item (Join-Path $root "mep-finance.db") (Join-Path $dest "mep-finance.db")
```

## The schema-27 audit-version migration

`0005` makes new audit rows carry the shipping version, through three points:

- **`audit_context.application_version`** — set to `0.7.0`; this single row
  drives every subsequent stamp.
- **`finalize_audit_insert`** — recreated so its `COALESCE` fallback is `0.7.0`
  instead of the retired `0.6.3`.
- **Runtime stamping** — `stamp_runtime_release()` writes
  `CURRENT_APP_VERSION` into `audit_context` at startup, so the value tracks the
  binary rather than a literal frozen in SQL.

### What it deliberately does not do

It does **not** rewrite historical `audit_logs` rows. An earlier draft carried:

```sql
UPDATE audit_logs SET application_version='0.7.0'
WHERE application_version IN ('0.6.0','0.6.3');
```

`prevent_audit_update` permits exactly two shapes — finalising a fresh row
(`finalized` 0 → 1) and binding a `NULL` `entity_uuid`. An
`application_version` rewrite on a finalized row matches neither, so the
statement raises `AUDIT_LOG_IMMUTABLE`, the whole migration aborts, and
`user_version` stays at 26: a database that can never reach schema 27 and that
the app will not open. This was reproduced on a schema-26 database holding one
finalized `0.6.3` row before the correction was made.

Two things were rejected as fixes:

- **Suppressing or relaxing the trigger** to force the rows through. Audit
  immutability is the property the log exists to provide; a migration that
  switches it off, even briefly, makes "append-only" conditional.
- **Rewriting the rows by any other means.** A row stamped `0.6.3` is *true* —
  that row really was written by a 0.6.x-era binary. Restamping it would replace
  an accurate record with a tidier falsehood.

Historical rows therefore keep the version that wrote them, and everything from
schema 27 onward is stamped `0.7.0`.

## Rules for future migrations

1. **Never write to `audit_logs` from a migration** — not `UPDATE`, not
   `DELETE`. `test/migrations.test.ts` fails the build if a top-level statement
   in `0005` does.
2. **Never drop or weaken `prevent_audit_update` / `prevent_audit_delete`**,
   even temporarily.
3. **Never edit a released migration.** Correcting an unreleased one in place is
   allowed (and was done here) but requires documenting the reset above.
4. **Do not add a later migration to repair what an earlier one failed to do** —
   if the earlier migration aborts, the later one can never run.
5. Keep schema constants, migration count, docs and tests in agreement.
