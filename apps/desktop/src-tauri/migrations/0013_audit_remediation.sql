-- Milestone 8 independent-audit remediation. Forward-only; 0012 is unchanged.
-- Adds transaction-scoped source/version enrichment and repairs incomplete
-- contract/certificate evidence found during the senior audit.

CREATE TABLE audit_context(
  id INTEGER PRIMARY KEY CHECK(id=1),
  source TEXT NOT NULL DEFAULT 'DESKTOP',
  application_version TEXT NOT NULL DEFAULT '0.6.3'
);
INSERT INTO audit_context(id,source,application_version) VALUES(1,'DESKTOP','0.6.3');
INSERT OR IGNORE INTO settings(key,value) VALUES('sync_user_id','');

DROP TRIGGER prevent_audit_update;
ALTER TABLE audit_logs ADD COLUMN finalized INTEGER NOT NULL DEFAULT 0 CHECK(finalized IN(0,1));
UPDATE audit_logs SET entity_uuid=CASE entity_type
 WHEN 'project' THEN (SELECT sync_uuid FROM projects WHERE id=audit_logs.entity_id)
 WHEN 'contract' THEN (SELECT sync_uuid FROM contracts WHERE id=audit_logs.entity_id)
 WHEN 'contract_revision' THEN (SELECT sync_uuid FROM contract_revisions WHERE id=audit_logs.entity_id)
 WHEN 'variation_order' THEN (SELECT sync_uuid FROM variation_orders WHERE id=audit_logs.entity_id)
 WHEN 'payment_certificate' THEN (SELECT sync_uuid FROM payment_certificates WHERE id=audit_logs.entity_id)
 WHEN 'payment' THEN (SELECT sync_uuid FROM payments WHERE id=audit_logs.entity_id)
 WHEN 'payment_allocation' THEN (SELECT sync_uuid FROM payment_certificate_allocations WHERE id=audit_logs.entity_id)
 WHEN 'expense' THEN (SELECT sync_uuid FROM expenses WHERE id=audit_logs.entity_id)
 WHEN 'person' THEN (SELECT sync_uuid FROM people WHERE id=audit_logs.entity_id)
 WHEN 'project_assignment' THEN (SELECT sync_uuid FROM project_assignments WHERE id=audit_logs.entity_id)
 WHEN 'person_payment' THEN (SELECT sync_uuid FROM person_payments WHERE id=audit_logs.entity_id)
 WHEN 'recurring_expense' THEN (SELECT sync_uuid FROM recurring_expenses WHERE id=audit_logs.entity_id)
 WHEN 'time_entry' THEN (SELECT sync_uuid FROM time_entries WHERE id=audit_logs.entity_id)
 WHEN 'expense_category' THEN (SELECT sync_uuid FROM expense_categories WHERE id=audit_logs.entity_id)
 ELSE entity_uuid END
WHERE entity_uuid IS NULL AND entity_id IS NOT NULL;
UPDATE audit_logs SET application_version='0.6.3',finalized=1 WHERE finalized=0;

CREATE TRIGGER prevent_audit_update BEFORE UPDATE ON audit_logs
WHEN NOT ((
  OLD.finalized=0 AND NEW.finalized=1 AND
  NEW.id IS OLD.id AND NEW.timestamp IS OLD.timestamp AND
  NEW.user_id IS COALESCE(NULLIF((SELECT value FROM settings WHERE key='sync_user_id'),''),OLD.user_id) AND
  NEW.device_id IS OLD.device_id AND NEW.action IS OLD.action AND
  NEW.entity_type IS OLD.entity_type AND NEW.entity_id IS OLD.entity_id AND
  NEW.entity_uuid IS OLD.entity_uuid AND NEW.before_json IS OLD.before_json AND
  NEW.after_json IS OLD.after_json AND NEW.reason IS OLD.reason
) OR (
  OLD.finalized=1 AND NEW.finalized=1 AND OLD.entity_uuid IS NULL AND NEW.entity_uuid IS NOT NULL AND
  NEW.id IS OLD.id AND NEW.timestamp IS OLD.timestamp AND NEW.user_id IS OLD.user_id AND
  NEW.device_id IS OLD.device_id AND NEW.action IS OLD.action AND NEW.entity_type IS OLD.entity_type AND
  NEW.entity_id IS OLD.entity_id AND NEW.before_json IS OLD.before_json AND NEW.after_json IS OLD.after_json AND
  NEW.reason IS OLD.reason AND NEW.source IS OLD.source AND NEW.application_version IS OLD.application_version
))
BEGIN SELECT RAISE(ABORT,'AUDIT_LOG_IMMUTABLE'); END;

