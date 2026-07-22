-- Milestone 11 audit: register legacy invalid dates and keep sequence/date flags current.
-- This migration changes no source financial or domain values.

INSERT OR IGNORE INTO data_quality_issues(entity_type,entity_id,field_name,issue_code,raw_value)
SELECT 'project',id,'start_date','INVALID_CALENDAR_DATE',start_date FROM projects WHERE start_date IS NOT NULL AND date(start_date) IS NOT start_date;
INSERT OR IGNORE INTO data_quality_issues(entity_type,entity_id,field_name,issue_code,raw_value)
SELECT 'project',id,'end_date','INVALID_CALENDAR_DATE',end_date FROM projects WHERE end_date IS NOT NULL AND date(end_date) IS NOT end_date;
INSERT OR IGNORE INTO data_quality_issues(entity_type,entity_id,field_name,issue_code,raw_value)
SELECT 'project_stage',id,'start_date','INVALID_CALENDAR_DATE',start_date FROM project_stages WHERE start_date IS NOT NULL AND date(start_date) IS NOT start_date;
INSERT OR IGNORE INTO data_quality_issues(entity_type,entity_id,field_name,issue_code,raw_value)
SELECT 'project_stage',id,'end_date','INVALID_CALENDAR_DATE',end_date FROM project_stages WHERE end_date IS NOT NULL AND date(end_date) IS NOT end_date;
INSERT OR IGNORE INTO data_quality_issues(entity_type,entity_id,field_name,issue_code,raw_value)
SELECT 'contract',id,'signed_date','INVALID_CALENDAR_DATE',signed_date FROM contracts WHERE signed_date IS NOT NULL AND date(signed_date) IS NOT signed_date;
INSERT OR IGNORE INTO data_quality_issues(entity_type,entity_id,field_name,issue_code,raw_value)
SELECT 'contract',id,'performance_bond_expiry','INVALID_CALENDAR_DATE',performance_bond_expiry FROM contracts WHERE performance_bond_expiry IS NOT NULL AND date(performance_bond_expiry) IS NOT performance_bond_expiry;
INSERT OR IGNORE INTO data_quality_issues(entity_type,entity_id,field_name,issue_code,raw_value)
SELECT 'contract_revision',id,'effective_date','INVALID_CALENDAR_DATE',effective_date FROM contract_revisions WHERE date(effective_date) IS NOT effective_date;
INSERT OR IGNORE INTO data_quality_issues(entity_type,entity_id,field_name,issue_code,raw_value)
SELECT 'payment_certificate',id,'date','INVALID_CALENDAR_DATE',date FROM payment_certificates WHERE date(date) IS NOT date;
INSERT OR IGNORE INTO data_quality_issues(entity_type,entity_id,field_name,issue_code,raw_value)
SELECT 'payment_certificate',id,'submission_date','INVALID_CALENDAR_DATE',submission_date FROM payment_certificates WHERE submission_date IS NOT NULL AND date(submission_date) IS NOT submission_date;
INSERT OR IGNORE INTO data_quality_issues(entity_type,entity_id,field_name,issue_code,raw_value)
SELECT 'payment_certificate',id,'due_date_override','INVALID_CALENDAR_DATE',due_date_override FROM payment_certificates WHERE due_date_override IS NOT NULL AND date(due_date_override) IS NOT due_date_override;
INSERT OR IGNORE INTO data_quality_issues(entity_type,entity_id,field_name,issue_code,raw_value)
SELECT 'payment',id,'date','INVALID_CALENDAR_DATE',date FROM payments WHERE date(date) IS NOT date;
INSERT OR IGNORE INTO data_quality_issues(entity_type,entity_id,field_name,issue_code,raw_value)
SELECT 'expense',id,'date','INVALID_CALENDAR_DATE',date FROM expenses WHERE date(date) IS NOT date;
INSERT OR IGNORE INTO data_quality_issues(entity_type,entity_id,field_name,issue_code,raw_value)
SELECT 'person_payment',id,'date','INVALID_CALENDAR_DATE',date FROM person_payments WHERE date(date) IS NOT date;
INSERT OR IGNORE INTO data_quality_issues(entity_type,entity_id,field_name,issue_code,raw_value)
SELECT 'time_entry',id,'date','INVALID_CALENDAR_DATE',date FROM time_entries WHERE date(date) IS NOT date;

DROP TRIGGER flag_certificate_sequence_date_insert;
DROP TRIGGER flag_certificate_sequence_date_update;

CREATE TRIGGER register_contract_json_insert AFTER INSERT ON contracts BEGIN
 INSERT OR IGNORE INTO data_quality_issues(entity_type,entity_id,field_name,issue_code,raw_value)
 SELECT 'contract',NEW.id,'milestones','MALFORMED_JSON',NEW.milestones WHERE NEW.milestones IS NOT NULL AND (json_valid(NEW.milestones)=0 OR json_type(NEW.milestones)<>'array');
 INSERT OR IGNORE INTO data_quality_issues(entity_type,entity_id,field_name,issue_code,raw_value)
 SELECT 'contract',NEW.id,'drawings','MALFORMED_JSON',NEW.drawings WHERE NEW.drawings IS NOT NULL AND (json_valid(NEW.drawings)=0 OR json_type(NEW.drawings)<>'array');
 INSERT OR IGNORE INTO data_quality_issues(entity_type,entity_id,field_name,issue_code,raw_value)
 SELECT 'contract',NEW.id,'attachments','MALFORMED_JSON',NEW.attachments WHERE NEW.attachments IS NOT NULL AND (json_valid(NEW.attachments)=0 OR json_type(NEW.attachments)<>'array');
