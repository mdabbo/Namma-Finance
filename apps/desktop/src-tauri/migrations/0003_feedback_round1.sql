-- Feedback round 1:
--  * projects.discipline: allow ARCHITECTURE / STRUCTURAL / ID (CHECK moved to app validation)
--  * contracts: + valuation_mode (LUMP_SUM / MILESTONES / DRAWINGS) + drawings JSON
--  * expenses: + person_payment_id (team payments auto-create expenses; cascade on delete)
--  * settings: base_currency, backup_folder
--
-- SQLite cannot ALTER a CHECK constraint, and dropping a parent table with
-- foreign_keys=ON cascade-deletes its children. Therefore the project tree is
-- rebuilt as *_v3 tables (new tables reference the *_v3 names, so dropping the
-- old tables never touches the copied data), old tables are dropped
-- children-first, then everything is renamed back (renames rewrite the FK
-- references automatically).

CREATE TABLE projects_v3 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  country TEXT,
  city TEXT,
  manager TEXT,
  discipline TEXT NOT NULL DEFAULT 'MULTI',
  project_type TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE','ON_HOLD','COMPLETED','CANCELLED')),
  currency TEXT NOT NULL DEFAULT 'EGP',
  fx_rate_micro INTEGER NOT NULL DEFAULT 1000000 CHECK (fx_rate_micro > 0),
  start_date TEXT,
  end_date TEXT,
  progress_bp INTEGER NOT NULL DEFAULT 0 CHECK (progress_bp BETWEEN 0 AND 10000),
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO projects_v3 SELECT * FROM projects;

CREATE TABLE contracts_v3 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects_v3(id) ON DELETE CASCADE,
  number TEXT NOT NULL,
  title TEXT,
  value_minor INTEGER NOT NULL DEFAULT 0 CHECK (value_minor >= 0),
  vat_bp INTEGER NOT NULL DEFAULT 1400 CHECK (vat_bp BETWEEN 0 AND 10000),
  retention_bp INTEGER NOT NULL DEFAULT 0 CHECK (retention_bp BETWEEN 0 AND 10000),
  withholding_bp INTEGER NOT NULL DEFAULT 0 CHECK (withholding_bp BETWEEN 0 AND 10000),
  advance_minor INTEGER NOT NULL DEFAULT 0 CHECK (advance_minor >= 0),
  advance_recovery_method TEXT NOT NULL DEFAULT 'PROPORTIONAL'
    CHECK (advance_recovery_method IN ('PROPORTIONAL','MANUAL')),
  performance_bond_bp INTEGER NOT NULL DEFAULT 0 CHECK (performance_bond_bp BETWEEN 0 AND 10000),
  performance_bond_bank TEXT,
  performance_bond_expiry TEXT,
  payment_terms_days INTEGER NOT NULL DEFAULT 30 CHECK (payment_terms_days BETWEEN 0 AND 3650),
  payment_terms_notes TEXT,
  valuation_mode TEXT NOT NULL DEFAULT 'LUMP_SUM'
    CHECK (valuation_mode IN ('LUMP_SUM','MILESTONES','DRAWINGS')),
  milestones TEXT,
  drawings TEXT,
  attachments TEXT,
  signed_date TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO contracts_v3 (id, project_id, number, title, value_minor, vat_bp, retention_bp, withholding_bp,
    advance_minor, advance_recovery_method, performance_bond_bp, performance_bond_bank,
    performance_bond_expiry, payment_terms_days, payment_terms_notes, milestones, attachments,
    signed_date, notes, created_at)
  SELECT id, project_id, number, title, value_minor, vat_bp, retention_bp, withholding_bp,
    advance_minor, advance_recovery_method, performance_bond_bp, performance_bond_bank,
    performance_bond_expiry, payment_terms_days, payment_terms_notes, milestones, attachments,
    signed_date, notes, created_at
  FROM contracts;

