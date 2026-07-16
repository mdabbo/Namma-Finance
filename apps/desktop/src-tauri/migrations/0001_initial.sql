-- MEP Finance — initial schema.
-- Money: *_minor INTEGER (piasters/cents/fils). Rates: *_bp INTEGER basis points.
-- FX: fx_rate_micro INTEGER = EGP per 1 major unit × 1e6.
-- Derived financial figures are NEVER stored — they are computed by @mep/core.

CREATE TABLE clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  company TEXT,
  address TEXT,
  phone TEXT,
  email TEXT,
  tax_number TEXT,
  contacts TEXT, -- JSON [{name, role, phone, email}]
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  country TEXT,
  city TEXT,
  manager TEXT,
  discipline TEXT NOT NULL DEFAULT 'MULTI'
    CHECK (discipline IN ('HVAC','PLUMBING','FIREFIGHTING','ELECTRICAL','BIM','MULTI')),
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
CREATE INDEX idx_projects_client ON projects(client_id);
CREATE INDEX idx_projects_status ON projects(status);

CREATE TABLE contracts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
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
  milestones TEXT,  -- JSON [{title, amountMinor, date, done}]
  attachments TEXT, -- JSON [path]
  signed_date TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_contracts_project ON contracts(project_id);

CREATE TABLE payment_certificates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id INTEGER NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
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
CREATE INDEX idx_certificates_contract ON payment_certificates(contract_id);
CREATE INDEX idx_certificates_status ON payment_certificates(status);

CREATE TABLE payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id INTEGER NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
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
CREATE INDEX idx_payments_contract ON payments(contract_id);

CREATE TABLE payment_certificate_allocations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id INTEGER NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  certificate_id INTEGER NOT NULL REFERENCES payment_certificates(id) ON DELETE CASCADE,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0)
);
CREATE INDEX idx_allocations_payment ON payment_certificate_allocations(payment_id);
CREATE INDEX idx_allocations_certificate ON payment_certificate_allocations(certificate_id);

CREATE TABLE expense_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name_en TEXT NOT NULL,
  name_ar TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  category_id INTEGER NOT NULL REFERENCES expense_categories(id) ON DELETE RESTRICT,
  description TEXT NOT NULL,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE, -- NULL = overhead
  supplier TEXT,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL DEFAULT 'EGP',
  fx_rate_micro INTEGER NOT NULL DEFAULT 1000000 CHECK (fx_rate_micro > 0),
  attachment_path TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_expenses_project ON expenses(project_id);
CREATE INDEX idx_expenses_category ON expenses(category_id);
CREATE INDEX idx_expenses_date ON expenses(date);

CREATE TABLE people (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL DEFAULT 'FREELANCER' CHECK (type IN ('EMPLOYEE','FREELANCER')),
  name TEXT NOT NULL,
  specialization TEXT,
  phone TEXT,
  email TEXT,
  bank_account TEXT,
  hourly_rate_minor INTEGER CHECK (hourly_rate_minor IS NULL OR hourly_rate_minor >= 0),
  monthly_rate_minor INTEGER CHECK (monthly_rate_minor IS NULL OR monthly_rate_minor >= 0),
  currency TEXT NOT NULL DEFAULT 'EGP',
  notes TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE project_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  agreed_minor INTEGER NOT NULL DEFAULT 0 CHECK (agreed_minor >= 0),
  currency TEXT NOT NULL DEFAULT 'EGP',
  fx_rate_micro INTEGER NOT NULL DEFAULT 1000000 CHECK (fx_rate_micro > 0),
  scope TEXT,
  progress_note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_assignments_person ON project_assignments(person_id);
CREATE INDEX idx_assignments_project ON project_assignments(project_id);

CREATE TABLE person_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assignment_id INTEGER NOT NULL REFERENCES project_assignments(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_person_payments_assignment ON person_payments(assignment_id);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE currencies (
  code TEXT PRIMARY KEY,
  fx_rate_micro INTEGER NOT NULL CHECK (fx_rate_micro > 0),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE backups_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'MANUAL' CHECK (kind IN ('AUTO','MANUAL')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