END;

CREATE TRIGGER register_contract_json_update AFTER UPDATE OF milestones,drawings,attachments ON contracts BEGIN
 UPDATE data_quality_issues SET resolved_at=datetime('now'),resolution_note='Structured data explicitly repaired'
 WHERE resolved_at IS NULL AND entity_type='contract' AND entity_id=NEW.id AND issue_code='MALFORMED_JSON'
   AND ((field_name='milestones' AND (NEW.milestones IS NULL OR (json_valid(NEW.milestones)=1 AND json_type(NEW.milestones)='array')))
     OR (field_name='drawings' AND (NEW.drawings IS NULL OR (json_valid(NEW.drawings)=1 AND json_type(NEW.drawings)='array')))
     OR (field_name='attachments' AND (NEW.attachments IS NULL OR (json_valid(NEW.attachments)=1 AND json_type(NEW.attachments)='array'))));
 INSERT OR IGNORE INTO data_quality_issues(entity_type,entity_id,field_name,issue_code,raw_value)
 SELECT 'contract',NEW.id,'milestones','MALFORMED_JSON',NEW.milestones WHERE NEW.milestones IS NOT NULL AND (json_valid(NEW.milestones)=0 OR json_type(NEW.milestones)<>'array');
 INSERT OR IGNORE INTO data_quality_issues(entity_type,entity_id,field_name,issue_code,raw_value)
 SELECT 'contract',NEW.id,'drawings','MALFORMED_JSON',NEW.drawings WHERE NEW.drawings IS NOT NULL AND (json_valid(NEW.drawings)=0 OR json_type(NEW.drawings)<>'array');
 INSERT OR IGNORE INTO data_quality_issues(entity_type,entity_id,field_name,issue_code,raw_value)
 SELECT 'contract',NEW.id,'attachments','MALFORMED_JSON',NEW.attachments WHERE NEW.attachments IS NOT NULL AND (json_valid(NEW.attachments)=0 OR json_type(NEW.attachments)<>'array');
END;

CREATE TRIGGER flag_certificate_sequence_date_insert AFTER INSERT ON payment_certificates BEGIN
 UPDATE data_quality_issues SET resolved_at=datetime('now'),resolution_note='Sequence/date inconsistency corrected'
 WHERE resolved_at IS NULL AND entity_type='payment_certificate' AND field_name='sequence_date'
   AND entity_id IN (SELECT id FROM payment_certificates WHERE contract_id=NEW.contract_id);
 INSERT OR IGNORE INTO data_quality_issues(entity_type,entity_id,field_name,issue_code,raw_value)
 SELECT 'payment_certificate',pc.id,'sequence_date','SEQUENCE_DATE_INCONSISTENT',pc.seq||':'||pc.date
 FROM payment_certificates pc
 WHERE pc.contract_id=NEW.contract_id AND pc.deleted_at IS NULL AND pc.voided_at IS NULL AND pc.archived_at IS NULL
   AND EXISTS(SELECT 1 FROM payment_certificates other
     WHERE other.contract_id=pc.contract_id AND other.id<>pc.id
       AND other.deleted_at IS NULL AND other.voided_at IS NULL AND other.archived_at IS NULL
       AND ((other.seq<pc.seq AND other.date>pc.date) OR (other.seq>pc.seq AND other.date<pc.date)));
END;

CREATE TRIGGER flag_certificate_sequence_date_update AFTER UPDATE OF contract_id,seq,date,deleted_at,voided_at,archived_at ON payment_certificates BEGIN
 UPDATE data_quality_issues SET resolved_at=datetime('now'),resolution_note='Sequence/date inconsistency corrected'
 WHERE resolved_at IS NULL AND entity_type='payment_certificate' AND field_name='sequence_date'
   AND entity_id IN (SELECT id FROM payment_certificates WHERE contract_id=OLD.contract_id OR contract_id=NEW.contract_id);
 INSERT OR IGNORE INTO data_quality_issues(entity_type,entity_id,field_name,issue_code,raw_value)
 SELECT 'payment_certificate',pc.id,'sequence_date','SEQUENCE_DATE_INCONSISTENT',pc.seq||':'||pc.date
 FROM payment_certificates pc
 WHERE (pc.contract_id=OLD.contract_id OR pc.contract_id=NEW.contract_id)
   AND pc.deleted_at IS NULL AND pc.voided_at IS NULL AND pc.archived_at IS NULL
   AND EXISTS(SELECT 1 FROM payment_certificates other
     WHERE other.contract_id=pc.contract_id AND other.id<>pc.id
       AND other.deleted_at IS NULL AND other.voided_at IS NULL AND other.archived_at IS NULL
       AND ((other.seq<pc.seq AND other.date>pc.date) OR (other.seq>pc.seq AND other.date<pc.date)));
END;

UPDATE app_metadata SET value='17' WHERE key='schema_version';
PRAGMA user_version=17;
