-- Milestone 8: immutable, transaction-coupled financial audit trail.
-- JSON projections exclude credentials, bank details, paths and free-form notes.
INSERT OR IGNORE INTO settings(key,value) VALUES ('device_id',lower(hex(randomblob(16))));

CREATE TABLE audit_logs(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 timestamp TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 user_id TEXT, device_id TEXT NOT NULL, action TEXT NOT NULL,
 entity_type TEXT NOT NULL, entity_id INTEGER, entity_uuid TEXT,
 before_json TEXT, after_json TEXT, reason TEXT,
 source TEXT NOT NULL DEFAULT 'DESKTOP', application_version TEXT NOT NULL DEFAULT '0.6.0'
);
CREATE INDEX idx_audit_timestamp ON audit_logs(timestamp DESC);
CREATE INDEX idx_audit_entity ON audit_logs(entity_type,entity_id,timestamp DESC);
CREATE INDEX idx_audit_user ON audit_logs(user_id,timestamp DESC);
CREATE INDEX idx_audit_action ON audit_logs(action,timestamp DESC);
CREATE TRIGGER prevent_audit_update BEFORE UPDATE ON audit_logs BEGIN SELECT RAISE(ABORT,'AUDIT_LOG_IMMUTABLE'); END;
CREATE TRIGGER prevent_audit_delete BEFORE DELETE ON audit_logs BEGIN SELECT RAISE(ABORT,'AUDIT_LOG_IMMUTABLE'); END;

CREATE TRIGGER audit_contract_insert AFTER INSERT ON contracts BEGIN
 INSERT INTO audit_logs(user_id,device_id,action,entity_type,entity_id,entity_uuid,after_json)
 VALUES((SELECT value FROM settings WHERE key='sync_email'),(SELECT value FROM settings WHERE key='device_id'),'CREATE','contract',NEW.id,NEW.sync_uuid,json_object('projectId',NEW.project_id,'number',NEW.number,'title',NEW.title,'valueMinor',NEW.value_minor,'vatBp',NEW.vat_bp,'retentionBp',NEW.retention_bp,'withholdingBp',NEW.withholding_bp,'advanceMinor',NEW.advance_minor,'advanceRecoveryMethod',NEW.advance_recovery_method,'paymentTermsDays',NEW.payment_terms_days));
END;
CREATE TRIGGER audit_contract_update AFTER UPDATE ON contracts
WHEN NEW.project_id IS NOT OLD.project_id OR NEW.number IS NOT OLD.number OR NEW.title IS NOT OLD.title OR NEW.value_minor IS NOT OLD.value_minor OR NEW.vat_bp IS NOT OLD.vat_bp OR NEW.retention_bp IS NOT OLD.retention_bp OR NEW.withholding_bp IS NOT OLD.withholding_bp OR NEW.advance_minor IS NOT OLD.advance_minor OR NEW.advance_recovery_method IS NOT OLD.advance_recovery_method OR NEW.payment_terms_days IS NOT OLD.payment_terms_days OR NEW.valuation_mode IS NOT OLD.valuation_mode OR NEW.milestones IS NOT OLD.milestones OR NEW.drawings IS NOT OLD.drawings OR NEW.archived_at IS NOT OLD.archived_at
BEGIN
 INSERT INTO audit_logs(user_id,device_id,action,entity_type,entity_id,entity_uuid,before_json,after_json,reason)
 VALUES((SELECT value FROM settings WHERE key='sync_email'),(SELECT value FROM settings WHERE key='device_id'),CASE WHEN OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL THEN 'ARCHIVE' WHEN OLD.archived_at IS NOT NULL AND NEW.archived_at IS NULL THEN 'RESTORE' ELSE 'UPDATE' END,'contract',NEW.id,COALESCE(NEW.sync_uuid,OLD.sync_uuid),json_object('projectId',OLD.project_id,'number',OLD.number,'title',OLD.title,'valueMinor',OLD.value_minor,'vatBp',OLD.vat_bp,'retentionBp',OLD.retention_bp,'withholdingBp',OLD.withholding_bp,'advanceMinor',OLD.advance_minor,'advanceRecoveryMethod',OLD.advance_recovery_method,'paymentTermsDays',OLD.payment_terms_days,'archivedAt',OLD.archived_at),json_object('projectId',NEW.project_id,'number',NEW.number,'title',NEW.title,'valueMinor',NEW.value_minor,'vatBp',NEW.vat_bp,'retentionBp',NEW.retention_bp,'withholdingBp',NEW.withholding_bp,'advanceMinor',NEW.advance_minor,'advanceRecoveryMethod',NEW.advance_recovery_method,'paymentTermsDays',NEW.payment_terms_days,'archivedAt',NEW.archived_at),COALESCE(NEW.archive_reason,OLD.archive_reason));
