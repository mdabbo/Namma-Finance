# Database migration notes - 0.6.7

The desktop SQLite schema remains version **23**. Existing SQLite migrations are unchanged and forward-only. This hardening update changes runtime connection handling so the application lock, WebView repository calls, and atomic sync mutations use the same serialized WAL-mode database pool.

The Supabase cloud schema is upgraded through explicit forward-only SQL files. Migration 0015 adds relational constraints, indexes, LWW ordering, RLS, and grants for contract revisions and variation orders. Repairs 0016 and 0017 safely handle legacy numbering and allocation-integrity backfills without rewriting historical migrations.

Before upgrading a database containing real records, create and verify a backup, run the read-only cloud preflight, resolve reported collisions explicitly, and apply only the required forward migration. Never edit a migration that may already have run.
