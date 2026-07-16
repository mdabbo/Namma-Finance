-- Phase 2: project stages, document management, recurring expenses,
-- configurable overhead-allocation rule.

CREATE TABLE project_stages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  start_date TEXT,
  end_date TEXT,
  status TEXT NOT NULL DEFAULT 'PLANNED'
    CHECK (status IN ('PLANNED','IN_PROGRESS','COMPLETED','ON_HOLD')),
  completion_bp INTEGER NOT NULL DEFAULT 0 CHECK (completion_bp BETWEEN 0 AND 10000),
  engineers TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_stages_project ON project_stages(project_id);

CREATE TABLE documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  category TEXT NOT NULL DEFAULT 'OTHER'
    CHECK (category IN ('CONTRACT','BOQ','PROPOSAL','INVOICE','DRAWING','OTHER')),
  title TEXT NOT NULL,
  path TEXT NOT NULL,
  added_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_documents_project ON documents(project_id);

CREATE TABLE recurring_expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  category_id INTEGER NOT NULL REFERENCES expense_categories(id) ON DELETE RESTRICT,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL DEFAULT 'EGP',
  fx_rate_micro INTEGER NOT NULL DEFAULT 1000000 CHECK (fx_rate_micro > 0),
  day_of_month INTEGER NOT NULL DEFAULT 1 CHECK (day_of_month BETWEEN 1 AND 31),
  is_active INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO settings (key, value) VALUES ('overhead_rule', 'REVENUE');
