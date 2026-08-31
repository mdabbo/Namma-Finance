# Database migration notes — 0.7.0

The baseline pair recreates schema **24** — its shape is unchanged; what changed
is how it is built. Forward-only migrations then carry the schema to **27**; see
"Forward migrations after the baseline" below.

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

A pre-rebase backup reports `schema_version` 24 — the same identity the
baseline recreates — so the version number alone cannot separate a pre-rebase
database from a freshly rebased one before the forward migrations run. (A
current 0.7.0 database reports 27, but a backup is restored *before* anything
carries it forward, so the number is not a safe discriminator.) Restore
validation therefore checks the recorded migration lineage and refuses a
pre-rebase backup with `BACKUP_PREDATES_DATABASE_REBASE` **before any file is
touched**. To read
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
| `0005_audit_version_baseline.sql` | 27 | Records the shipping application version on new audit rows (release remediation). |

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

## Cash KPI definitions (milestone 4)

The dashboard headline was labelled **Cash Collected** but calculated
`Σ project.totalActualCashInEgp` — every incoming payment, including advances,
retention releases and customer money not yet allocated to a certificate. That
overstated certificate collection. Finance Overview ("Cash in") and Payments
("Cash collected") repeated the same label over the same total.

**Model adopted — headline total with its components** (the brief's preferred
model). The alternative, redefining "Cash Collected" as certificate collections
only, was rejected: it would silently change both the headline figure and Net
Cash Position in a beta that already ships reports, for the same clarity gain.

| Reported | Definition |
| --- | --- |
| **Total Cash In** (headline) | All live incoming payments. |
| Certificate Collections | Payment money actually allocated to certificates. |
| Advances Received | `ADVANCE` payments. |
| Retention Released | `RETENTION_RELEASE` payments. |
| Unallocated Customer Credit | Certificate-payment cash not yet allocated. |
| **Net Cash Position** | Total actual cash in − actual cash out. Unchanged. |

The four components **partition** the total: every live inflow falls into
exactly one, so they sum to Total Cash In with nothing double counted.
`dashboardCashInComponentsReconcile()` asserts the identity and is checked both
as a core unit test and against a real database holding one of every inflow.

`DashboardOverview.cashCollectedEgp` was renamed to `totalCashInEgp` so the
field name, the UI label and the arithmetic agree, and the components — already
computed per project by the core aggregate — are now surfaced instead of being
discarded.

### FX basis correction (milestone 4/5 audit)

Surfacing the components exposed a defect that the old single headline had
hidden. Every cash figure must be valued at the rate effective **when the cash
arrived** — the payment's rate. Certificate collections were instead valued at
the **certificate's** snapshot rate, which is the basis for measuring a
receivable, not cash received.

The two bases agree while a contract has one FX revision, so the identity held
in EGP-only and single-revision workspaces. As soon as a certificate was paid
under a later revision they diverged, and the components stopped adding up to
the headline: a **40,000.00 EGP gap on a 2,400,000.00 EGP headline** in the
regression fixture — visible on screen as money appearing from nowhere between
the breakdown and the total it is supposed to explain.

Collections are now derived from the **allocated portion of each live payment**,
valued at that payment's rate, and unallocated credit is taken as the balancing
remainder of the same receipt rather than being rounded independently. The
identity is therefore structural: for every receipt,
`allocated + unallocated == receipt`, so no rounding split can drift.

Certificate snapshot FX is unchanged and still governs invoiced amount,
outstanding receivables, and every other receivable-side measure.

### 0005 — truthful audit application version

A freshly created 0.7.0 database stamped every audit row with
`application_version` **0.6.3** — a version that never shipped this schema.
Three retired 0.6.x literals fed it (`audit_logs` default `0.6.0`,
`audit_context` default and seed `0.6.3`, and the `finalize_audit_insert`
COALESCE fallback `0.6.3`).

The runtime already self-heals: `stamp_runtime_release()` writes
`CURRENT_APP_VERSION` into `audit_context` at startup. But the window before
that call — and every context that never reaches the Rust layer, namely the unit
harness and the Playwright database bridge — recorded the false version
permanently, because `audit_logs` is immutable by trigger and a wrong stamp can
never be corrected afterwards.

`0005` updates the stored `audit_context` row and recreates
`finalize_audit_insert` with a truthful fallback, so every audit row written
from schema 27 onward carries `0.7.0`. The baseline files are again untouched,
so recorded checksums stay valid. The `audit_logs.application_version` column
default remains `0.6.0` and is unreachable: the trigger overwrites it on every
insert, and rebuilding that table to change a dead default would risk the audit
history for no gain.

**Historical rows are not rewritten.** An earlier draft of this migration also
carried `UPDATE audit_logs SET application_version='0.7.0' WHERE
application_version IN ('0.6.0','0.6.3')`. That statement cannot succeed:
`prevent_audit_update` allows only finalising a fresh row and binding a NULL
`entity_uuid`, so on any database holding one finalized 0.6.x-stamped row it
raised `AUDIT_LOG_IMMUTABLE`, aborting the migration and pinning
`user_version` at 26 — a database that could never reach schema 27. It was
removed rather than forced through: suppressing the trigger would make
append-only conditional, and a row stamped `0.6.3` is factually correct for the
binary that wrote it. `test/migrations.test.ts` upgrades a schema-26 database
holding such a row and asserts both the successful upgrade and the preserved
historical stamp.

Because `0005` was corrected in place while v0.7.0 is unreleased, its checksum
changed: a development database that already recorded migration 5 under the
previous checksum must be recreated. See `docs/MIGRATION-NOTES.md`.

Schema identity moves 26 → **27**. No data is lost.
