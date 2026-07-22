-- Milestone 11: forward-only data-quality registry and database date defenses.
CREATE TABLE data_quality_issues(
 id INTEGER PRIMARY KEY,
 entity_type TEXT NOT NULL,
 entity_id INTEGER NOT NULL,
 field_name TEXT NOT NULL,
 issue_code TEXT NOT NULL,
 raw_value TEXT,
 detected_at TEXT NOT NULL DEFAULT(datetime('now')),
 resolved_at TEXT,
 resolution_note TEXT
);
CREATE UNIQUE INDEX idx_quality_open_issue ON data_quality_issues(entity_type,entity_id,field_name,issue_code) WHERE resolved_at IS NULL;

ALTER TABLE payment_certificates ADD COLUMN due_date_confirmed_at TEXT;

INSERT OR IGNORE INTO data_quality_issues(entity_type,entity_id,field_name,issue_code,raw_value)
SELECT 'contract',id,'milestones','MALFORMED_JSON',milestones FROM contracts WHERE milestones IS NOT NULL AND (json_valid(milestones)=0 OR json_type(milestones)<>'array');
INSERT OR IGNORE INTO data_quality_issues(entity_type,entity_id,field_name,issue_code,raw_value)
SELECT 'contract',id,'drawings','MALFORMED_JSON',drawings FROM contracts WHERE drawings IS NOT NULL AND (json_valid(drawings)=0 OR json_type(drawings)<>'array');
INSERT OR IGNORE INTO data_quality_issues(entity_type,entity_id,field_name,issue_code,raw_value)
SELECT 'contract',id,'attachments','MALFORMED_JSON',attachments FROM contracts WHERE attachments IS NOT NULL AND (json_valid(attachments)=0 OR json_type(attachments)<>'array');

INSERT OR IGNORE INTO data_quality_issues(entity_type,entity_id,field_name,issue_code,raw_value)
SELECT 'project',id,'date_range','END_BEFORE_START',start_date||'..'||end_date FROM projects WHERE start_date IS NOT NULL AND end_date IS NOT NULL AND end_date<start_date;
INSERT OR IGNORE INTO data_quality_issues(entity_type,entity_id,field_name,issue_code,raw_value)
SELECT 'project_stage',id,'date_range','END_BEFORE_START',start_date||'..'||end_date FROM project_stages WHERE start_date IS NOT NULL AND end_date IS NOT NULL AND end_date<start_date;
INSERT OR IGNORE INTO data_quality_issues(entity_type,entity_id,field_name,issue_code,raw_value)
SELECT 'payment_certificate',id,'due_date_override','DUE_BEFORE_SUBMISSION',due_date_override FROM payment_certificates WHERE submission_date IS NOT NULL AND due_date_override IS NOT NULL AND due_date_override<submission_date;
INSERT OR IGNORE INTO data_quality_issues(entity_type,entity_id,field_name,issue_code,raw_value)
SELECT 'payment_certificate',pc.id,'sequence_date','SEQUENCE_DATE_INCONSISTENT',pc.seq||':'||pc.date
FROM payment_certificates pc WHERE EXISTS(
 SELECT 1 FROM payment_certificates earlier
 WHERE earlier.contract_id=pc.contract_id AND earlier.seq<pc.seq AND earlier.date>pc.date
);

CREATE TRIGGER validate_project_dates_insert BEFORE INSERT ON projects BEGIN
 SELECT CASE WHEN NEW.start_date IS NOT NULL AND date(NEW.start_date) IS NOT NEW.start_date THEN RAISE(ABORT,'INVALID_START_DATE') END;
 SELECT CASE WHEN NEW.end_date IS NOT NULL AND date(NEW.end_date) IS NOT NEW.end_date THEN RAISE(ABORT,'INVALID_END_DATE') END;
 SELECT CASE WHEN NEW.start_date IS NOT NULL AND NEW.end_date IS NOT NULL AND NEW.end_date<NEW.start_date THEN RAISE(ABORT,'END_BEFORE_START') END;
END;
CREATE TRIGGER validate_project_dates_update BEFORE UPDATE OF start_date,end_date ON projects BEGIN
 SELECT CASE WHEN NEW.start_date IS NOT NULL AND date(NEW.start_date) IS NOT NEW.start_date THEN RAISE(ABORT,'INVALID_START_DATE') END;
 SELECT CASE WHEN NEW.end_date IS NOT NULL AND date(NEW.end_date) IS NOT NEW.end_date THEN RAISE(ABORT,'INVALID_END_DATE') END;
 SELECT CASE WHEN NEW.start_date IS NOT NULL AND NEW.end_date IS NOT NULL AND NEW.end_date<NEW.start_date THEN RAISE(ABORT,'END_BEFORE_START') END;
