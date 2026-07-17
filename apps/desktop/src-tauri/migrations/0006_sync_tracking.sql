-- Phase 3: local sync tracking for the Supabase backend.
--
--  * sync_uuid    — stable global identity of every row (UUID v4); local
--                   integer ids never leave the device.
--  * updated_at   — bumped by trigger on every app update; sync pull writes
--                   it explicitly (the trigger only fires when the statement
--                   did NOT change updated_at itself, so remote timestamps
--                   are preserved for last-writer-wins).
--  * sync_tombstones — deletions recorded by trigger so they replicate.
--    FK cascade deletions fire the DELETE triggers too, so children get
--    tombstones of their own.
--  * sync_state   — per-table pull cursors, device id, session cache.
--
-- recursive_triggers is OFF (SQLite default): the UPDATE inside a trigger
-- body cannot re-fire triggers.

CREATE TABLE sync_tombstones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tbl TEXT NOT NULL,
  row_uuid TEXT NOT NULL,
  deleted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_tombstones_tbl ON sync_tombstones(tbl, deleted_at);

CREATE TABLE sync_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ─── clients ───
ALTER TABLE clients ADD COLUMN sync_uuid TEXT;
ALTER TABLE clients ADD COLUMN updated_at TEXT;
UPDATE clients SET sync_uuid = lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', (abs(random()) % 4) + 1, 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))), updated_at = COALESCE(created_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
CREATE UNIQUE INDEX idx_clients_sync_uuid ON clients(sync_uuid);

