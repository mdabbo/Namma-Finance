-- Time tracking: staff/freelancer hours logged against a project and,
-- optionally, a project stage. Labor cost (minutes × the person's hourly rate)
-- is an analytical costing figure — it does NOT feed cash net profit, so
-- salaries recorded as overhead expenses are never double-counted.
--
-- Created sync-ready from the start (sync_uuid/updated_at + the three triggers,
-- matching the 0006 pattern), and registered in the sync engine's SYNC_TABLES.

CREATE TABLE time_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  stage_id INTEGER REFERENCES project_stages(id) ON DELETE SET NULL,
  date TEXT NOT NULL,
  minutes INTEGER NOT NULL CHECK (minutes > 0),
  billable INTEGER NOT NULL DEFAULT 1,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  sync_uuid TEXT,
  updated_at TEXT
);
CREATE INDEX idx_time_entries_project ON time_entries(project_id);
CREATE INDEX idx_time_entries_person ON time_entries(person_id);
CREATE INDEX idx_time_entries_stage ON time_entries(stage_id);
CREATE INDEX idx_time_entries_date ON time_entries(date);
CREATE UNIQUE INDEX idx_time_entries_sync_uuid ON time_entries(sync_uuid);

CREATE TRIGGER trg_time_entries_sync_init AFTER INSERT ON time_entries
WHEN NEW.sync_uuid IS NULL OR NEW.updated_at IS NULL
BEGIN
  UPDATE time_entries SET
    sync_uuid = COALESCE(sync_uuid, lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', (abs(random()) % 4) + 1, 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6)))),
    updated_at = COALESCE(updated_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  WHERE id = NEW.id;
END;

CREATE TRIGGER trg_time_entries_sync_touch AFTER UPDATE ON time_entries
WHEN NEW.updated_at IS OLD.updated_at
BEGIN
  UPDATE time_entries SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

CREATE TRIGGER trg_time_entries_sync_tomb AFTER DELETE ON time_entries
WHEN OLD.sync_uuid IS NOT NULL
BEGIN
  INSERT INTO sync_tombstones (tbl, row_uuid) VALUES ('time_entries', OLD.sync_uuid);
END;