END;
CREATE TRIGGER audit_contract_revision_insert AFTER INSERT ON contract_revisions BEGIN
 INSERT INTO audit_logs(user_id,device_id,action,entity_type,entity_id,entity_uuid,after_json,reason)
 VALUES((SELECT value FROM settings WHERE key='sync_email'),(SELECT value FROM settings WHERE key='device_id'),'REVISION_CREATE','contract_revision',NEW.id,NEW.sync_uuid,json_object('contractId',NEW.contract_id,'revisionNumber',NEW.revision_number,'effectiveDate',NEW.effective_date,'contractValueMinor',NEW.contract_value_minor,'vatBp',NEW.vat_bp,'retentionBp',NEW.retention_bp,'withholdingBp',NEW.withholding_bp,'advanceMinor',NEW.advance_minor,'advanceRecoveryMethod',NEW.advance_recovery_method,'paymentTermsDays',NEW.payment_terms_days,'currency',NEW.currency,'fxRateMicro',NEW.fx_rate_micro,'approvedAt',NEW.approved_at),NEW.reason);
END;

CREATE TRIGGER audit_certificate_insert AFTER INSERT ON payment_certificates BEGIN
 INSERT INTO audit_logs(user_id,device_id,action,entity_type,entity_id,entity_uuid,after_json)
 VALUES((SELECT value FROM settings WHERE key='sync_email'),(SELECT value FROM settings WHERE key='device_id'),'CREATE','payment_certificate',NEW.id,NEW.sync_uuid,json_object('contractId',NEW.contract_id,'seq',NEW.seq,'number',NEW.number,'date',NEW.date,'grossMinor',NEW.gross_minor,'discountMinor',NEW.discount_minor,'manualAdvanceRecoveryMinor',NEW.manual_advance_recovery_minor,'status',NEW.status,'contractRevisionId',NEW.contract_revision_id));
END;
CREATE TRIGGER audit_certificate_update AFTER UPDATE ON payment_certificates
WHEN NEW.contract_id IS NOT OLD.contract_id OR NEW.seq IS NOT OLD.seq OR NEW.number IS NOT OLD.number OR NEW.date IS NOT OLD.date OR NEW.gross_minor IS NOT OLD.gross_minor OR NEW.discount_minor IS NOT OLD.discount_minor OR NEW.manual_advance_recovery_minor IS NOT OLD.manual_advance_recovery_minor OR NEW.status IS NOT OLD.status OR NEW.contract_revision_id IS NOT OLD.contract_revision_id OR NEW.archived_at IS NOT OLD.archived_at OR NEW.voided_at IS NOT OLD.voided_at
BEGIN
 INSERT INTO audit_logs(user_id,device_id,action,entity_type,entity_id,entity_uuid,before_json,after_json,reason)
 VALUES((SELECT value FROM settings WHERE key='sync_email'),(SELECT value FROM settings WHERE key='device_id'),CASE WHEN OLD.voided_at IS NULL AND NEW.voided_at IS NOT NULL THEN 'VOID' WHEN OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL THEN 'ARCHIVE' WHEN OLD.archived_at IS NOT NULL AND NEW.archived_at IS NULL THEN 'RESTORE' WHEN NEW.status IS NOT OLD.status THEN 'STATUS_CHANGE' ELSE 'UPDATE' END,'payment_certificate',NEW.id,COALESCE(NEW.sync_uuid,OLD.sync_uuid),json_object('contractId',OLD.contract_id,'seq',OLD.seq,'number',OLD.number,'date',OLD.date,'grossMinor',OLD.gross_minor,'discountMinor',OLD.discount_minor,'manualAdvanceRecoveryMinor',OLD.manual_advance_recovery_minor,'status',OLD.status,'contractRevisionId',OLD.contract_revision_id,'archivedAt',OLD.archived_at,'voidedAt',OLD.voided_at),json_object('contractId',NEW.contract_id,'seq',NEW.seq,'number',NEW.number,'date',NEW.date,'grossMinor',NEW.gross_minor,'discountMinor',NEW.discount_minor,'manualAdvanceRecoveryMinor',NEW.manual_advance_recovery_minor,'status',NEW.status,'contractRevisionId',NEW.contract_revision_id,'archivedAt',NEW.archived_at,'voidedAt',NEW.voided_at),COALESCE(NEW.void_reason,NEW.archive_reason,OLD.void_reason,OLD.archive_reason));
