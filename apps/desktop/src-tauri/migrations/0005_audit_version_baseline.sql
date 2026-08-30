-- Truthful audit application version (v0.7.0 milestone 9). Forward-only.
--
-- Audit finding: a freshly created 0.7.0 database stamped every audit row with
-- application_version '0.6.3' — a version that never shipped this schema.
--
-- Three stale literals fed that, all from the retired 0.6.x line:
--   * audit_logs.application_version  DEFAULT '0.6.0'
--   * audit_context.application_version DEFAULT '0.6.3'
--   * finalize_audit_insert's COALESCE fallback '0.6.3'
-- and 0002_seed_reference_data.sql seeded the audit_context row to '0.6.3'.
--
-- The runtime already corrects this: stamp_runtime_release() writes
-- CURRENT_APP_VERSION into audit_context at startup, so the desktop app
-- self-heals within a moment of launching. But the window before that call,
-- and every context that never reaches the Rust layer (the test harnesses and
-- the Playwright database bridge), recorded the false version permanently —
-- audit_logs is immutable by trigger, so a wrong stamp can never be corrected.
--
-- The baseline files are deliberately NOT edited: tauri-plugin-sql records a
-- checksum per applied migration, and rewriting 0001 or 0002 would reject every
-- existing development database. This migration corrects the stored row and
-- replaces the one trigger that carries a literal fallback.
--
-- What this migration deliberately does NOT do
-- --------------------------------------------
-- It does not rewrite historical audit_logs rows. An earlier draft of this file
-- carried
--
--     UPDATE audit_logs SET application_version='0.7.0'
--     WHERE application_version IN ('0.6.0','0.6.3');
--
-- which cannot succeed and must never be reinstated. `prevent_audit_update`
-- allows exactly two shapes — finalising a fresh row (finalized 0 -> 1) and
-- binding a NULL entity_uuid — and an application_version rewrite on a
-- finalized row matches neither, so the statement raises AUDIT_LOG_IMMUTABLE.
-- On any database holding even one finalized 0.6.x-stamped row the whole
-- migration aborted, leaving user_version pinned at 26: a permanently
-- unopenable database. Reproduced before this correction, on a schema-26
-- database with one finalized row, the migration failed with
-- AUDIT_LOG_IMMUTABLE and user_version stayed 26.
--
-- Suppressing the trigger to force those rows through was rejected: audit
-- immutability is the property the log exists to provide, and a historical row
-- stamped 0.6.3 is TRUE — that row really was written by a 0.6.x-era binary.
-- Rewriting it would replace an accurate record with a tidier falsehood.
--
-- v0.7.0 is unreleased and already requires a database reset (see
-- docs/DATABASE-REBASE-0.7.0.md), so no user database carries such rows.
-- Development databases created from earlier v0.7.0 commits — including any
-- that already recorded version 5 with this file's previous checksum — must be
-- recreated; see docs/MIGRATION-NOTES.md.

-- The single audit_context row drives every subsequent audit stamp, so every
-- audit row written from here on is stamped 0.7.0. Historical rows keep the
-- version that actually wrote them.
UPDATE audit_context SET application_version = '0.7.0' WHERE id = 1;

-- Recreated only to replace the '0.6.3' fallback with the shipping version.
-- The body is otherwise identical to the baseline definition: it finalises a
-- freshly inserted audit row from the active context.
DROP TRIGGER finalize_audit_insert;
CREATE TRIGGER finalize_audit_insert AFTER INSERT ON audit_logs WHEN NEW.finalized=0
BEGIN
  UPDATE audit_logs SET
    user_id=COALESCE(NULLIF((SELECT value FROM settings WHERE key='sync_user_id'),''),NEW.user_id),
    source=CASE WHEN NEW.source='DESKTOP' THEN COALESCE((SELECT source FROM audit_context WHERE id=1),'DESKTOP') ELSE NEW.source END,
    application_version=COALESCE((SELECT application_version FROM audit_context WHERE id=1),'0.7.0'),
    finalized=1
  WHERE id=NEW.id;
END;

PRAGMA user_version = 27;
INSERT INTO app_metadata(key,value) VALUES('schema_version','27')
ON CONFLICT(key) DO UPDATE SET value='27';