CREATE TRIGGER finalize_audit_insert AFTER INSERT ON audit_logs WHEN NEW.finalized=0
BEGIN
  UPDATE audit_logs SET
    user_id=COALESCE(NULLIF((SELECT value FROM settings WHERE key='sync_user_id'),''),NEW.user_id),
    source=CASE WHEN NEW.source='DESKTOP' THEN COALESCE((SELECT source FROM audit_context WHERE id=1),'DESKTOP') ELSE NEW.source END,
    application_version=COALESCE((SELECT application_version FROM audit_context WHERE id=1),'0.6.3'),
    finalized=1
  WHERE id=NEW.id;
END;

CREATE TRIGGER bind_audit_project_uuid AFTER UPDATE OF sync_uuid ON projects WHEN OLD.sync_uuid IS NULL AND NEW.sync_uuid IS NOT NULL BEGIN UPDATE audit_logs SET entity_uuid=NEW.sync_uuid WHERE entity_type='project' AND entity_id=NEW.id AND entity_uuid IS NULL; END;
CREATE TRIGGER bind_audit_contract_uuid AFTER UPDATE OF sync_uuid ON contracts WHEN OLD.sync_uuid IS NULL AND NEW.sync_uuid IS NOT NULL BEGIN UPDATE audit_logs SET entity_uuid=NEW.sync_uuid WHERE entity_type='contract' AND entity_id=NEW.id AND entity_uuid IS NULL; END;
CREATE TRIGGER bind_audit_revision_uuid AFTER UPDATE OF sync_uuid ON contract_revisions WHEN OLD.sync_uuid IS NULL AND NEW.sync_uuid IS NOT NULL BEGIN UPDATE audit_logs SET entity_uuid=NEW.sync_uuid WHERE entity_type='contract_revision' AND entity_id=NEW.id AND entity_uuid IS NULL; END;
CREATE TRIGGER bind_audit_variation_uuid AFTER UPDATE OF sync_uuid ON variation_orders WHEN OLD.sync_uuid IS NULL AND NEW.sync_uuid IS NOT NULL BEGIN UPDATE audit_logs SET entity_uuid=NEW.sync_uuid WHERE entity_type='variation_order' AND entity_id=NEW.id AND entity_uuid IS NULL; END;
CREATE TRIGGER bind_audit_certificate_uuid AFTER UPDATE OF sync_uuid ON payment_certificates WHEN OLD.sync_uuid IS NULL AND NEW.sync_uuid IS NOT NULL BEGIN UPDATE audit_logs SET entity_uuid=NEW.sync_uuid WHERE entity_type='payment_certificate' AND entity_id=NEW.id AND entity_uuid IS NULL; END;
CREATE TRIGGER bind_audit_payment_uuid AFTER UPDATE OF sync_uuid ON payments WHEN OLD.sync_uuid IS NULL AND NEW.sync_uuid IS NOT NULL BEGIN UPDATE audit_logs SET entity_uuid=NEW.sync_uuid WHERE entity_type='payment' AND entity_id=NEW.id AND entity_uuid IS NULL; END;
CREATE TRIGGER bind_audit_allocation_uuid AFTER UPDATE OF sync_uuid ON payment_certificate_allocations WHEN OLD.sync_uuid IS NULL AND NEW.sync_uuid IS NOT NULL BEGIN UPDATE audit_logs SET entity_uuid=NEW.sync_uuid WHERE entity_type='payment_allocation' AND entity_id=NEW.id AND entity_uuid IS NULL; END;
CREATE TRIGGER bind_audit_expense_uuid AFTER UPDATE OF sync_uuid ON expenses WHEN OLD.sync_uuid IS NULL AND NEW.sync_uuid IS NOT NULL BEGIN UPDATE audit_logs SET entity_uuid=NEW.sync_uuid WHERE entity_type='expense' AND entity_id=NEW.id AND entity_uuid IS NULL; END;
CREATE TRIGGER bind_audit_person_uuid AFTER UPDATE OF sync_uuid ON people WHEN OLD.sync_uuid IS NULL AND NEW.sync_uuid IS NOT NULL BEGIN UPDATE audit_logs SET entity_uuid=NEW.sync_uuid WHERE entity_type='person' AND entity_id=NEW.id AND entity_uuid IS NULL; END;
CREATE TRIGGER bind_audit_assignment_uuid AFTER UPDATE OF sync_uuid ON project_assignments WHEN OLD.sync_uuid IS NULL AND NEW.sync_uuid IS NOT NULL BEGIN UPDATE audit_logs SET entity_uuid=NEW.sync_uuid WHERE entity_type='project_assignment' AND entity_id=NEW.id AND entity_uuid IS NULL; END;
CREATE TRIGGER bind_audit_person_payment_uuid AFTER UPDATE OF sync_uuid ON person_payments WHEN OLD.sync_uuid IS NULL AND NEW.sync_uuid IS NOT NULL BEGIN UPDATE audit_logs SET entity_uuid=NEW.sync_uuid WHERE entity_type='person_payment' AND entity_id=NEW.id AND entity_uuid IS NULL; END;
CREATE TRIGGER bind_audit_recurring_uuid AFTER UPDATE OF sync_uuid ON recurring_expenses WHEN OLD.sync_uuid IS NULL AND NEW.sync_uuid IS NOT NULL BEGIN UPDATE audit_logs SET entity_uuid=NEW.sync_uuid WHERE entity_type='recurring_expense' AND entity_id=NEW.id AND entity_uuid IS NULL; END;
CREATE TRIGGER bind_audit_time_uuid AFTER UPDATE OF sync_uuid ON time_entries WHEN OLD.sync_uuid IS NULL AND NEW.sync_uuid IS NOT NULL BEGIN UPDATE audit_logs SET entity_uuid=NEW.sync_uuid WHERE entity_type='time_entry' AND entity_id=NEW.id AND entity_uuid IS NULL; END;
CREATE TRIGGER bind_audit_category_uuid AFTER UPDATE OF sync_uuid ON expense_categories WHEN OLD.sync_uuid IS NULL AND NEW.sync_uuid IS NOT NULL BEGIN UPDATE audit_logs SET entity_uuid=NEW.sync_uuid WHERE entity_type='expense_category' AND entity_id=NEW.id AND entity_uuid IS NULL; END;