END;

CREATE TRIGGER audit_payment_insert AFTER INSERT ON payments BEGIN
 INSERT INTO audit_logs(user_id,device_id,action,entity_type,entity_id,entity_uuid,after_json)
 VALUES((SELECT value FROM settings WHERE key='sync_email'),(SELECT value FROM settings WHERE key='device_id'),'CREATE','payment',NEW.id,NEW.sync_uuid,json_object('contractId',NEW.contract_id,'kind',NEW.kind,'number',NEW.number,'date',NEW.date,'amountMinor',NEW.amount_minor,'method',NEW.method,'sensitiveFields','[REDACTED]'));
END;
CREATE TRIGGER audit_payment_update AFTER UPDATE ON payments
WHEN NEW.contract_id IS NOT OLD.contract_id OR NEW.kind IS NOT OLD.kind OR NEW.number IS NOT OLD.number OR NEW.date IS NOT OLD.date OR NEW.amount_minor IS NOT OLD.amount_minor OR NEW.method IS NOT OLD.method OR NEW.bank IS NOT OLD.bank OR NEW.reference IS NOT OLD.reference OR NEW.notes IS NOT OLD.notes OR NEW.voided_at IS NOT OLD.voided_at
BEGIN
 INSERT INTO audit_logs(user_id,device_id,action,entity_type,entity_id,entity_uuid,before_json,after_json,reason)
 VALUES((SELECT value FROM settings WHERE key='sync_email'),(SELECT value FROM settings WHERE key='device_id'),CASE WHEN OLD.voided_at IS NULL AND NEW.voided_at IS NOT NULL THEN 'VOID' ELSE 'UPDATE' END,'payment',NEW.id,COALESCE(NEW.sync_uuid,OLD.sync_uuid),json_object('contractId',OLD.contract_id,'kind',OLD.kind,'number',OLD.number,'date',OLD.date,'amountMinor',OLD.amount_minor,'method',OLD.method,'voidedAt',OLD.voided_at,'sensitiveFields','[REDACTED]'),json_object('contractId',NEW.contract_id,'kind',NEW.kind,'number',NEW.number,'date',NEW.date,'amountMinor',NEW.amount_minor,'method',NEW.method,'voidedAt',NEW.voided_at,'sensitiveFields','[REDACTED]'),COALESCE(NEW.void_reason,OLD.void_reason));
END;
CREATE TRIGGER audit_allocation_insert AFTER INSERT ON payment_certificate_allocations BEGIN
 INSERT INTO audit_logs(user_id,device_id,action,entity_type,entity_id,entity_uuid,after_json)
 VALUES((SELECT value FROM settings WHERE key='sync_email'),(SELECT value FROM settings WHERE key='device_id'),'ALLOCATION_ADD','payment_allocation',NEW.id,NEW.sync_uuid,json_object('paymentId',NEW.payment_id,'certificateId',NEW.certificate_id,'amountMinor',NEW.amount_minor,'integrityException',NEW.integrity_exception));
END;
CREATE TRIGGER audit_allocation_update AFTER UPDATE ON payment_certificate_allocations
WHEN NEW.payment_id IS NOT OLD.payment_id OR NEW.certificate_id IS NOT OLD.certificate_id OR NEW.amount_minor IS NOT OLD.amount_minor
BEGIN
 INSERT INTO audit_logs(user_id,device_id,action,entity_type,entity_id,entity_uuid,before_json,after_json)
 VALUES((SELECT value FROM settings WHERE key='sync_email'),(SELECT value FROM settings WHERE key='device_id'),'ALLOCATION_UPDATE','payment_allocation',NEW.id,COALESCE(NEW.sync_uuid,OLD.sync_uuid),json_object('paymentId',OLD.payment_id,'certificateId',OLD.certificate_id,'amountMinor',OLD.amount_minor),json_object('paymentId',NEW.payment_id,'certificateId',NEW.certificate_id,'amountMinor',NEW.amount_minor));
