-- Milestone 14 independent audit remediation. Forward-only.
-- The AFTER INSERT fallback assigns legacy/system-created expenses a number;
-- these guards prevent later sync or SQL updates from removing that identity.
CREATE TRIGGER prevent_expense_number_empty_insert BEFORE INSERT ON expenses
WHEN NEW.number IS NOT NULL AND trim(NEW.number)=''
BEGIN SELECT RAISE(ABORT,'EXPENSE_NUMBER_REQUIRED'); END;
CREATE TRIGGER prevent_expense_number_clear BEFORE UPDATE OF number ON expenses
WHEN NEW.number IS NULL OR trim(NEW.number)=''
BEGIN SELECT RAISE(ABORT,'EXPENSE_NUMBER_REQUIRED'); END;

PRAGMA user_version = 23;
INSERT INTO app_metadata(key,value) VALUES('schema_version','23') ON CONFLICT(key) DO UPDATE SET value='23';
INSERT INTO app_metadata(key,value) VALUES('application_version','0.6.7') ON CONFLICT(key) DO UPDATE SET value='0.6.7';