END;
CREATE TRIGGER validate_stage_dates_insert BEFORE INSERT ON project_stages BEGIN
 SELECT CASE WHEN NEW.start_date IS NOT NULL AND date(NEW.start_date) IS NOT NEW.start_date THEN RAISE(ABORT,'INVALID_START_DATE') END;
 SELECT CASE WHEN NEW.end_date IS NOT NULL AND date(NEW.end_date) IS NOT NEW.end_date THEN RAISE(ABORT,'INVALID_END_DATE') END;
 SELECT CASE WHEN NEW.start_date IS NOT NULL AND NEW.end_date IS NOT NULL AND NEW.end_date<NEW.start_date THEN RAISE(ABORT,'END_BEFORE_START') END;
END;
CREATE TRIGGER validate_stage_dates_update BEFORE UPDATE OF start_date,end_date ON project_stages BEGIN
 SELECT CASE WHEN NEW.start_date IS NOT NULL AND date(NEW.start_date) IS NOT NEW.start_date THEN RAISE(ABORT,'INVALID_START_DATE') END;
 SELECT CASE WHEN NEW.end_date IS NOT NULL AND date(NEW.end_date) IS NOT NEW.end_date THEN RAISE(ABORT,'INVALID_END_DATE') END;
 SELECT CASE WHEN NEW.start_date IS NOT NULL AND NEW.end_date IS NOT NULL AND NEW.end_date<NEW.start_date THEN RAISE(ABORT,'END_BEFORE_START') END;
END;
CREATE TRIGGER validate_contract_dates_insert BEFORE INSERT ON contracts BEGIN
 SELECT CASE WHEN NEW.signed_date IS NOT NULL AND date(NEW.signed_date) IS NOT NEW.signed_date THEN RAISE(ABORT,'INVALID_CONTRACT_DATE') END;
 SELECT CASE WHEN NEW.performance_bond_expiry IS NOT NULL AND date(NEW.performance_bond_expiry) IS NOT NEW.performance_bond_expiry THEN RAISE(ABORT,'INVALID_BOND_EXPIRY_DATE') END;
END;
CREATE TRIGGER validate_contract_dates_update BEFORE UPDATE OF signed_date,performance_bond_expiry ON contracts BEGIN
 SELECT CASE WHEN NEW.signed_date IS NOT NULL AND date(NEW.signed_date) IS NOT NEW.signed_date THEN RAISE(ABORT,'INVALID_CONTRACT_DATE') END;
 SELECT CASE WHEN NEW.performance_bond_expiry IS NOT NULL AND date(NEW.performance_bond_expiry) IS NOT NEW.performance_bond_expiry THEN RAISE(ABORT,'INVALID_BOND_EXPIRY_DATE') END;
END;
CREATE TRIGGER validate_revision_date_insert BEFORE INSERT ON contract_revisions BEGIN SELECT CASE WHEN date(NEW.effective_date) IS NOT NEW.effective_date THEN RAISE(ABORT,'INVALID_REVISION_DATE') END; END;
CREATE TRIGGER validate_revision_date_update BEFORE UPDATE OF effective_date ON contract_revisions BEGIN SELECT CASE WHEN date(NEW.effective_date) IS NOT NEW.effective_date THEN RAISE(ABORT,'INVALID_REVISION_DATE') END; END;
CREATE TRIGGER validate_certificate_dates_insert BEFORE INSERT ON payment_certificates BEGIN
 SELECT CASE WHEN date(NEW.date) IS NOT NEW.date THEN RAISE(ABORT,'INVALID_CERTIFICATE_DATE') END;
 SELECT CASE WHEN NEW.submission_date IS NOT NULL AND date(NEW.submission_date) IS NOT NEW.submission_date THEN RAISE(ABORT,'INVALID_SUBMISSION_DATE') END;
 SELECT CASE WHEN NEW.due_date_override IS NOT NULL AND date(NEW.due_date_override) IS NOT NEW.due_date_override THEN RAISE(ABORT,'INVALID_DUE_DATE') END;
 SELECT CASE WHEN NEW.submission_date IS NOT NULL AND NEW.due_date_override IS NOT NULL AND NEW.due_date_override<NEW.submission_date AND NEW.due_date_confirmed_at IS NULL THEN RAISE(ABORT,'DUE_BEFORE_SUBMISSION_CONFIRMATION_REQUIRED') END;