END;
CREATE TRIGGER audit_allocation_delete BEFORE DELETE ON payment_certificate_allocations BEGIN
 INSERT INTO audit_logs(user_id,device_id,action,entity_type,entity_id,entity_uuid,before_json)
 VALUES((SELECT value FROM settings WHERE key='sync_email'),(SELECT value FROM settings WHERE key='device_id'),'ALLOCATION_REMOVE','payment_allocation',OLD.id,OLD.sync_uuid,json_object('paymentId',OLD.payment_id,'certificateId',OLD.certificate_id,'amountMinor',OLD.amount_minor,'integrityException',OLD.integrity_exception));
END;

CREATE TRIGGER audit_expense_insert AFTER INSERT ON expenses BEGIN
 INSERT INTO audit_logs(user_id,device_id,action,entity_type,entity_id,entity_uuid,after_json)
 VALUES((SELECT value FROM settings WHERE key='sync_email'),(SELECT value FROM settings WHERE key='device_id'),'CREATE','expense',NEW.id,NEW.sync_uuid,json_object('date',NEW.date,'categoryId',NEW.category_id,'projectId',NEW.project_id,'amountMinor',NEW.amount_minor,'currency',NEW.currency,'fxRateMicro',NEW.fx_rate_micro,'personPaymentId',NEW.person_payment_id));
END;
CREATE TRIGGER audit_expense_update AFTER UPDATE ON expenses
WHEN NEW.date IS NOT OLD.date OR NEW.category_id IS NOT OLD.category_id OR NEW.project_id IS NOT OLD.project_id OR NEW.amount_minor IS NOT OLD.amount_minor OR NEW.currency IS NOT OLD.currency OR NEW.fx_rate_micro IS NOT OLD.fx_rate_micro OR NEW.archived_at IS NOT OLD.archived_at OR NEW.voided_at IS NOT OLD.voided_at
BEGIN
 INSERT INTO audit_logs(user_id,device_id,action,entity_type,entity_id,entity_uuid,before_json,after_json,reason)
 VALUES((SELECT value FROM settings WHERE key='sync_email'),(SELECT value FROM settings WHERE key='device_id'),CASE WHEN OLD.voided_at IS NULL AND NEW.voided_at IS NOT NULL THEN 'VOID' WHEN OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL THEN 'ARCHIVE' WHEN OLD.archived_at IS NOT NULL AND NEW.archived_at IS NULL THEN 'RESTORE' ELSE 'UPDATE' END,'expense',NEW.id,COALESCE(NEW.sync_uuid,OLD.sync_uuid),json_object('date',OLD.date,'categoryId',OLD.category_id,'projectId',OLD.project_id,'amountMinor',OLD.amount_minor,'currency',OLD.currency,'fxRateMicro',OLD.fx_rate_micro,'archivedAt',OLD.archived_at,'voidedAt',OLD.voided_at),json_object('date',NEW.date,'categoryId',NEW.category_id,'projectId',NEW.project_id,'amountMinor',NEW.amount_minor,'currency',NEW.currency,'fxRateMicro',NEW.fx_rate_micro,'archivedAt',NEW.archived_at,'voidedAt',NEW.voided_at),COALESCE(NEW.void_reason,NEW.archive_reason,OLD.void_reason,OLD.archive_reason));
END;
CREATE TRIGGER audit_person_payment_insert AFTER INSERT ON person_payments BEGIN
 INSERT INTO audit_logs(user_id,device_id,action,entity_type,entity_id,entity_uuid,after_json)
 VALUES((SELECT value FROM settings WHERE key='sync_email'),(SELECT value FROM settings WHERE key='device_id'),'CREATE','person_payment',NEW.id,NEW.sync_uuid,json_object('assignmentId',NEW.assignment_id,'date',NEW.date,'amountMinor',NEW.amount_minor,'voidedAt',NEW.voided_at,'reversalOfId',NEW.reversal_of_id));
END;
CREATE TRIGGER audit_person_payment_update AFTER UPDATE ON person_payments
WHEN NEW.assignment_id IS NOT OLD.assignment_id OR NEW.date IS NOT OLD.date OR NEW.amount_minor IS NOT OLD.amount_minor OR NEW.voided_at IS NOT OLD.voided_at
BEGIN
 INSERT INTO audit_logs(user_id,device_id,action,entity_type,entity_id,entity_uuid,before_json,after_json,reason)
 VALUES((SELECT value FROM settings WHERE key='sync_email'),(SELECT value FROM settings WHERE key='device_id'),CASE WHEN OLD.voided_at IS NULL AND NEW.voided_at IS NOT NULL THEN 'VOID' ELSE 'UPDATE' END,'person_payment',NEW.id,COALESCE(NEW.sync_uuid,OLD.sync_uuid),json_object('assignmentId',OLD.assignment_id,'date',OLD.date,'amountMinor',OLD.amount_minor,'voidedAt',OLD.voided_at,'reversalOfId',OLD.reversal_of_id),json_object('assignmentId',NEW.assignment_id,'date',NEW.date,'amountMinor',NEW.amount_minor,'voidedAt',NEW.voided_at,'reversalOfId',NEW.reversal_of_id),COALESCE(NEW.void_reason,OLD.void_reason));
