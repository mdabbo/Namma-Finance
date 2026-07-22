-- Milestone 4: immutable commercial terms for historical certificates.

CREATE TABLE contract_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id INTEGER NOT NULL REFERENCES contracts(id) ON DELETE RESTRICT,
  revision_number INTEGER NOT NULL CHECK (revision_number > 0),
  effective_date TEXT NOT NULL,
  contract_value_minor INTEGER NOT NULL CHECK (contract_value_minor >= 0),
  vat_bp INTEGER NOT NULL CHECK (vat_bp BETWEEN 0 AND 10000),
  retention_bp INTEGER NOT NULL CHECK (retention_bp BETWEEN 0 AND 10000),
  withholding_bp INTEGER NOT NULL CHECK (withholding_bp BETWEEN 0 AND 10000),
  advance_minor INTEGER NOT NULL CHECK (advance_minor >= 0),
  advance_recovery_method TEXT NOT NULL CHECK (advance_recovery_method IN ('PROPORTIONAL','MANUAL')),
  payment_terms_days INTEGER NOT NULL CHECK (payment_terms_days BETWEEN 0 AND 3650),
  currency TEXT NOT NULL,
  fx_rate_micro INTEGER NOT NULL CHECK (fx_rate_micro > 0),
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by TEXT,
  approved_at TEXT,
  sync_uuid TEXT,
  updated_at TEXT,
  UNIQUE(contract_id, revision_number)
);

INSERT INTO contract_revisions (
  contract_id, revision_number, effective_date, contract_value_minor, vat_bp, retention_bp,
  withholding_bp, advance_minor, advance_recovery_method, payment_terms_days, currency,
  fx_rate_micro, reason, created_at, approved_at, sync_uuid, updated_at
)
SELECT c.id, 1, COALESCE(c.signed_date, date(c.created_at)), c.value_minor, c.vat_bp,
       c.retention_bp, c.withholding_bp, c.advance_minor, c.advance_recovery_method,
       c.payment_terms_days, p.currency, p.fx_rate_micro, 'Initial terms backfilled by schema 9',
       c.created_at, c.created_at,
       lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', (abs(random()) % 4) + 1, 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))),
       COALESCE(c.updated_at, c.created_at)
FROM contracts c JOIN projects p ON p.id=c.project_id;

CREATE UNIQUE INDEX idx_contract_revisions_sync_uuid ON contract_revisions(sync_uuid);
CREATE INDEX idx_contract_revisions_effective ON contract_revisions(contract_id, effective_date, revision_number);