END;
CREATE TRIGGER validate_certificate_dates_update BEFORE UPDATE OF date,submission_date,due_date_override,due_date_confirmed_at ON payment_certificates BEGIN
 SELECT CASE WHEN date(NEW.date) IS NOT NEW.date THEN RAISE(ABORT,'INVALID_CERTIFICATE_DATE') END;
 SELECT CASE WHEN NEW.submission_date IS NOT NULL AND date(NEW.submission_date) IS NOT NEW.submission_date THEN RAISE(ABORT,'INVALID_SUBMISSION_DATE') END;
 SELECT CASE WHEN NEW.due_date_override IS NOT NULL AND date(NEW.due_date_override) IS NOT NEW.due_date_override THEN RAISE(ABORT,'INVALID_DUE_DATE') END;
 SELECT CASE WHEN NEW.submission_date IS NOT NULL AND NEW.due_date_override IS NOT NULL AND NEW.due_date_override<NEW.submission_date AND NEW.due_date_confirmed_at IS NULL THEN RAISE(ABORT,'DUE_BEFORE_SUBMISSION_CONFIRMATION_REQUIRED') END;
END;
CREATE TRIGGER flag_certificate_sequence_date_insert AFTER INSERT ON payment_certificates
WHEN EXISTS(SELECT 1 FROM payment_certificates other WHERE other.contract_id=NEW.contract_id AND other.id<>NEW.id AND ((other.seq<NEW.seq AND other.date>NEW.date) OR (other.seq>NEW.seq AND other.date<NEW.date)))
BEGIN
 INSERT OR IGNORE INTO data_quality_issues(entity_type,entity_id,field_name,issue_code,raw_value)
 VALUES('payment_certificate',NEW.id,'sequence_date','SEQUENCE_DATE_INCONSISTENT',NEW.seq||':'||NEW.date);
END;
CREATE TRIGGER flag_certificate_sequence_date_update AFTER UPDATE OF contract_id,seq,date ON payment_certificates
WHEN EXISTS(SELECT 1 FROM payment_certificates other WHERE other.contract_id=NEW.contract_id AND other.id<>NEW.id AND ((other.seq<NEW.seq AND other.date>NEW.date) OR (other.seq>NEW.seq AND other.date<NEW.date)))
BEGIN
 INSERT OR IGNORE INTO data_quality_issues(entity_type,entity_id,field_name,issue_code,raw_value)
 VALUES('payment_certificate',NEW.id,'sequence_date','SEQUENCE_DATE_INCONSISTENT',NEW.seq||':'||NEW.date);
END;
CREATE TRIGGER validate_payment_date_insert BEFORE INSERT ON payments BEGIN
 SELECT CASE WHEN date(NEW.date) IS NOT NEW.date THEN RAISE(ABORT,'INVALID_PAYMENT_DATE') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM contracts c WHERE c.id=NEW.contract_id AND c.signed_date IS NOT NULL AND NEW.date<c.signed_date) THEN RAISE(ABORT,'PAYMENT_BEFORE_CONTRACT_DATE') END;
END;
CREATE TRIGGER validate_payment_date_update BEFORE UPDATE OF date,contract_id ON payments BEGIN
 SELECT CASE WHEN date(NEW.date) IS NOT NEW.date THEN RAISE(ABORT,'INVALID_PAYMENT_DATE') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM contracts c WHERE c.id=NEW.contract_id AND c.signed_date IS NOT NULL AND NEW.date<c.signed_date) THEN RAISE(ABORT,'PAYMENT_BEFORE_CONTRACT_DATE') END;
END;
CREATE TRIGGER validate_expense_date_insert BEFORE INSERT ON expenses BEGIN SELECT CASE WHEN date(NEW.date) IS NOT NEW.date THEN RAISE(ABORT,'INVALID_EXPENSE_DATE') END; END;
CREATE TRIGGER validate_expense_date_update BEFORE UPDATE OF date ON expenses BEGIN SELECT CASE WHEN date(NEW.date) IS NOT NEW.date THEN RAISE(ABORT,'INVALID_EXPENSE_DATE') END; END;
CREATE TRIGGER validate_person_payment_date_insert BEFORE INSERT ON person_payments BEGIN SELECT CASE WHEN date(NEW.date) IS NOT NEW.date THEN RAISE(ABORT,'INVALID_PERSON_PAYMENT_DATE') END; END;
CREATE TRIGGER validate_person_payment_date_update BEFORE UPDATE OF date ON person_payments BEGIN SELECT CASE WHEN date(NEW.date) IS NOT NEW.date THEN RAISE(ABORT,'INVALID_PERSON_PAYMENT_DATE') END; END;
CREATE TRIGGER validate_time_entry_date_insert BEFORE INSERT ON time_entries BEGIN SELECT CASE WHEN date(NEW.date) IS NOT NEW.date THEN RAISE(ABORT,'INVALID_TIME_ENTRY_DATE') END; END;
CREATE TRIGGER validate_time_entry_date_update BEFORE UPDATE OF date ON time_entries BEGIN SELECT CASE WHEN date(NEW.date) IS NOT NEW.date THEN RAISE(ABORT,'INVALID_TIME_ENTRY_DATE') END; END;

UPDATE app_metadata SET value='16' WHERE key='schema_version';
PRAGMA user_version=16;