END;

CREATE TRIGGER audit_assignment_insert AFTER INSERT ON project_assignments BEGIN
 INSERT INTO audit_logs(user_id,device_id,action,entity_type,entity_id,entity_uuid,after_json)
 VALUES((SELECT value FROM settings WHERE key='sync_email'),(SELECT value FROM settings WHERE key='device_id'),'CREATE','project_assignment',NEW.id,NEW.sync_uuid,json_object('personId',NEW.person_id,'projectId',NEW.project_id,'agreedMinor',NEW.agreed_minor,'currency',NEW.currency,'fxRateMicro',NEW.fx_rate_micro));
END;
CREATE TRIGGER audit_assignment_update AFTER UPDATE ON project_assignments
WHEN NEW.person_id IS NOT OLD.person_id OR NEW.project_id IS NOT OLD.project_id OR NEW.agreed_minor IS NOT OLD.agreed_minor OR NEW.currency IS NOT OLD.currency OR NEW.fx_rate_micro IS NOT OLD.fx_rate_micro OR NEW.archived_at IS NOT OLD.archived_at
BEGIN
 INSERT INTO audit_logs(user_id,device_id,action,entity_type,entity_id,entity_uuid,before_json,after_json,reason)
 VALUES((SELECT value FROM settings WHERE key='sync_email'),(SELECT value FROM settings WHERE key='device_id'),CASE WHEN OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL THEN 'ARCHIVE' WHEN OLD.archived_at IS NOT NULL AND NEW.archived_at IS NULL THEN 'RESTORE' ELSE 'UPDATE' END,'project_assignment',NEW.id,COALESCE(NEW.sync_uuid,OLD.sync_uuid),json_object('personId',OLD.person_id,'projectId',OLD.project_id,'agreedMinor',OLD.agreed_minor,'currency',OLD.currency,'fxRateMicro',OLD.fx_rate_micro,'archivedAt',OLD.archived_at),json_object('personId',NEW.person_id,'projectId',NEW.project_id,'agreedMinor',NEW.agreed_minor,'currency',NEW.currency,'fxRateMicro',NEW.fx_rate_micro,'archivedAt',NEW.archived_at),COALESCE(NEW.archive_reason,OLD.archive_reason));
END;
CREATE TRIGGER audit_currency_update AFTER UPDATE ON currencies WHEN NEW.fx_rate_micro IS NOT OLD.fx_rate_micro BEGIN
 INSERT INTO audit_logs(user_id,device_id,action,entity_type,entity_uuid,before_json,after_json)
 VALUES((SELECT value FROM settings WHERE key='sync_email'),(SELECT value FROM settings WHERE key='device_id'),'RATE_CHANGE','currency',NEW.code,json_object('code',OLD.code,'fxRateMicro',OLD.fx_rate_micro),json_object('code',NEW.code,'fxRateMicro',NEW.fx_rate_micro));
END;
CREATE TRIGGER audit_financial_setting_insert AFTER INSERT ON settings WHEN NEW.key IN('base_currency','overhead_rule') BEGIN
 INSERT INTO audit_logs(user_id,device_id,action,entity_type,entity_uuid,after_json) VALUES((SELECT value FROM settings WHERE key='sync_email'),(SELECT value FROM settings WHERE key='device_id'),'SETTING_CHANGE','setting',NEW.key,json_object('key',NEW.key,'value',NEW.value));
END;
CREATE TRIGGER audit_financial_setting_update AFTER UPDATE ON settings WHEN NEW.key IN('base_currency','overhead_rule') AND NEW.value IS NOT OLD.value BEGIN
 INSERT INTO audit_logs(user_id,device_id,action,entity_type,entity_uuid,before_json,after_json) VALUES((SELECT value FROM settings WHERE key='sync_email'),(SELECT value FROM settings WHERE key='device_id'),'SETTING_CHANGE','setting',NEW.key,json_object('key',OLD.key,'value',OLD.value),json_object('key',NEW.key,'value',NEW.value));
