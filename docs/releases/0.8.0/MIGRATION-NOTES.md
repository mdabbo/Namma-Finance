# Database migration notes — 0.8.0

0.8.0 is forward-only from 0.7.1 and moves the schema from **29 to 30**.

| Migration | Adds |
| --- | --- |
| `0008_stage_progress_log.sql` | Append-only `stage_progress_log`, written by triggers on `project_stages`. Existing stages get one `BASELINE` row each. |

## Existing databases

An existing 0.7.1 database (schema 29) upgrades on first start. Take a backup
first with Settings → Backup. The upgrade only adds the table and triggers; it
changes no existing rows except backfilling a missing `sync_uuid` on any stage
that lacks one.

## Cloud project (required before first sync)

Run `docs/supabase-0020-stage-progress-log.sql` in the Supabase SQL editor
before the first sync from a 0.8.0 build. Until it has run, sync stops with an
error naming `stage_progress_log`. The script is re-runnable.

## Two-PC note

If two PCs both upgrade, a stage can receive two identical `BASELINE` rows,
one per device. Readers should ignore exact duplicates. This is accepted and
does not affect money.