DROP TRIGGER audit_contract_insert;
DROP TRIGGER audit_contract_update;
CREATE TRIGGER audit_contract_insert AFTER INSERT ON contracts BEGIN
 INSERT INTO audit_logs(user_id,device_id,action,entity_type,entity_id,entity_uuid,after_json)
 VALUES((SELECT value FROM settings WHERE key='sync_email'),(SELECT value FROM settings WHERE key='device_id'),'CREATE','contract',NEW.id,NEW.sync_uuid,
 json_object('projectId',NEW.project_id,'number',NEW.number,'title',NEW.title,'valueMinor',NEW.value_minor,'vatBp',NEW.vat_bp,'retentionBp',NEW.retention_bp,'withholdingBp',NEW.withholding_bp,'advanceMinor',NEW.advance_minor,'advanceRecoveryMethod',NEW.advance_recovery_method,'performanceBondBp',NEW.performance_bond_bp,'performanceBondExpiry',NEW.performance_bond_expiry,'paymentTermsDays',NEW.payment_terms_days,'valuationMode',NEW.valuation_mode,'milestones',CASE WHEN json_valid(NEW.milestones) THEN json(NEW.milestones) ELSE NEW.milestones END,'drawings',CASE WHEN json_valid(NEW.drawings) THEN json(NEW.drawings) ELSE NEW.drawings END,'signedDate',NEW.signed_date,'sensitiveFields','[REDACTED]'));
END;
CREATE TRIGGER audit_contract_update AFTER UPDATE ON contracts
WHEN NEW.project_id IS NOT OLD.project_id OR NEW.number IS NOT OLD.number OR NEW.title IS NOT OLD.title OR
 NEW.value_minor IS NOT OLD.value_minor OR NEW.vat_bp IS NOT OLD.vat_bp OR NEW.retention_bp IS NOT OLD.retention_bp OR
 NEW.withholding_bp IS NOT OLD.withholding_bp OR NEW.advance_minor IS NOT OLD.advance_minor OR
 NEW.advance_recovery_method IS NOT OLD.advance_recovery_method OR NEW.performance_bond_bp IS NOT OLD.performance_bond_bp OR
 NEW.performance_bond_bank IS NOT OLD.performance_bond_bank OR NEW.performance_bond_expiry IS NOT OLD.performance_bond_expiry OR
 NEW.payment_terms_days IS NOT OLD.payment_terms_days OR NEW.payment_terms_notes IS NOT OLD.payment_terms_notes OR
 NEW.valuation_mode IS NOT OLD.valuation_mode OR NEW.milestones IS NOT OLD.milestones OR NEW.drawings IS NOT OLD.drawings OR
 NEW.attachments IS NOT OLD.attachments OR NEW.signed_date IS NOT OLD.signed_date OR NEW.notes IS NOT OLD.notes OR
 NEW.archived_at IS NOT OLD.archived_at