END;
CREATE TRIGGER audit_backup_insert AFTER INSERT ON backups_log BEGIN
 INSERT INTO audit_logs(user_id,device_id,action,entity_type,entity_id,after_json,source) VALUES((SELECT value FROM settings WHERE key='sync_email'),(SELECT value FROM settings WHERE key='device_id'),'BACKUP','backup',NEW.id,json_object('kind',NEW.kind,'path','[REDACTED]'),CASE WHEN NEW.kind='AUTO' THEN 'BACKGROUND' ELSE 'DESKTOP' END);
END;

-- Additional financial inputs used by Milestone 6 cost and FX definitions.
CREATE TRIGGER audit_project_finance_update AFTER UPDATE ON projects
WHEN NEW.currency IS NOT OLD.currency OR NEW.fx_rate_micro IS NOT OLD.fx_rate_micro OR NEW.archived_at IS NOT OLD.archived_at
BEGIN
 INSERT INTO audit_logs(user_id,device_id,action,entity_type,entity_id,entity_uuid,before_json,after_json,reason)
 VALUES((SELECT value FROM settings WHERE key='sync_email'),(SELECT value FROM settings WHERE key='device_id'),CASE WHEN OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL THEN 'ARCHIVE' WHEN OLD.archived_at IS NOT NULL AND NEW.archived_at IS NULL THEN 'RESTORE' ELSE 'RATE_CHANGE' END,'project',NEW.id,COALESCE(NEW.sync_uuid,OLD.sync_uuid),json_object('currency',OLD.currency,'fxRateMicro',OLD.fx_rate_micro,'archivedAt',OLD.archived_at),json_object('currency',NEW.currency,'fxRateMicro',NEW.fx_rate_micro,'archivedAt',NEW.archived_at),COALESCE(NEW.archive_reason,OLD.archive_reason));
END;
CREATE TRIGGER audit_project_insert AFTER INSERT ON projects BEGIN
 INSERT INTO audit_logs(user_id,device_id,action,entity_type,entity_id,entity_uuid,after_json) VALUES((SELECT value FROM settings WHERE key='sync_email'),(SELECT value FROM settings WHERE key='device_id'),'CREATE','project',NEW.id,NEW.sync_uuid,json_object('code',NEW.code,'name',NEW.name,'clientId',NEW.client_id,'currency',NEW.currency,'fxRateMicro',NEW.fx_rate_micro,'status',NEW.status));
END;
CREATE TRIGGER audit_client_lifecycle AFTER UPDATE ON clients WHEN NEW.archived_at IS NOT OLD.archived_at BEGIN
 INSERT INTO audit_logs(user_id,device_id,action,entity_type,entity_id,entity_uuid,before_json,after_json,reason) VALUES((SELECT value FROM settings WHERE key='sync_email'),(SELECT value FROM settings WHERE key='device_id'),CASE WHEN OLD.archived_at IS NULL THEN 'ARCHIVE' ELSE 'RESTORE' END,'client',NEW.id,COALESCE(NEW.sync_uuid,OLD.sync_uuid),json_object('name',OLD.name,'archivedAt',OLD.archived_at,'sensitiveFields','[REDACTED]'),json_object('name',NEW.name,'archivedAt',NEW.archived_at,'sensitiveFields','[REDACTED]'),COALESCE(NEW.archive_reason,OLD.archive_reason));
END;
CREATE TRIGGER audit_person_finance_insert AFTER INSERT ON people BEGIN
 INSERT INTO audit_logs(user_id,device_id,action,entity_type,entity_id,entity_uuid,after_json)
 VALUES((SELECT value FROM settings WHERE key='sync_email'),(SELECT value FROM settings WHERE key='device_id'),'CREATE','person',NEW.id,NEW.sync_uuid,json_object('type',NEW.type,'name',NEW.name,'hourlyRateMinor',NEW.hourly_rate_minor,'monthlyRateMinor',NEW.monthly_rate_minor,'currency',NEW.currency,'bankAccount','[REDACTED]'));
