-- Progress history (plan step C1).
--
-- project_stages.completion_bp is one mutable value: once it changes, the old
-- value is gone. stage_progress_log keeps every value a stage has reported, so
-- progress over time (an S-curve) and proof of what was reported exist later.
--
-- Design:
--   * The log is written by TRIGGERS on project_stages, so the row is part of
--     the same statement -- and the same transaction -- as the change itself,
--     whichever writer made it (WebView form, demo data, a Rust command, a
--     future importer). The TypeScript test harness runs these same files, so
--     the test double cannot drift from the shipped behaviour.
--   * Changes applied by sync pull (audit_context.source = 'SYNC') are NOT
--     logged here: the device that made the change logged it, and that row
--     arrives through sync as a row of this table. Logging the pull as well
--     would duplicate every entry once per device.
--   * The stage is referenced by its sync uuid, not by a foreign key. Stages
--     can be hard-deleted; a foreign key would either block that delete or
--     delete the history with it. The history outlives the stage.
--   * Append-only: rows cannot be deleted, and nothing but updated_at (sync
--     bookkeeping) can change -- in the style of audit_logs.

CREATE TABLE stage_progress_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stage_uuid TEXT NOT NULL CHECK (length(stage_uuid) > 0),
  completion_bp INTEGER NOT NULL CHECK (completion_bp BETWEEN 0 AND 10000),
  recorded_at TEXT NOT NULL,
  source TEXT NOT NULL CHECK (length(source) > 0),
  sync_uuid TEXT NOT NULL UNIQUE,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_stage_progress_log_stage ON stage_progress_log(stage_uuid, recorded_at);
CREATE INDEX idx_stage_progress_log_updated ON stage_progress_log(updated_at, id);

CREATE TRIGGER prevent_stage_progress_log_delete BEFORE DELETE ON stage_progress_log
BEGIN SELECT RAISE(ABORT, 'STAGE_PROGRESS_LOG_IMMUTABLE'); END;

CREATE TRIGGER prevent_stage_progress_log_update BEFORE UPDATE ON stage_progress_log
WHEN NEW.id IS NOT OLD.id OR NEW.stage_uuid IS NOT OLD.stage_uuid OR
     NEW.completion_bp IS NOT OLD.completion_bp OR NEW.recorded_at IS NOT OLD.recorded_at OR
     NEW.source IS NOT OLD.source OR NEW.sync_uuid IS NOT OLD.sync_uuid
BEGIN SELECT RAISE(ABORT, 'STAGE_PROGRESS_LOG_IMMUTABLE'); END;

-- Every stage needs a sync uuid to be referenced. The sync init trigger gives
-- one to every new stage; this covers any older row that never received one.
UPDATE project_stages SET
  sync_uuid = lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', (abs(random()) % 4) + 1, 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6)))
WHERE sync_uuid IS NULL;

-- Baseline: the value each existing stage holds today is the one data point
-- that already exists. It is dated by the stage's last change, which is the
-- latest moment the value is known to have been set.
INSERT INTO stage_progress_log (stage_uuid, completion_bp, recorded_at, source, sync_uuid, updated_at)
SELECT
  s.sync_uuid,
  s.completion_bp,
  strftime('%Y-%m-%dT%H:%M:%fZ', COALESCE(s.updated_at, s.created_at, 'now')),
  'BASELINE',
  lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', (abs(random()) % 4) + 1, 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))),
  strftime('%Y-%m-%dT%H:%M:%fZ', COALESCE(s.updated_at, s.created_at, 'now'))
FROM project_stages s
ORDER BY s.id;

-- A stage inserted WITH a uuid (anything but sync pull) is logged at once.
CREATE TRIGGER log_stage_progress_insert AFTER INSERT ON project_stages
WHEN NEW.sync_uuid IS NOT NULL
  AND COALESCE((SELECT source FROM audit_context WHERE id = 1), 'DESKTOP') IS NOT 'SYNC'
BEGIN
  INSERT INTO stage_progress_log (stage_uuid, completion_bp, recorded_at, source, sync_uuid, updated_at)
  VALUES (
    NEW.sync_uuid,
    NEW.completion_bp,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    COALESCE((SELECT source FROM audit_context WHERE id = 1), 'DESKTOP'),
    lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', (abs(random()) % 4) + 1, 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  );
END;

-- A stage inserted WITHOUT a uuid (the app's own forms) gets one from the sync
-- init trigger a moment later, still inside the same statement; log it then.
CREATE TRIGGER log_stage_progress_first_uuid AFTER UPDATE OF sync_uuid ON project_stages
WHEN OLD.sync_uuid IS NULL AND NEW.sync_uuid IS NOT NULL
  AND COALESCE((SELECT source FROM audit_context WHERE id = 1), 'DESKTOP') IS NOT 'SYNC'
BEGIN
  INSERT INTO stage_progress_log (stage_uuid, completion_bp, recorded_at, source, sync_uuid, updated_at)
  VALUES (
    NEW.sync_uuid,
    NEW.completion_bp,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    COALESCE((SELECT source FROM audit_context WHERE id = 1), 'DESKTOP'),
    lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', (abs(random()) % 4) + 1, 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  );
END;

-- Every later change of the value. An edit that leaves it unchanged is not one.
CREATE TRIGGER log_stage_progress_update AFTER UPDATE OF completion_bp ON project_stages
WHEN NEW.completion_bp IS NOT OLD.completion_bp
  AND COALESCE(NEW.sync_uuid, OLD.sync_uuid) IS NOT NULL
  AND COALESCE((SELECT source FROM audit_context WHERE id = 1), 'DESKTOP') IS NOT 'SYNC'
BEGIN
  INSERT INTO stage_progress_log (stage_uuid, completion_bp, recorded_at, source, sync_uuid, updated_at)
  VALUES (
    COALESCE(NEW.sync_uuid, OLD.sync_uuid),
    NEW.completion_bp,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    COALESCE((SELECT source FROM audit_context WHERE id = 1), 'DESKTOP'),
    lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', (abs(random()) % 4) + 1, 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  );
END;

PRAGMA user_version = 30;
INSERT INTO app_metadata(key,value) VALUES('schema_version','30')
ON CONFLICT(key) DO UPDATE SET value='30';
