-- Milestone 3: immutable financial history and safe lifecycle states.
-- Forward-only: existing rows and existing deleted_at history are preserved.

ALTER TABLE clients ADD COLUMN archived_at TEXT;
ALTER TABLE clients ADD COLUMN archived_by TEXT;
ALTER TABLE clients ADD COLUMN archive_reason TEXT;

ALTER TABLE projects ADD COLUMN archived_at TEXT;
ALTER TABLE projects ADD COLUMN archived_by TEXT;
ALTER TABLE projects ADD COLUMN archive_reason TEXT;

ALTER TABLE contracts ADD COLUMN archived_at TEXT;
ALTER TABLE contracts ADD COLUMN archived_by TEXT;
ALTER TABLE contracts ADD COLUMN archive_reason TEXT;

ALTER TABLE people ADD COLUMN archived_at TEXT;
ALTER TABLE people ADD COLUMN archived_by TEXT;
ALTER TABLE people ADD COLUMN archive_reason TEXT;

ALTER TABLE project_assignments ADD COLUMN archived_at TEXT;
ALTER TABLE project_assignments ADD COLUMN archived_by TEXT;
ALTER TABLE project_assignments ADD COLUMN archive_reason TEXT;

ALTER TABLE payment_certificates ADD COLUMN archived_at TEXT;
ALTER TABLE payment_certificates ADD COLUMN archived_by TEXT;
ALTER TABLE payment_certificates ADD COLUMN archive_reason TEXT;
ALTER TABLE payment_certificates ADD COLUMN voided_at TEXT;
ALTER TABLE payment_certificates ADD COLUMN voided_by TEXT;
ALTER TABLE payment_certificates ADD COLUMN void_reason TEXT;
ALTER TABLE payment_certificates ADD COLUMN reversal_of_id INTEGER REFERENCES payment_certificates(id) ON DELETE RESTRICT;
UPDATE payment_certificates
SET voided_at = COALESCE(voided_at, deleted_at),
    void_reason = CASE WHEN deleted_at IS NOT NULL THEN COALESCE(void_reason, 'Legacy soft deletion') ELSE void_reason END
WHERE deleted_at IS NOT NULL;

ALTER TABLE payments ADD COLUMN voided_at TEXT;
ALTER TABLE payments ADD COLUMN voided_by TEXT;
ALTER TABLE payments ADD COLUMN void_reason TEXT;
ALTER TABLE payments ADD COLUMN reversal_of_id INTEGER REFERENCES payments(id) ON DELETE RESTRICT;
UPDATE payments
SET voided_at = COALESCE(voided_at, deleted_at),
    void_reason = CASE WHEN deleted_at IS NOT NULL THEN COALESCE(void_reason, 'Legacy soft deletion') ELSE void_reason END
WHERE deleted_at IS NOT NULL;

ALTER TABLE person_payments ADD COLUMN voided_at TEXT;
ALTER TABLE person_payments ADD COLUMN voided_by TEXT;
ALTER TABLE person_payments ADD COLUMN void_reason TEXT;
ALTER TABLE person_payments ADD COLUMN reversal_of_id INTEGER REFERENCES person_payments(id) ON DELETE RESTRICT;

ALTER TABLE expenses ADD COLUMN archived_at TEXT;
ALTER TABLE expenses ADD COLUMN archived_by TEXT;
ALTER TABLE expenses ADD COLUMN archive_reason TEXT;
ALTER TABLE expenses ADD COLUMN voided_at TEXT;
ALTER TABLE expenses ADD COLUMN voided_by TEXT;
ALTER TABLE expenses ADD COLUMN void_reason TEXT;
ALTER TABLE expenses ADD COLUMN reversal_of_id INTEGER REFERENCES expenses(id) ON DELETE RESTRICT;

CREATE INDEX idx_clients_archived ON clients(archived_at);
CREATE INDEX idx_projects_archived ON projects(archived_at);
CREATE INDEX idx_contracts_archived ON contracts(archived_at);
CREATE INDEX idx_people_archived ON people(archived_at);
CREATE INDEX idx_assignments_archived ON project_assignments(archived_at);
CREATE INDEX idx_certificates_lifecycle ON payment_certificates(voided_at, archived_at);
CREATE INDEX idx_payments_voided ON payments(voided_at);
CREATE INDEX idx_person_payments_voided ON person_payments(voided_at);
CREATE INDEX idx_expenses_lifecycle ON expenses(voided_at, archived_at);

-- Normal SQL and legacy code can no longer physically erase protected history.
-- A future administrator-only maintenance command may temporarily drop a guard
-- after independently proving that a draft row has no financial descendants.
CREATE TRIGGER prevent_delete_clients BEFORE DELETE ON clients BEGIN SELECT RAISE(ABORT, 'PROTECTED_RECORD_USE_ARCHIVE'); END;
CREATE TRIGGER prevent_delete_projects BEFORE DELETE ON projects BEGIN SELECT RAISE(ABORT, 'PROTECTED_RECORD_USE_ARCHIVE'); END;
CREATE TRIGGER prevent_delete_contracts BEFORE DELETE ON contracts BEGIN SELECT RAISE(ABORT, 'PROTECTED_RECORD_USE_ARCHIVE'); END;
CREATE TRIGGER prevent_delete_certificates BEFORE DELETE ON payment_certificates BEGIN SELECT RAISE(ABORT, 'PROTECTED_FINANCIAL_RECORD_USE_VOID'); END;
CREATE TRIGGER prevent_delete_payments BEFORE DELETE ON payments BEGIN SELECT RAISE(ABORT, 'PROTECTED_FINANCIAL_RECORD_USE_VOID'); END;
CREATE TRIGGER prevent_delete_people BEFORE DELETE ON people BEGIN SELECT RAISE(ABORT, 'PROTECTED_RECORD_USE_ARCHIVE'); END;
CREATE TRIGGER prevent_delete_assignments BEFORE DELETE ON project_assignments BEGIN SELECT RAISE(ABORT, 'PROTECTED_RECORD_USE_ARCHIVE'); END;
CREATE TRIGGER prevent_delete_person_payments BEFORE DELETE ON person_payments BEGIN SELECT RAISE(ABORT, 'PROTECTED_FINANCIAL_RECORD_USE_REVERSE'); END;
CREATE TRIGGER prevent_delete_expenses BEFORE DELETE ON expenses BEGIN SELECT RAISE(ABORT, 'PROTECTED_FINANCIAL_RECORD_USE_VOID'); END;