END;
CREATE TRIGGER audit_person_finance_update AFTER UPDATE ON people
WHEN NEW.type IS NOT OLD.type OR NEW.name IS NOT OLD.name OR NEW.hourly_rate_minor IS NOT OLD.hourly_rate_minor OR NEW.monthly_rate_minor IS NOT OLD.monthly_rate_minor OR NEW.currency IS NOT OLD.currency OR NEW.bank_account IS NOT OLD.bank_account OR NEW.archived_at IS NOT OLD.archived_at
BEGIN
 INSERT INTO audit_logs(user_id,device_id,action,entity_type,entity_id,entity_uuid,before_json,after_json,reason)
 VALUES((SELECT value FROM settings WHERE key='sync_email'),(SELECT value FROM settings WHERE key='device_id'),CASE WHEN OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL THEN 'ARCHIVE' WHEN OLD.archived_at IS NOT NULL AND NEW.archived_at IS NULL THEN 'RESTORE' ELSE 'UPDATE' END,'person',NEW.id,COALESCE(NEW.sync_uuid,OLD.sync_uuid),json_object('type',OLD.type,'name',OLD.name,'hourlyRateMinor',OLD.hourly_rate_minor,'monthlyRateMinor',OLD.monthly_rate_minor,'currency',OLD.currency,'archivedAt',OLD.archived_at,'bankAccount','[REDACTED]'),json_object('type',NEW.type,'name',NEW.name,'hourlyRateMinor',NEW.hourly_rate_minor,'monthlyRateMinor',NEW.monthly_rate_minor,'currency',NEW.currency,'archivedAt',NEW.archived_at,'bankAccount','[REDACTED]'),COALESCE(NEW.archive_reason,OLD.archive_reason));
END;
CREATE TRIGGER audit_variation_insert AFTER INSERT ON variation_orders BEGIN
 INSERT INTO audit_logs(user_id,device_id,action,entity_type,entity_id,entity_uuid,after_json)
 VALUES((SELECT value FROM settings WHERE key='sync_email'),(SELECT value FROM settings WHERE key='device_id'),'CREATE','variation_order',NEW.id,NEW.sync_uuid,json_object('contractId',NEW.contract_id,'revisionId',NEW.revision_id,'number',NEW.number,'valueDeltaMinor',NEW.value_delta_minor,'approvedAt',NEW.approved_at));
END;
CREATE TRIGGER audit_recurring_insert AFTER INSERT ON recurring_expenses BEGIN
 INSERT INTO audit_logs(user_id,device_id,action,entity_type,entity_id,entity_uuid,after_json)
 VALUES((SELECT value FROM settings WHERE key='sync_email'),(SELECT value FROM settings WHERE key='device_id'),'CREATE','recurring_expense',NEW.id,NEW.sync_uuid,json_object('categoryId',NEW.category_id,'amountMinor',NEW.amount_minor,'currency',NEW.currency,'fxRateMicro',NEW.fx_rate_micro,'dayOfMonth',NEW.day_of_month,'isActive',NEW.is_active));
END;
CREATE TRIGGER audit_recurring_update AFTER UPDATE ON recurring_expenses
WHEN NEW.category_id IS NOT OLD.category_id OR NEW.amount_minor IS NOT OLD.amount_minor OR NEW.currency IS NOT OLD.currency OR NEW.fx_rate_micro IS NOT OLD.fx_rate_micro OR NEW.day_of_month IS NOT OLD.day_of_month OR NEW.is_active IS NOT OLD.is_active
BEGIN
 INSERT INTO audit_logs(user_id,device_id,action,entity_type,entity_id,entity_uuid,before_json,after_json) VALUES((SELECT value FROM settings WHERE key='sync_email'),(SELECT value FROM settings WHERE key='device_id'),'UPDATE','recurring_expense',NEW.id,COALESCE(NEW.sync_uuid,OLD.sync_uuid),json_object('categoryId',OLD.category_id,'amountMinor',OLD.amount_minor,'currency',OLD.currency,'fxRateMicro',OLD.fx_rate_micro,'dayOfMonth',OLD.day_of_month,'isActive',OLD.is_active),json_object('categoryId',NEW.category_id,'amountMinor',NEW.amount_minor,'currency',NEW.currency,'fxRateMicro',NEW.fx_rate_micro,'dayOfMonth',NEW.day_of_month,'isActive',NEW.is_active));
END;
CREATE TRIGGER audit_recurring_delete BEFORE DELETE ON recurring_expenses BEGIN
 INSERT INTO audit_logs(user_id,device_id,action,entity_type,entity_id,entity_uuid,before_json) VALUES((SELECT value FROM settings WHERE key='sync_email'),(SELECT value FROM settings WHERE key='device_id'),'DELETE','recurring_expense',OLD.id,OLD.sync_uuid,json_object('categoryId',OLD.category_id,'amountMinor',OLD.amount_minor,'currency',OLD.currency,'fxRateMicro',OLD.fx_rate_micro,'dayOfMonth',OLD.day_of_month,'isActive',OLD.is_active));