CREATE TRIGGER trg_clients_sync_init AFTER INSERT ON clients
WHEN NEW.sync_uuid IS NULL OR NEW.updated_at IS NULL
BEGIN
  UPDATE clients SET
    sync_uuid = COALESCE(sync_uuid, lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', (abs(random()) % 4) + 1, 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6)))),
    updated_at = COALESCE(updated_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  WHERE id = NEW.id;
END;

CREATE TRIGGER trg_clients_sync_touch AFTER UPDATE ON clients
WHEN NEW.updated_at IS OLD.updated_at
BEGIN
  UPDATE clients SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

CREATE TRIGGER trg_clients_sync_tomb AFTER DELETE ON clients
WHEN OLD.sync_uuid IS NOT NULL
BEGIN
  INSERT INTO sync_tombstones (tbl, row_uuid) VALUES ('clients', OLD.sync_uuid);
END;

-- ─── projects ───
ALTER TABLE projects ADD COLUMN sync_uuid TEXT;
ALTER TABLE projects ADD COLUMN updated_at TEXT;
UPDATE projects SET sync_uuid = lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', (abs(random()) % 4) + 1, 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))), updated_at = COALESCE(created_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
CREATE UNIQUE INDEX idx_projects_sync_uuid ON projects(sync_uuid);

CREATE TRIGGER trg_projects_sync_init AFTER INSERT ON projects
WHEN NEW.sync_uuid IS NULL OR NEW.updated_at IS NULL
BEGIN
  UPDATE projects SET
    sync_uuid = COALESCE(sync_uuid, lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', (abs(random()) % 4) + 1, 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6)))),
    updated_at = COALESCE(updated_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  WHERE id = NEW.id;
END;

CREATE TRIGGER trg_projects_sync_touch AFTER UPDATE ON projects
WHEN NEW.updated_at IS OLD.updated_at
BEGIN
  UPDATE projects SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

CREATE TRIGGER trg_projects_sync_tomb AFTER DELETE ON projects
WHEN OLD.sync_uuid IS NOT NULL
BEGIN
  INSERT INTO sync_tombstones (tbl, row_uuid) VALUES ('projects', OLD.sync_uuid);
END;

-- ─── contracts ───
ALTER TABLE contracts ADD COLUMN sync_uuid TEXT;
ALTER TABLE contracts ADD COLUMN updated_at TEXT;
UPDATE contracts SET sync_uuid = lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', (abs(random()) % 4) + 1, 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))), updated_at = COALESCE(created_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
CREATE UNIQUE INDEX idx_contracts_sync_uuid ON contracts(sync_uuid);

CREATE TRIGGER trg_contracts_sync_init AFTER INSERT ON contracts
WHEN NEW.sync_uuid IS NULL OR NEW.updated_at IS NULL
BEGIN
  UPDATE contracts SET
    sync_uuid = COALESCE(sync_uuid, lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', (abs(random()) % 4) + 1, 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6)))),
    updated_at = COALESCE(updated_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  WHERE id = NEW.id;
END;

CREATE TRIGGER trg_contracts_sync_touch AFTER UPDATE ON contracts
WHEN NEW.updated_at IS OLD.updated_at
BEGIN
  UPDATE contracts SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

CREATE TRIGGER trg_contracts_sync_tomb AFTER DELETE ON contracts
WHEN OLD.sync_uuid IS NOT NULL
BEGIN
  INSERT INTO sync_tombstones (tbl, row_uuid) VALUES ('contracts', OLD.sync_uuid);
END;

-- ─── payment_certificates ───
ALTER TABLE payment_certificates ADD COLUMN sync_uuid TEXT;
ALTER TABLE payment_certificates ADD COLUMN updated_at TEXT;
UPDATE payment_certificates SET sync_uuid = lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', (abs(random()) % 4) + 1, 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))), updated_at = COALESCE(created_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
CREATE UNIQUE INDEX idx_payment_certificates_sync_uuid ON payment_certificates(sync_uuid);

CREATE TRIGGER trg_payment_certificates_sync_init AFTER INSERT ON payment_certificates
WHEN NEW.sync_uuid IS NULL OR NEW.updated_at IS NULL
BEGIN
  UPDATE payment_certificates SET
    sync_uuid = COALESCE(sync_uuid, lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', (abs(random()) % 4) + 1, 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6)))),
    updated_at = COALESCE(updated_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  WHERE id = NEW.id;
END;

CREATE TRIGGER trg_payment_certificates_sync_touch AFTER UPDATE ON payment_certificates
WHEN NEW.updated_at IS OLD.updated_at
BEGIN
  UPDATE payment_certificates SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

CREATE TRIGGER trg_payment_certificates_sync_tomb AFTER DELETE ON payment_certificates
WHEN OLD.sync_uuid IS NOT NULL
BEGIN
  INSERT INTO sync_tombstones (tbl, row_uuid) VALUES ('payment_certificates', OLD.sync_uuid);
END;

-- ─── payments ───
ALTER TABLE payments ADD COLUMN sync_uuid TEXT;
ALTER TABLE payments ADD COLUMN updated_at TEXT;
UPDATE payments SET sync_uuid = lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', (abs(random()) % 4) + 1, 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))), updated_at = COALESCE(created_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
CREATE UNIQUE INDEX idx_payments_sync_uuid ON payments(sync_uuid);

CREATE TRIGGER trg_payments_sync_init AFTER INSERT ON payments
WHEN NEW.sync_uuid IS NULL OR NEW.updated_at IS NULL
BEGIN
  UPDATE payments SET
    sync_uuid = COALESCE(sync_uuid, lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', (abs(random()) % 4) + 1, 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6)))),
    updated_at = COALESCE(updated_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  WHERE id = NEW.id;
END;

CREATE TRIGGER trg_payments_sync_touch AFTER UPDATE ON payments
WHEN NEW.updated_at IS OLD.updated_at
BEGIN
  UPDATE payments SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

CREATE TRIGGER trg_payments_sync_tomb AFTER DELETE ON payments
WHEN OLD.sync_uuid IS NOT NULL
BEGIN
  INSERT INTO sync_tombstones (tbl, row_uuid) VALUES ('payments', OLD.sync_uuid);
END;

-- ─── payment_certificate_allocations ───
ALTER TABLE payment_certificate_allocations ADD COLUMN sync_uuid TEXT;
ALTER TABLE payment_certificate_allocations ADD COLUMN updated_at TEXT;
UPDATE payment_certificate_allocations SET sync_uuid = lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', (abs(random()) % 4) + 1, 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
CREATE UNIQUE INDEX idx_payment_certificate_allocations_sync_uuid ON payment_certificate_allocations(sync_uuid);

CREATE TRIGGER trg_payment_certificate_allocations_sync_init AFTER INSERT ON payment_certificate_allocations
WHEN NEW.sync_uuid IS NULL OR NEW.updated_at IS NULL
BEGIN
  UPDATE payment_certificate_allocations SET
    sync_uuid = COALESCE(sync_uuid, lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', (abs(random()) % 4) + 1, 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6)))),
    updated_at = COALESCE(updated_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  WHERE id = NEW.id;
END;

CREATE TRIGGER trg_payment_certificate_allocations_sync_touch AFTER UPDATE ON payment_certificate_allocations
WHEN NEW.updated_at IS OLD.updated_at
BEGIN
  UPDATE payment_certificate_allocations SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

CREATE TRIGGER trg_payment_certificate_allocations_sync_tomb AFTER DELETE ON payment_certificate_allocations
WHEN OLD.sync_uuid IS NOT NULL
BEGIN
  INSERT INTO sync_tombstones (tbl, row_uuid) VALUES ('payment_certificate_allocations', OLD.sync_uuid);
END;

-- ─── expense_categories ───
ALTER TABLE expense_categories ADD COLUMN sync_uuid TEXT;
ALTER TABLE expense_categories ADD COLUMN updated_at TEXT;
UPDATE expense_categories SET sync_uuid = lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', (abs(random()) % 4) + 1, 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
CREATE UNIQUE INDEX idx_expense_categories_sync_uuid ON expense_categories(sync_uuid);

CREATE TRIGGER trg_expense_categories_sync_init AFTER INSERT ON expense_categories
WHEN NEW.sync_uuid IS NULL OR NEW.updated_at IS NULL
BEGIN
  UPDATE expense_categories SET
    sync_uuid = COALESCE(sync_uuid, lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', (abs(random()) % 4) + 1, 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6)))),
    updated_at = COALESCE(updated_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  WHERE id = NEW.id;
END;

CREATE TRIGGER trg_expense_categories_sync_touch AFTER UPDATE ON expense_categories
WHEN NEW.updated_at IS OLD.updated_at
BEGIN
  UPDATE expense_categories SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

CREATE TRIGGER trg_expense_categories_sync_tomb AFTER DELETE ON expense_categories
WHEN OLD.sync_uuid IS NOT NULL
BEGIN
  INSERT INTO sync_tombstones (tbl, row_uuid) VALUES ('expense_categories', OLD.sync_uuid);
END;

-- ─── expenses ───
ALTER TABLE expenses ADD COLUMN sync_uuid TEXT;
ALTER TABLE expenses ADD COLUMN updated_at TEXT;
UPDATE expenses SET sync_uuid = lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', (abs(random()) % 4) + 1, 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))), updated_at = COALESCE(created_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
CREATE UNIQUE INDEX idx_expenses_sync_uuid ON expenses(sync_uuid);

CREATE TRIGGER trg_expenses_sync_init AFTER INSERT ON expenses
WHEN NEW.sync_uuid IS NULL OR NEW.updated_at IS NULL
BEGIN
  UPDATE expenses SET
    sync_uuid = COALESCE(sync_uuid, lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', (abs(random()) % 4) + 1, 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6)))),
    updated_at = COALESCE(updated_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  WHERE id = NEW.id;
END;

CREATE TRIGGER trg_expenses_sync_touch AFTER UPDATE ON expenses
WHEN NEW.updated_at IS OLD.updated_at
BEGIN
  UPDATE expenses SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

CREATE TRIGGER trg_expenses_sync_tomb AFTER DELETE ON expenses
WHEN OLD.sync_uuid IS NOT NULL
BEGIN
  INSERT INTO sync_tombstones (tbl, row_uuid) VALUES ('expenses', OLD.sync_uuid);
END;

-- ─── people ───
ALTER TABLE people ADD COLUMN sync_uuid TEXT;
ALTER TABLE people ADD COLUMN updated_at TEXT;
UPDATE people SET sync_uuid = lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', (abs(random()) % 4) + 1, 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))), updated_at = COALESCE(created_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
CREATE UNIQUE INDEX idx_people_sync_uuid ON people(sync_uuid);

CREATE TRIGGER trg_people_sync_init AFTER INSERT ON people
WHEN NEW.sync_uuid IS NULL OR NEW.updated_at IS NULL
BEGIN
  UPDATE people SET
    sync_uuid = COALESCE(sync_uuid, lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', (abs(random()) % 4) + 1, 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6)))),
    updated_at = COALESCE(updated_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  WHERE id = NEW.id;
END;

CREATE TRIGGER trg_people_sync_touch AFTER UPDATE ON people
WHEN NEW.updated_at IS OLD.updated_at
BEGIN
  UPDATE people SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

CREATE TRIGGER trg_people_sync_tomb AFTER DELETE ON people
WHEN OLD.sync_uuid IS NOT NULL
BEGIN
  INSERT INTO sync_tombstones (tbl, row_uuid) VALUES ('people', OLD.sync_uuid);
END;

-- ─── project_assignments ───
ALTER TABLE project_assignments ADD COLUMN sync_uuid TEXT;
ALTER TABLE project_assignments ADD COLUMN updated_at TEXT;
UPDATE project_assignments SET sync_uuid = lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', (abs(random()) % 4) + 1, 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))), updated_at = COALESCE(created_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
CREATE UNIQUE INDEX idx_project_assignments_sync_uuid ON project_assignments(sync_uuid);

CREATE TRIGGER trg_project_assignments_sync_init AFTER INSERT ON project_assignments
WHEN NEW.sync_uuid IS NULL OR NEW.updated_at IS NULL
BEGIN
  UPDATE project_assignments SET
    sync_uuid = COALESCE(sync_uuid, lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', (abs(random()) % 4) + 1, 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6)))),
    updated_at = COALESCE(updated_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  WHERE id = NEW.id;
END;

CREATE TRIGGER trg_project_assignments_sync_touch AFTER UPDATE ON project_assignments
WHEN NEW.updated_at IS OLD.updated_at
BEGIN
  UPDATE project_assignments SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

CREATE TRIGGER trg_project_assignments_sync_tomb AFTER DELETE ON project_assignments
WHEN OLD.sync_uuid IS NOT NULL
BEGIN
  INSERT INTO sync_tombstones (tbl, row_uuid) VALUES ('project_assignments', OLD.sync_uuid);
END;

-- ─── person_payments ───
ALTER TABLE person_payments ADD COLUMN sync_uuid TEXT;
ALTER TABLE person_payments ADD COLUMN updated_at TEXT;
UPDATE person_payments SET sync_uuid = lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', (abs(random()) % 4) + 1, 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))), updated_at = COALESCE(created_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
CREATE UNIQUE INDEX idx_person_payments_sync_uuid ON person_payments(sync_uuid);

CREATE TRIGGER trg_person_payments_sync_init AFTER INSERT ON person_payments
WHEN NEW.sync_uuid IS NULL OR NEW.updated_at IS NULL
BEGIN
  UPDATE person_payments SET
    sync_uuid = COALESCE(sync_uuid, lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', (abs(random()) % 4) + 1, 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6)))),
    updated_at = COALESCE(updated_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  WHERE id = NEW.id;
END;

CREATE TRIGGER trg_person_payments_sync_touch AFTER UPDATE ON person_payments
WHEN NEW.updated_at IS OLD.updated_at
BEGIN
  UPDATE person_payments SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

CREATE TRIGGER trg_person_payments_sync_tomb AFTER DELETE ON person_payments
WHEN OLD.sync_uuid IS NOT NULL
BEGIN
  INSERT INTO sync_tombstones (tbl, row_uuid) VALUES ('person_payments', OLD.sync_uuid);
END;

-- ─── project_stages ───
ALTER TABLE project_stages ADD COLUMN sync_uuid TEXT;
ALTER TABLE project_stages ADD COLUMN updated_at TEXT;
UPDATE project_stages SET sync_uuid = lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', (abs(random()) % 4) + 1, 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))), updated_at = COALESCE(created_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
CREATE UNIQUE INDEX idx_project_stages_sync_uuid ON project_stages(sync_uuid);

CREATE TRIGGER trg_project_stages_sync_init AFTER INSERT ON project_stages
WHEN NEW.sync_uuid IS NULL OR NEW.updated_at IS NULL
BEGIN
  UPDATE project_stages SET
    sync_uuid = COALESCE(sync_uuid, lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', (abs(random()) % 4) + 1, 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6)))),
    updated_at = COALESCE(updated_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  WHERE id = NEW.id;
END;

CREATE TRIGGER trg_project_stages_sync_touch AFTER UPDATE ON project_stages
WHEN NEW.updated_at IS OLD.updated_at
BEGIN
  UPDATE project_stages SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

CREATE TRIGGER trg_project_stages_sync_tomb AFTER DELETE ON project_stages
WHEN OLD.sync_uuid IS NOT NULL
BEGIN
  INSERT INTO sync_tombstones (tbl, row_uuid) VALUES ('project_stages', OLD.sync_uuid);
END;

-- ─── documents ───
ALTER TABLE documents ADD COLUMN sync_uuid TEXT;
ALTER TABLE documents ADD COLUMN updated_at TEXT;
UPDATE documents SET sync_uuid = lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', (abs(random()) % 4) + 1, 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))), updated_at = COALESCE(added_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
CREATE UNIQUE INDEX idx_documents_sync_uuid ON documents(sync_uuid);

CREATE TRIGGER trg_documents_sync_init AFTER INSERT ON documents
WHEN NEW.sync_uuid IS NULL OR NEW.updated_at IS NULL
BEGIN
  UPDATE documents SET
    sync_uuid = COALESCE(sync_uuid, lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', (abs(random()) % 4) + 1, 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6)))),
    updated_at = COALESCE(updated_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  WHERE id = NEW.id;
END;

CREATE TRIGGER trg_documents_sync_touch AFTER UPDATE ON documents
WHEN NEW.updated_at IS OLD.updated_at
BEGIN
  UPDATE documents SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

CREATE TRIGGER trg_documents_sync_tomb AFTER DELETE ON documents
WHEN OLD.sync_uuid IS NOT NULL
BEGIN
  INSERT INTO sync_tombstones (tbl, row_uuid) VALUES ('documents', OLD.sync_uuid);
END;

-- ─── recurring_expenses ───
ALTER TABLE recurring_expenses ADD COLUMN sync_uuid TEXT;
ALTER TABLE recurring_expenses ADD COLUMN updated_at TEXT;
UPDATE recurring_expenses SET sync_uuid = lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', (abs(random()) % 4) + 1, 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))), updated_at = COALESCE(created_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
CREATE UNIQUE INDEX idx_recurring_expenses_sync_uuid ON recurring_expenses(sync_uuid);

CREATE TRIGGER trg_recurring_expenses_sync_init AFTER INSERT ON recurring_expenses
WHEN NEW.sync_uuid IS NULL OR NEW.updated_at IS NULL
BEGIN
  UPDATE recurring_expenses SET
    sync_uuid = COALESCE(sync_uuid, lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', (abs(random()) % 4) + 1, 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6)))),
    updated_at = COALESCE(updated_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  WHERE id = NEW.id;
END;

CREATE TRIGGER trg_recurring_expenses_sync_touch AFTER UPDATE ON recurring_expenses
WHEN NEW.updated_at IS OLD.updated_at
BEGIN
  UPDATE recurring_expenses SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

CREATE TRIGGER trg_recurring_expenses_sync_tomb AFTER DELETE ON recurring_expenses
WHEN OLD.sync_uuid IS NOT NULL
BEGIN
  INSERT INTO sync_tombstones (tbl, row_uuid) VALUES ('recurring_expenses', OLD.sync_uuid);
END;