CREATE TRIGGER trg_contract_revisions_sync_init AFTER INSERT ON contract_revisions
WHEN NEW.sync_uuid IS NULL OR NEW.updated_at IS NULL
BEGIN
  UPDATE contract_revisions SET
    sync_uuid=COALESCE(sync_uuid, lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', (abs(random()) % 4) + 1, 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6)))),
    updated_at=COALESCE(updated_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE id=NEW.id;
END;
CREATE TRIGGER trg_contract_revisions_sync_touch AFTER UPDATE ON contract_revisions
WHEN NEW.updated_at IS OLD.updated_at
BEGIN UPDATE contract_revisions SET updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=NEW.id; END;
CREATE TRIGGER prevent_delete_contract_revisions BEFORE DELETE ON contract_revisions
BEGIN SELECT RAISE(ABORT, 'PROTECTED_CONTRACT_REVISION'); END;

CREATE TABLE variation_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id INTEGER NOT NULL REFERENCES contracts(id) ON DELETE RESTRICT,
  revision_id INTEGER NOT NULL REFERENCES contract_revisions(id) ON DELETE RESTRICT,
  number TEXT NOT NULL,
  description TEXT,
  value_delta_minor INTEGER NOT NULL,
  approved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by TEXT,
  sync_uuid TEXT,
  updated_at TEXT,
  UNIQUE(contract_id, number)
);
CREATE UNIQUE INDEX idx_variation_orders_sync_uuid ON variation_orders(sync_uuid);
CREATE INDEX idx_variation_orders_contract ON variation_orders(contract_id);
CREATE TRIGGER trg_variation_orders_sync_init AFTER INSERT ON variation_orders
WHEN NEW.sync_uuid IS NULL OR NEW.updated_at IS NULL
BEGIN
  UPDATE variation_orders SET
    sync_uuid=COALESCE(sync_uuid, lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', (abs(random()) % 4) + 1, 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6)))),
    updated_at=COALESCE(updated_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE id=NEW.id;
END;
CREATE TRIGGER trg_variation_orders_sync_touch AFTER UPDATE ON variation_orders
WHEN NEW.updated_at IS OLD.updated_at
BEGIN UPDATE variation_orders SET updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=NEW.id; END;
CREATE TRIGGER prevent_delete_variation_orders BEFORE DELETE ON variation_orders
BEGIN SELECT RAISE(ABORT, 'PROTECTED_VARIATION_ORDER'); END;

ALTER TABLE payment_certificates ADD COLUMN contract_revision_id INTEGER REFERENCES contract_revisions(id) ON DELETE RESTRICT;
ALTER TABLE payment_certificates ADD COLUMN contract_value_minor_snapshot INTEGER;
ALTER TABLE payment_certificates ADD COLUMN vat_bp_snapshot INTEGER;
ALTER TABLE payment_certificates ADD COLUMN retention_bp_snapshot INTEGER;
ALTER TABLE payment_certificates ADD COLUMN withholding_bp_snapshot INTEGER;
ALTER TABLE payment_certificates ADD COLUMN advance_minor_snapshot INTEGER;
ALTER TABLE payment_certificates ADD COLUMN advance_method_snapshot TEXT;
ALTER TABLE payment_certificates ADD COLUMN payment_terms_days_snapshot INTEGER;
ALTER TABLE payment_certificates ADD COLUMN currency_snapshot TEXT;
ALTER TABLE payment_certificates ADD COLUMN fx_rate_micro_snapshot INTEGER;

UPDATE payment_certificates
SET contract_revision_id=(SELECT id FROM contract_revisions r WHERE r.contract_id=payment_certificates.contract_id AND r.revision_number=1),
    contract_value_minor_snapshot=(SELECT contract_value_minor FROM contract_revisions r WHERE r.contract_id=payment_certificates.contract_id AND r.revision_number=1),
    vat_bp_snapshot=(SELECT vat_bp FROM contract_revisions r WHERE r.contract_id=payment_certificates.contract_id AND r.revision_number=1),
    retention_bp_snapshot=(SELECT retention_bp FROM contract_revisions r WHERE r.contract_id=payment_certificates.contract_id AND r.revision_number=1),
    withholding_bp_snapshot=(SELECT withholding_bp FROM contract_revisions r WHERE r.contract_id=payment_certificates.contract_id AND r.revision_number=1),
    advance_minor_snapshot=(SELECT advance_minor FROM contract_revisions r WHERE r.contract_id=payment_certificates.contract_id AND r.revision_number=1),
    advance_method_snapshot=(SELECT advance_recovery_method FROM contract_revisions r WHERE r.contract_id=payment_certificates.contract_id AND r.revision_number=1),
    payment_terms_days_snapshot=(SELECT payment_terms_days FROM contract_revisions r WHERE r.contract_id=payment_certificates.contract_id AND r.revision_number=1),
    currency_snapshot=(SELECT currency FROM contract_revisions r WHERE r.contract_id=payment_certificates.contract_id AND r.revision_number=1),
    fx_rate_micro_snapshot=(SELECT fx_rate_micro FROM contract_revisions r WHERE r.contract_id=payment_certificates.contract_id AND r.revision_number=1);

CREATE INDEX idx_certificates_revision ON payment_certificates(contract_revision_id);

-- Covers every insertion path, including Rust milestone generation and imports.
CREATE TRIGGER trg_certificates_bind_revision AFTER INSERT ON payment_certificates
WHEN NEW.contract_revision_id IS NULL
BEGIN
  UPDATE payment_certificates SET
    contract_revision_id=(SELECT id FROM contract_revisions r WHERE r.contract_id=NEW.contract_id AND r.approved_at IS NOT NULL ORDER BY CASE WHEN r.effective_date<=NEW.date THEN 0 ELSE 1 END,r.effective_date DESC,r.revision_number DESC LIMIT 1),
    contract_value_minor_snapshot=(SELECT contract_value_minor FROM contract_revisions r WHERE r.contract_id=NEW.contract_id AND r.approved_at IS NOT NULL ORDER BY CASE WHEN r.effective_date<=NEW.date THEN 0 ELSE 1 END,r.effective_date DESC,r.revision_number DESC LIMIT 1),
    vat_bp_snapshot=(SELECT vat_bp FROM contract_revisions r WHERE r.contract_id=NEW.contract_id AND r.approved_at IS NOT NULL ORDER BY CASE WHEN r.effective_date<=NEW.date THEN 0 ELSE 1 END,r.effective_date DESC,r.revision_number DESC LIMIT 1),
    retention_bp_snapshot=(SELECT retention_bp FROM contract_revisions r WHERE r.contract_id=NEW.contract_id AND r.approved_at IS NOT NULL ORDER BY CASE WHEN r.effective_date<=NEW.date THEN 0 ELSE 1 END,r.effective_date DESC,r.revision_number DESC LIMIT 1),
    withholding_bp_snapshot=(SELECT withholding_bp FROM contract_revisions r WHERE r.contract_id=NEW.contract_id AND r.approved_at IS NOT NULL ORDER BY CASE WHEN r.effective_date<=NEW.date THEN 0 ELSE 1 END,r.effective_date DESC,r.revision_number DESC LIMIT 1),
    advance_minor_snapshot=(SELECT advance_minor FROM contract_revisions r WHERE r.contract_id=NEW.contract_id AND r.approved_at IS NOT NULL ORDER BY CASE WHEN r.effective_date<=NEW.date THEN 0 ELSE 1 END,r.effective_date DESC,r.revision_number DESC LIMIT 1),
    advance_method_snapshot=(SELECT advance_recovery_method FROM contract_revisions r WHERE r.contract_id=NEW.contract_id AND r.approved_at IS NOT NULL ORDER BY CASE WHEN r.effective_date<=NEW.date THEN 0 ELSE 1 END,r.effective_date DESC,r.revision_number DESC LIMIT 1),
    payment_terms_days_snapshot=(SELECT payment_terms_days FROM contract_revisions r WHERE r.contract_id=NEW.contract_id AND r.approved_at IS NOT NULL ORDER BY CASE WHEN r.effective_date<=NEW.date THEN 0 ELSE 1 END,r.effective_date DESC,r.revision_number DESC LIMIT 1),
    currency_snapshot=(SELECT currency FROM contract_revisions r WHERE r.contract_id=NEW.contract_id AND r.approved_at IS NOT NULL ORDER BY CASE WHEN r.effective_date<=NEW.date THEN 0 ELSE 1 END,r.effective_date DESC,r.revision_number DESC LIMIT 1),
    fx_rate_micro_snapshot=(SELECT fx_rate_micro FROM contract_revisions r WHERE r.contract_id=NEW.contract_id AND r.approved_at IS NOT NULL ORDER BY CASE WHEN r.effective_date<=NEW.date THEN 0 ELSE 1 END,r.effective_date DESC,r.revision_number DESC LIMIT 1)
  WHERE id=NEW.id;
END;