END;
CREATE TRIGGER audit_time_insert AFTER INSERT ON time_entries BEGIN
 INSERT INTO audit_logs(user_id,device_id,action,entity_type,entity_id,entity_uuid,after_json) VALUES((SELECT value FROM settings WHERE key='sync_email'),(SELECT value FROM settings WHERE key='device_id'),'CREATE','time_entry',NEW.id,NEW.sync_uuid,json_object('personId',NEW.person_id,'projectId',NEW.project_id,'stageId',NEW.stage_id,'date',NEW.date,'minutes',NEW.minutes,'billable',NEW.billable));
END;
CREATE TRIGGER audit_time_update AFTER UPDATE ON time_entries
WHEN NEW.person_id IS NOT OLD.person_id OR NEW.project_id IS NOT OLD.project_id OR NEW.stage_id IS NOT OLD.stage_id OR NEW.date IS NOT OLD.date OR NEW.minutes IS NOT OLD.minutes OR NEW.billable IS NOT OLD.billable
BEGIN
 INSERT INTO audit_logs(user_id,device_id,action,entity_type,entity_id,entity_uuid,before_json,after_json) VALUES((SELECT value FROM settings WHERE key='sync_email'),(SELECT value FROM settings WHERE key='device_id'),'UPDATE','time_entry',NEW.id,COALESCE(NEW.sync_uuid,OLD.sync_uuid),json_object('personId',OLD.person_id,'projectId',OLD.project_id,'stageId',OLD.stage_id,'date',OLD.date,'minutes',OLD.minutes,'billable',OLD.billable),json_object('personId',NEW.person_id,'projectId',NEW.project_id,'stageId',NEW.stage_id,'date',NEW.date,'minutes',NEW.minutes,'billable',NEW.billable));
END;
CREATE TRIGGER audit_time_delete BEFORE DELETE ON time_entries BEGIN
 INSERT INTO audit_logs(user_id,device_id,action,entity_type,entity_id,entity_uuid,before_json) VALUES((SELECT value FROM settings WHERE key='sync_email'),(SELECT value FROM settings WHERE key='device_id'),'DELETE','time_entry',OLD.id,OLD.sync_uuid,json_object('personId',OLD.person_id,'projectId',OLD.project_id,'stageId',OLD.stage_id,'date',OLD.date,'minutes',OLD.minutes,'billable',OLD.billable));
END;
CREATE TRIGGER audit_expense_category_insert AFTER INSERT ON expense_categories BEGIN
 INSERT INTO audit_logs(user_id,device_id,action,entity_type,entity_id,entity_uuid,after_json) VALUES((SELECT value FROM settings WHERE key='sync_email'),(SELECT value FROM settings WHERE key='device_id'),'CREATE','expense_category',NEW.id,NEW.sync_uuid,json_object('nameEn',NEW.name_en,'nameAr',NEW.name_ar,'isActive',NEW.is_active));
END;
CREATE TRIGGER audit_expense_category_update AFTER UPDATE ON expense_categories
WHEN NEW.name_en IS NOT OLD.name_en OR NEW.name_ar IS NOT OLD.name_ar OR NEW.is_active IS NOT OLD.is_active
BEGIN
 INSERT INTO audit_logs(user_id,device_id,action,entity_type,entity_id,entity_uuid,before_json,after_json) VALUES((SELECT value FROM settings WHERE key='sync_email'),(SELECT value FROM settings WHERE key='device_id'),'UPDATE','expense_category',NEW.id,COALESCE(NEW.sync_uuid,OLD.sync_uuid),json_object('nameEn',OLD.name_en,'nameAr',OLD.name_ar,'isActive',OLD.is_active),json_object('nameEn',NEW.name_en,'nameAr',NEW.name_ar,'isActive',NEW.is_active));
END;
CREATE TRIGGER audit_expense_category_delete BEFORE DELETE ON expense_categories BEGIN
 INSERT INTO audit_logs(user_id,device_id,action,entity_type,entity_id,entity_uuid,before_json) VALUES((SELECT value FROM settings WHERE key='sync_email'),(SELECT value FROM settings WHERE key='device_id'),'DELETE','expense_category',OLD.id,OLD.sync_uuid,json_object('nameEn',OLD.name_en,'nameAr',OLD.name_ar,'isActive',OLD.is_active));
END;
