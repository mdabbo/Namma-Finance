-- Milestone 14: transactional, yearly, prefix-scoped numbering.
CREATE TABLE numbering_sequences(
 sequence_type TEXT NOT NULL CHECK(sequence_type IN ('PROJECT','CONTRACT','CERTIFICATE','PAYMENT','EXPENSE')),
 year INTEGER NOT NULL CHECK(year BETWEEN 2000 AND 9999),
 prefix TEXT NOT NULL CHECK(length(prefix) BETWEEN 1 AND 12),
 last_number INTEGER NOT NULL DEFAULT 0 CHECK(last_number >= 0),
 PRIMARY KEY(sequence_type,year,prefix)
);

INSERT OR IGNORE INTO settings(key,value) VALUES('contract_number_prefix','CON');
INSERT OR IGNORE INTO settings(key,value) VALUES('certificate_number_prefix','CERT');
INSERT OR IGNORE INTO settings(key,value) VALUES('payment_number_prefix','PAY');
INSERT OR IGNORE INTO settings(key,value) VALUES('expense_number_prefix','EXP');

ALTER TABLE expenses ADD COLUMN number TEXT;
UPDATE expenses SET number='EXP-' || CASE WHEN date GLOB '[0-9][0-9][0-9][0-9]-*' THEN substr(date,1,4) ELSE 'LEGACY' END || '-' || printf('%06d',id)
 WHERE number IS NULL;
CREATE UNIQUE INDEX uq_expenses_number ON expenses(number);
CREATE TRIGGER assign_expense_fallback_number AFTER INSERT ON expenses WHEN NEW.number IS NULL
BEGIN
 UPDATE expenses SET number=(SELECT value FROM settings WHERE key='expense_number_prefix') || '-' || CASE WHEN NEW.date GLOB '[0-9][0-9][0-9][0-9]-*' THEN substr(NEW.date,1,4) ELSE 'LEGACY' END || '-' || printf('%06d',NEW.id) WHERE id=NEW.id;
END;

-- Preserve any legacy duplicates, but reject every new collision. Projects
-- already have a global UNIQUE(code) constraint.
CREATE TRIGGER enforce_contract_number_insert BEFORE INSERT ON contracts
WHEN EXISTS(SELECT 1 FROM contracts WHERE project_id=NEW.project_id AND number=NEW.number)
BEGIN SELECT RAISE(ABORT,'DUPLICATE_CONTRACT_NUMBER'); END;
CREATE TRIGGER enforce_contract_number_update BEFORE UPDATE OF project_id,number ON contracts
WHEN EXISTS(SELECT 1 FROM contracts WHERE project_id=NEW.project_id AND number=NEW.number AND id<>OLD.id)
BEGIN SELECT RAISE(ABORT,'DUPLICATE_CONTRACT_NUMBER'); END;
CREATE TRIGGER enforce_certificate_number_insert BEFORE INSERT ON payment_certificates
WHEN EXISTS(SELECT 1 FROM payment_certificates WHERE contract_id=NEW.contract_id AND number=NEW.number)
BEGIN SELECT RAISE(ABORT,'DUPLICATE_CERTIFICATE_NUMBER'); END;
CREATE TRIGGER enforce_certificate_number_update BEFORE UPDATE OF contract_id,number ON payment_certificates
WHEN EXISTS(SELECT 1 FROM payment_certificates WHERE contract_id=NEW.contract_id AND number=NEW.number AND id<>OLD.id)
BEGIN SELECT RAISE(ABORT,'DUPLICATE_CERTIFICATE_NUMBER'); END;
CREATE TRIGGER enforce_payment_number_insert BEFORE INSERT ON payments
WHEN EXISTS(SELECT 1 FROM payments WHERE contract_id=NEW.contract_id AND number=NEW.number)
BEGIN SELECT RAISE(ABORT,'DUPLICATE_PAYMENT_NUMBER'); END;
CREATE TRIGGER enforce_payment_number_update BEFORE UPDATE OF contract_id,number ON payments
WHEN EXISTS(SELECT 1 FROM payments WHERE contract_id=NEW.contract_id AND number=NEW.number AND id<>OLD.id)
BEGIN SELECT RAISE(ABORT,'DUPLICATE_PAYMENT_NUMBER'); END;

PRAGMA user_version = 22;
INSERT INTO app_metadata(key,value) VALUES('schema_version','22') ON CONFLICT(key) DO UPDATE SET value='22';
INSERT INTO app_metadata(key,value) VALUES('application_version','0.6.6') ON CONFLICT(key) DO UPDATE SET value='0.6.6';