BEGIN
 INSERT INTO audit_logs(user_id,device_id,action,entity_type,entity_id,entity_uuid,before_json,after_json,reason)
 VALUES((SELECT value FROM settings WHERE key='sync_email'),(SELECT value FROM settings WHERE key='device_id'),
 CASE WHEN OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL THEN 'ARCHIVE' WHEN OLD.archived_at IS NOT NULL AND NEW.archived_at IS NULL THEN 'RESTORE' ELSE 'UPDATE' END,
 'contract',NEW.id,COALESCE(NEW.sync_uuid,OLD.sync_uuid),
 json_object('projectId',OLD.project_id,'number',OLD.number,'title',OLD.title,'valueMinor',OLD.value_minor,'vatBp',OLD.vat_bp,'retentionBp',OLD.retention_bp,'withholdingBp',OLD.withholding_bp,'advanceMinor',OLD.advance_minor,'advanceRecoveryMethod',OLD.advance_recovery_method,'performanceBondBp',OLD.performance_bond_bp,'performanceBondExpiry',OLD.performance_bond_expiry,'paymentTermsDays',OLD.payment_terms_days,'valuationMode',OLD.valuation_mode,'milestones',CASE WHEN json_valid(OLD.milestones) THEN json(OLD.milestones) ELSE OLD.milestones END,'drawings',CASE WHEN json_valid(OLD.drawings) THEN json(OLD.drawings) ELSE OLD.drawings END,'signedDate',OLD.signed_date,'archivedAt',OLD.archived_at,'sensitiveFields','[REDACTED]'),
 json_object('projectId',NEW.project_id,'number',NEW.number,'title',NEW.title,'valueMinor',NEW.value_minor,'vatBp',NEW.vat_bp,'retentionBp',NEW.retention_bp,'withholdingBp',NEW.withholding_bp,'advanceMinor',NEW.advance_minor,'advanceRecoveryMethod',NEW.advance_recovery_method,'performanceBondBp',NEW.performance_bond_bp,'performanceBondExpiry',NEW.performance_bond_expiry,'paymentTermsDays',NEW.payment_terms_days,'valuationMode',NEW.valuation_mode,'milestones',CASE WHEN json_valid(NEW.milestones) THEN json(NEW.milestones) ELSE NEW.milestones END,'drawings',CASE WHEN json_valid(NEW.drawings) THEN json(NEW.drawings) ELSE NEW.drawings END,'signedDate',NEW.signed_date,'archivedAt',NEW.archived_at,'sensitiveFields','[REDACTED]'),
 COALESCE(NEW.archive_reason,OLD.archive_reason));
END;

DROP TRIGGER audit_certificate_insert;
DROP TRIGGER audit_certificate_update;
CREATE TRIGGER audit_certificate_insert AFTER INSERT ON payment_certificates BEGIN
 INSERT INTO audit_logs(user_id,device_id,action,entity_type,entity_id,entity_uuid,after_json)
 VALUES((SELECT value FROM settings WHERE key='sync_email'),(SELECT value FROM settings WHERE key='device_id'),'CREATE','payment_certificate',NEW.id,NEW.sync_uuid,
 json_object('contractId',NEW.contract_id,'seq',NEW.seq,'number',NEW.number,'date',NEW.date,'submissionDate',NEW.submission_date,'dueDateOverride',NEW.due_date_override,'grossMinor',NEW.gross_minor,'discountMinor',NEW.discount_minor,'manualAdvanceRecoveryMinor',NEW.manual_advance_recovery_minor,'status',NEW.status,'contractRevisionId',NEW.contract_revision_id,'description','[REDACTED]'));