CREATE TABLE payment_certificates_v3 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id INTEGER NOT NULL REFERENCES contracts_v3(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  number TEXT NOT NULL,
  date TEXT NOT NULL,
  submission_date TEXT,
  due_date_override TEXT,
  description TEXT,
  gross_minor INTEGER NOT NULL DEFAULT 0 CHECK (gross_minor >= 0),
  discount_minor INTEGER NOT NULL DEFAULT 0 CHECK (discount_minor >= 0 AND discount_minor <= gross_minor),
  manual_advance_recovery_minor INTEGER CHECK (manual_advance_recovery_minor IS NULL OR manual_advance_recovery_minor >= 0),
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','SUBMITTED','APPROVED','PAID')),
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO payment_certificates_v3 SELECT * FROM payment_certificates;

CREATE TABLE payments_v3 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id INTEGER NOT NULL REFERENCES contracts_v3(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'CERTIFICATE'
    CHECK (kind IN ('CERTIFICATE','ADVANCE','RETENTION_RELEASE')),
  number TEXT NOT NULL,
  date TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  method TEXT NOT NULL DEFAULT 'BANK_TRANSFER'
    CHECK (method IN ('BANK_TRANSFER','CHEQUE','CASH')),
  bank TEXT,
  reference TEXT,
  notes TEXT,
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO payments_v3 SELECT * FROM payments;

CREATE TABLE payment_certificate_allocations_v3 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id INTEGER NOT NULL REFERENCES payments_v3(id) ON DELETE CASCADE,
  certificate_id INTEGER NOT NULL REFERENCES payment_certificates_v3(id) ON DELETE CASCADE,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0)
);
INSERT INTO payment_certificate_allocations_v3 SELECT * FROM payment_certificate_allocations;

CREATE TABLE project_assignments_v3 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  project_id INTEGER NOT NULL REFERENCES projects_v3(id) ON DELETE CASCADE,
  agreed_minor INTEGER NOT NULL DEFAULT 0 CHECK (agreed_minor >= 0),
  currency TEXT NOT NULL DEFAULT 'EGP',
  fx_rate_micro INTEGER NOT NULL DEFAULT 1000000 CHECK (fx_rate_micro > 0),
  scope TEXT,
  progress_note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO project_assignments_v3 SELECT * FROM project_assignments;

CREATE TABLE person_payments_v3 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assignment_id INTEGER NOT NULL REFERENCES project_assignments_v3(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO person_payments_v3 SELECT * FROM person_payments;

CREATE TABLE expenses_v3 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  category_id INTEGER NOT NULL REFERENCES expense_categories(id) ON DELETE RESTRICT,
  description TEXT NOT NULL,
  project_id INTEGER REFERENCES projects_v3(id) ON DELETE CASCADE,
  supplier TEXT,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL DEFAULT 'EGP',
  fx_rate_micro INTEGER NOT NULL DEFAULT 1000000 CHECK (fx_rate_micro > 0),
  attachment_path TEXT,
  person_payment_id INTEGER REFERENCES person_payments_v3(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO expenses_v3 (id, date, category_id, description, project_id, supplier, amount_minor,
    currency, fx_rate_micro, attachment_path, created_at)
  SELECT id, date, category_id, description, project_id, supplier, amount_minor,
    currency, fx_rate_micro, attachment_path, created_at
  FROM expenses;

-- Drop old tables, children first (no live table references them anymore).
DROP TABLE payment_certificate_allocations;
DROP TABLE person_payments;
DROP TABLE expenses;
DROP TABLE payments;
DROP TABLE payment_certificates;
DROP TABLE project_assignments;
DROP TABLE contracts;
DROP TABLE projects;

-- Rename back; SQLite rewrites the FK references between the _v3 tables.
ALTER TABLE projects_v3 RENAME TO projects;
ALTER TABLE contracts_v3 RENAME TO contracts;
ALTER TABLE payment_certificates_v3 RENAME TO payment_certificates;
ALTER TABLE payments_v3 RENAME TO payments;
ALTER TABLE payment_certificate_allocations_v3 RENAME TO payment_certificate_allocations;
ALTER TABLE project_assignments_v3 RENAME TO project_assignments;
ALTER TABLE person_payments_v3 RENAME TO person_payments;
ALTER TABLE expenses_v3 RENAME TO expenses;

-- Recreate the indexes lost with the old tables.
CREATE INDEX idx_projects_client ON projects(client_id);
CREATE INDEX idx_projects_status ON projects(status);
CREATE INDEX idx_contracts_project ON contracts(project_id);
CREATE INDEX idx_certificates_contract ON payment_certificates(contract_id);
CREATE INDEX idx_certificates_status ON payment_certificates(status);
CREATE INDEX idx_payments_contract ON payments(contract_id);
CREATE INDEX idx_allocations_payment ON payment_certificate_allocations(payment_id);
CREATE INDEX idx_allocations_certificate ON payment_certificate_allocations(certificate_id);
CREATE INDEX idx_expenses_project ON expenses(project_id);
CREATE INDEX idx_expenses_category ON expenses(category_id);
CREATE INDEX idx_expenses_date ON expenses(date);
CREATE INDEX idx_expenses_person_payment ON expenses(person_payment_id);
CREATE INDEX idx_assignments_person ON project_assignments(person_id);
CREATE INDEX idx_assignments_project ON project_assignments(project_id);
CREATE INDEX idx_person_payments_assignment ON person_payments(assignment_id);

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('base_currency', 'EGP'),
  ('backup_folder', '');
