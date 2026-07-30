# Database migration notes — 0.7.0

The desktop SQLite schema remains version **24**. Its shape is unchanged; what
changed is how it is built.

The development migration chain `0001_initial` … `0024_dashboard_snapshot_audit`
is replaced by two files: `0001_baseline.sql` (complete schema, settings
bootstrap, expense-category reference rows) and `0002_seed_reference_data.sql`
(currencies, audit context, version metadata). Twenty-two intermediate
remediation migrations existed only to repair development databases that never
left a developer's machine.

The baseline was **generated, not written**: the real chain was replayed into an
in-memory database and the resulting schema dumped verbatim, then a fresh
baseline database was compared against the chain-built one — all 259 schema
objects identical, reference data equal on every stable column,
`PRAGMA integrity_check` ok, `foreign_key_check` clean, and zero audit rows on a
fresh install. Values the old chain generated per install (expense-category
`sync_uuid`, `updated_at` columns, `device_id`) are generated at install time
rather than frozen into the file.

Schema identity deliberately stays 24 rather than restarting at 1. Renumbering
would leave two entirely different database shapes both claiming version 1 —
the retired `0001_initial` schema and this baseline.

## Existing development databases

**They are not upgradeable and were not migrated.** `tauri-plugin-sql` records
each applied migration with a checksum; an existing database has version 1
recorded against `0001_initial.sql`, which no longer matches. The plugin rejects
the mismatch and the application does not start. This is intentional: it fails
loudly rather than applying a baseline over populated tables.

Delete or move `%APPDATA%\com.mepfinance.app\mep-finance.db` and start the app;
a clean database is created automatically.

Backups taken before this release report `schema_version` 24 exactly like a
rebased database, so the version number cannot separate them. Restore validation
therefore checks the recorded migration lineage and refuses a pre-rebase backup
with `BACKUP_PREDATES_DATABASE_REBASE` **before any file is touched**. To read
such a backup, check out `pre-db-rebase-v0.6.7` and run that build.

The complete pre-rebase source and all 24 migration files are preserved at the
git tags `pre-db-rebase-v0.6.7` and `pre-ui-redesign-v0.6.0`, both pushed to the
remote. Full detail in `docs/DATABASE-REBASE-0.7.0.md`.

The Supabase cloud schema is unchanged by this release.

## Forward migrations after the baseline

The baseline pair (`0001_baseline.sql`, `0002_seed_reference_data.sql`) recreates
schema 24. Everything after it is forward-only and additive; neither baseline
file has been edited, so recorded checksums stay valid.

| File | Stamps | Purpose |
| --- | --- | --- |
| `0003_assignment_lifecycle.sql` | 25 | Explicit assignment lifecycle (`lifecycle_status`, completion/cancellation evidence) separated from `archived_at` visibility. |
| `0004_cancellation_evidence_integrity.sql` | 26 | Makes cancellation evidence tamper-evident (audit remediation). |

### 0004 — why it exists

`earned_minor_at_cancellation` is the frozen figure that decides a cancelled
assignment's committed cost and the balance still owed to the person. Migration
0003 required it at cancellation time but did not protect it afterwards:
`validate_assignment_lifecycle_update` allowed an UPDATE that changed the amount
provided `lifecycle_status` stayed the same, `audit_assignment_lifecycle` only
fires when `lifecycle_status` changes, and the baseline `audit_assignment_update`
watches person/project/agreed/currency/fx/`archived_at` only. A plain
`UPDATE project_assignments SET earned_minor_at_cancellation = <anything>`
therefore rewrote a financial fact and produced **no audit row at all**
(reproduced against schema 25 before the fix).

0004 adds two additive rules:

1. A frozen earned figure may only exist on a `CANCELLED` assignment
   (`FROZEN_EARNED_REQUIRES_CANCELLATION`), on insert and on update.
2. Once cancelled, `cancelled_at`, `cancellation_reason` and
   `earned_minor_at_cancellation` are final (`CANCELLATION_EVIDENCE_IS_FINAL`).

Reverting an already-cancelled assignment is still reported by 0003's
`CANCELLED_ASSIGNMENT_IS_FINAL`, which names the actual problem. Because every
legitimate write of these columns now happens on the transition into
`CANCELLED`, the existing lifecycle audit trigger necessarily captures all of
them and no audit gap remains.

No data is rewritten and no column is dropped, so 0004 cannot lose data. It only
adds triggers and stamps the new schema identity.