END;
CREATE TRIGGER audit_certificate_update AFTER UPDATE ON payment_certificates
WHEN NEW.contract_id IS NOT OLD.contract_id OR NEW.seq IS NOT OLD.seq OR NEW.number IS NOT OLD.number OR
 NEW.date IS NOT OLD.date OR NEW.submission_date IS NOT OLD.submission_date OR NEW.due_date_override IS NOT OLD.due_date_override OR
 NEW.description IS NOT OLD.description OR NEW.gross_minor IS NOT OLD.gross_minor OR NEW.discount_minor IS NOT OLD.discount_minor OR
 NEW.manual_advance_recovery_minor IS NOT OLD.manual_advance_recovery_minor OR NEW.status IS NOT OLD.status OR
 NEW.contract_revision_id IS NOT OLD.contract_revision_id OR NEW.contract_value_minor_snapshot IS NOT OLD.contract_value_minor_snapshot OR
 NEW.vat_bp_snapshot IS NOT OLD.vat_bp_snapshot OR NEW.retention_bp_snapshot IS NOT OLD.retention_bp_snapshot OR
 NEW.withholding_bp_snapshot IS NOT OLD.withholding_bp_snapshot OR NEW.advance_minor_snapshot IS NOT OLD.advance_minor_snapshot OR
 NEW.advance_method_snapshot IS NOT OLD.advance_method_snapshot OR NEW.payment_terms_days_snapshot IS NOT OLD.payment_terms_days_snapshot OR
 NEW.currency_snapshot IS NOT OLD.currency_snapshot OR NEW.fx_rate_micro_snapshot IS NOT OLD.fx_rate_micro_snapshot OR
 NEW.archived_at IS NOT OLD.archived_at OR NEW.voided_at IS NOT OLD.voided_at
BEGIN
 INSERT INTO audit_logs(user_id,device_id,action,entity_type,entity_id,entity_uuid,before_json,after_json,reason)
 VALUES((SELECT value FROM settings WHERE key='sync_email'),(SELECT value FROM settings WHERE key='device_id'),
 CASE WHEN OLD.voided_at IS NULL AND NEW.voided_at IS NOT NULL THEN 'VOID' WHEN OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL THEN 'ARCHIVE' WHEN OLD.archived_at IS NOT NULL AND NEW.archived_at IS NULL THEN 'RESTORE' WHEN NEW.status IS NOT OLD.status THEN 'STATUS_CHANGE' ELSE 'UPDATE' END,
 'payment_certificate',NEW.id,COALESCE(NEW.sync_uuid,OLD.sync_uuid),
 json_object('contractId',OLD.contract_id,'seq',OLD.seq,'number',OLD.number,'date',OLD.date,'submissionDate',OLD.submission_date,'dueDateOverride',OLD.due_date_override,'grossMinor',OLD.gross_minor,'discountMinor',OLD.discount_minor,'manualAdvanceRecoveryMinor',OLD.manual_advance_recovery_minor,'status',OLD.status,'contractRevisionId',OLD.contract_revision_id,'contractValueMinorSnapshot',OLD.contract_value_minor_snapshot,'vatBpSnapshot',OLD.vat_bp_snapshot,'retentionBpSnapshot',OLD.retention_bp_snapshot,'withholdingBpSnapshot',OLD.withholding_bp_snapshot,'advanceMinorSnapshot',OLD.advance_minor_snapshot,'advanceMethodSnapshot',OLD.advance_method_snapshot,'paymentTermsDaysSnapshot',OLD.payment_terms_days_snapshot,'currencySnapshot',OLD.currency_snapshot,'fxRateMicroSnapshot',OLD.fx_rate_micro_snapshot,'archivedAt',OLD.archived_at,'voidedAt',OLD.voided_at,'description','[REDACTED]'),
 json_object('contractId',NEW.contract_id,'seq',NEW.seq,'number',NEW.number,'date',NEW.date,'submissionDate',NEW.submission_date,'dueDateOverride',NEW.due_date_override,'grossMinor',NEW.gross_minor,'discountMinor',NEW.discount_minor,'manualAdvanceRecoveryMinor',NEW.manual_advance_recovery_minor,'status',NEW.status,'contractRevisionId',NEW.contract_revision_id,'contractValueMinorSnapshot',NEW.contract_value_minor_snapshot,'vatBpSnapshot',NEW.vat_bp_snapshot,'retentionBpSnapshot',NEW.retention_bp_snapshot,'withholdingBpSnapshot',NEW.withholding_bp_snapshot,'advanceMinorSnapshot',NEW.advance_minor_snapshot,'advanceMethodSnapshot',NEW.advance_method_snapshot,'paymentTermsDaysSnapshot',NEW.payment_terms_days_snapshot,'currencySnapshot',NEW.currency_snapshot,'fxRateMicroSnapshot',NEW.fx_rate_micro_snapshot,'archivedAt',NEW.archived_at,'voidedAt',NEW.voided_at,'description','[REDACTED]'),
 COALESCE(NEW.void_reason,NEW.archive_reason,OLD.void_reason,OLD.archive_reason));
END;

CREATE TRIGGER audit_contract_revision_update AFTER UPDATE ON contract_revisions
WHEN NEW.contract_id IS NOT OLD.contract_id OR NEW.revision_number IS NOT OLD.revision_number OR NEW.effective_date IS NOT OLD.effective_date OR
 NEW.contract_value_minor IS NOT OLD.contract_value_minor OR NEW.vat_bp IS NOT OLD.vat_bp OR NEW.retention_bp IS NOT OLD.retention_bp OR
 NEW.withholding_bp IS NOT OLD.withholding_bp OR NEW.advance_minor IS NOT OLD.advance_minor OR NEW.advance_recovery_method IS NOT OLD.advance_recovery_method OR
 NEW.payment_terms_days IS NOT OLD.payment_terms_days OR NEW.currency IS NOT OLD.currency OR NEW.fx_rate_micro IS NOT OLD.fx_rate_micro OR
 NEW.reason IS NOT OLD.reason OR NEW.approved_at IS NOT OLD.approved_at
BEGIN
 INSERT INTO audit_logs(user_id,device_id,action,entity_type,entity_id,entity_uuid,before_json,after_json,reason)
 VALUES((SELECT value FROM settings WHERE key='sync_email'),(SELECT value FROM settings WHERE key='device_id'),'REVISION_UPDATE','contract_revision',NEW.id,COALESCE(NEW.sync_uuid,OLD.sync_uuid),
 json_object('contractId',OLD.contract_id,'revisionNumber',OLD.revision_number,'effectiveDate',OLD.effective_date,'contractValueMinor',OLD.contract_value_minor,'vatBp',OLD.vat_bp,'retentionBp',OLD.retention_bp,'withholdingBp',OLD.withholding_bp,'advanceMinor',OLD.advance_minor,'advanceRecoveryMethod',OLD.advance_recovery_method,'paymentTermsDays',OLD.payment_terms_days,'currency',OLD.currency,'fxRateMicro',OLD.fx_rate_micro,'approvedAt',OLD.approved_at),
 json_object('contractId',NEW.contract_id,'revisionNumber',NEW.revision_number,'effectiveDate',NEW.effective_date,'contractValueMinor',NEW.contract_value_minor,'vatBp',NEW.vat_bp,'retentionBp',NEW.retention_bp,'withholdingBp',NEW.withholding_bp,'advanceMinor',NEW.advance_minor,'advanceRecoveryMethod',NEW.advance_recovery_method,'paymentTermsDays',NEW.payment_terms_days,'currency',NEW.currency,'fxRateMicro',NEW.fx_rate_micro,'approvedAt',NEW.approved_at),NEW.reason);
END;
CREATE TRIGGER audit_variation_update AFTER UPDATE ON variation_orders
WHEN NEW.contract_id IS NOT OLD.contract_id OR NEW.revision_id IS NOT OLD.revision_id OR NEW.number IS NOT OLD.number OR
 NEW.description IS NOT OLD.description OR NEW.value_delta_minor IS NOT OLD.value_delta_minor OR NEW.approved_at IS NOT OLD.approved_at
BEGIN
 INSERT INTO audit_logs(user_id,device_id,action,entity_type,entity_id,entity_uuid,before_json,after_json)
 VALUES((SELECT value FROM settings WHERE key='sync_email'),(SELECT value FROM settings WHERE key='device_id'),'UPDATE','variation_order',NEW.id,COALESCE(NEW.sync_uuid,OLD.sync_uuid),
 json_object('contractId',OLD.contract_id,'revisionId',OLD.revision_id,'number',OLD.number,'valueDeltaMinor',OLD.value_delta_minor,'approvedAt',OLD.approved_at,'description','[REDACTED]'),
 json_object('contractId',NEW.contract_id,'revisionId',NEW.revision_id,'number',NEW.number,'valueDeltaMinor',NEW.value_delta_minor,'approvedAt',NEW.approved_at,'description','[REDACTED]'));
END;
