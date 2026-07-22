-- Milestone 4 audit remediation: preserve approved terms and enforce as-of revision binding.
-- Forward-only: 0009 may already be installed and is intentionally left unchanged.

DROP TRIGGER IF EXISTS trg_certificates_bind_revision;

CREATE TRIGGER trg_certificates_bind_revision AFTER INSERT ON payment_certificates
WHEN NEW.contract_revision_id IS NULL
BEGIN
  UPDATE payment_certificates SET
    contract_revision_id=(SELECT id FROM contract_revisions r WHERE r.contract_id=NEW.contract_id AND r.approved_at IS NOT NULL AND (r.effective_date<=NEW.date OR r.revision_number=1) ORDER BY CASE WHEN r.effective_date<=NEW.date THEN 0 ELSE 1 END,r.effective_date DESC,r.revision_number DESC LIMIT 1),
    contract_value_minor_snapshot=(SELECT contract_value_minor FROM contract_revisions r WHERE r.contract_id=NEW.contract_id AND r.approved_at IS NOT NULL AND (r.effective_date<=NEW.date OR r.revision_number=1) ORDER BY CASE WHEN r.effective_date<=NEW.date THEN 0 ELSE 1 END,r.effective_date DESC,r.revision_number DESC LIMIT 1),
    vat_bp_snapshot=(SELECT vat_bp FROM contract_revisions r WHERE r.contract_id=NEW.contract_id AND r.approved_at IS NOT NULL AND (r.effective_date<=NEW.date OR r.revision_number=1) ORDER BY CASE WHEN r.effective_date<=NEW.date THEN 0 ELSE 1 END,r.effective_date DESC,r.revision_number DESC LIMIT 1),
    retention_bp_snapshot=(SELECT retention_bp FROM contract_revisions r WHERE r.contract_id=NEW.contract_id AND r.approved_at IS NOT NULL AND (r.effective_date<=NEW.date OR r.revision_number=1) ORDER BY CASE WHEN r.effective_date<=NEW.date THEN 0 ELSE 1 END,r.effective_date DESC,r.revision_number DESC LIMIT 1),
    withholding_bp_snapshot=(SELECT withholding_bp FROM contract_revisions r WHERE r.contract_id=NEW.contract_id AND r.approved_at IS NOT NULL AND (r.effective_date<=NEW.date OR r.revision_number=1) ORDER BY CASE WHEN r.effective_date<=NEW.date THEN 0 ELSE 1 END,r.effective_date DESC,r.revision_number DESC LIMIT 1),
    advance_minor_snapshot=(SELECT advance_minor FROM contract_revisions r WHERE r.contract_id=NEW.contract_id AND r.approved_at IS NOT NULL AND (r.effective_date<=NEW.date OR r.revision_number=1) ORDER BY CASE WHEN r.effective_date<=NEW.date THEN 0 ELSE 1 END,r.effective_date DESC,r.revision_number DESC LIMIT 1),
    advance_method_snapshot=(SELECT advance_recovery_method FROM contract_revisions r WHERE r.contract_id=NEW.contract_id AND r.approved_at IS NOT NULL AND (r.effective_date<=NEW.date OR r.revision_number=1) ORDER BY CASE WHEN r.effective_date<=NEW.date THEN 0 ELSE 1 END,r.effective_date DESC,r.revision_number DESC LIMIT 1),
    payment_terms_days_snapshot=(SELECT payment_terms_days FROM contract_revisions r WHERE r.contract_id=NEW.contract_id AND r.approved_at IS NOT NULL AND (r.effective_date<=NEW.date OR r.revision_number=1) ORDER BY CASE WHEN r.effective_date<=NEW.date THEN 0 ELSE 1 END,r.effective_date DESC,r.revision_number DESC LIMIT 1),
    currency_snapshot=(SELECT currency FROM contract_revisions r WHERE r.contract_id=NEW.contract_id AND r.approved_at IS NOT NULL AND (r.effective_date<=NEW.date OR r.revision_number=1) ORDER BY CASE WHEN r.effective_date<=NEW.date THEN 0 ELSE 1 END,r.effective_date DESC,r.revision_number DESC LIMIT 1),
    fx_rate_micro_snapshot=(SELECT fx_rate_micro FROM contract_revisions r WHERE r.contract_id=NEW.contract_id AND r.approved_at IS NOT NULL AND (r.effective_date<=NEW.date OR r.revision_number=1) ORDER BY CASE WHEN r.effective_date<=NEW.date THEN 0 ELSE 1 END,r.effective_date DESC,r.revision_number DESC LIMIT 1)
  WHERE id=NEW.id;
END;

CREATE TRIGGER prevent_approved_contract_revision_edit BEFORE UPDATE ON contract_revisions
WHEN OLD.approved_at IS NOT NULL AND (
  NEW.contract_id IS NOT OLD.contract_id OR NEW.revision_number IS NOT OLD.revision_number OR
  NEW.effective_date IS NOT OLD.effective_date OR NEW.contract_value_minor IS NOT OLD.contract_value_minor OR
  NEW.vat_bp IS NOT OLD.vat_bp OR NEW.retention_bp IS NOT OLD.retention_bp OR
  NEW.withholding_bp IS NOT OLD.withholding_bp OR NEW.advance_minor IS NOT OLD.advance_minor OR
  NEW.advance_recovery_method IS NOT OLD.advance_recovery_method OR
  NEW.payment_terms_days IS NOT OLD.payment_terms_days OR NEW.currency IS NOT OLD.currency OR
  NEW.fx_rate_micro IS NOT OLD.fx_rate_micro OR NEW.reason IS NOT OLD.reason OR
  NEW.created_at IS NOT OLD.created_at OR NEW.created_by IS NOT OLD.created_by OR
  NEW.approved_at IS NOT OLD.approved_at
)
BEGIN SELECT RAISE(ABORT, 'APPROVED_CONTRACT_REVISION_IMMUTABLE'); END;

CREATE TRIGGER prevent_approved_variation_order_edit BEFORE UPDATE ON variation_orders
WHEN OLD.approved_at IS NOT NULL AND (
  NEW.contract_id IS NOT OLD.contract_id OR NEW.revision_id IS NOT OLD.revision_id OR
  NEW.number IS NOT OLD.number OR NEW.description IS NOT OLD.description OR
  NEW.value_delta_minor IS NOT OLD.value_delta_minor OR NEW.approved_at IS NOT OLD.approved_at OR
  NEW.created_at IS NOT OLD.created_at OR NEW.created_by IS NOT OLD.created_by
)
BEGIN SELECT RAISE(ABORT, 'APPROVED_VARIATION_ORDER_IMMUTABLE'); END;

CREATE TRIGGER validate_submitted_certificate_revision_insert BEFORE INSERT ON payment_certificates
WHEN NEW.status IN ('SUBMITTED','APPROVED','PAID') AND NEW.contract_revision_id IS NOT NULL AND (
  NEW.contract_revision_id IS NULL OR NEW.contract_value_minor_snapshot IS NULL OR
  NEW.vat_bp_snapshot IS NULL OR NEW.retention_bp_snapshot IS NULL OR
  NEW.withholding_bp_snapshot IS NULL OR NEW.advance_minor_snapshot IS NULL OR
  NEW.advance_method_snapshot IS NULL OR NEW.payment_terms_days_snapshot IS NULL OR
  NEW.currency_snapshot IS NULL OR NEW.fx_rate_micro_snapshot IS NULL
)
BEGIN SELECT RAISE(ABORT, 'SUBMITTED_CERTIFICATE_REQUIRES_EFFECTIVE_REVISION'); END;

CREATE TRIGGER validate_submitted_certificate_snapshot_insert BEFORE INSERT ON payment_certificates
WHEN NEW.status IN ('SUBMITTED','APPROVED','PAID') AND NEW.contract_revision_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM contract_revisions r WHERE r.id=NEW.contract_revision_id AND r.contract_id=NEW.contract_id
    AND r.contract_value_minor=NEW.contract_value_minor_snapshot AND r.vat_bp=NEW.vat_bp_snapshot
    AND r.retention_bp=NEW.retention_bp_snapshot AND r.withholding_bp=NEW.withholding_bp_snapshot
    AND r.advance_minor=NEW.advance_minor_snapshot AND r.advance_recovery_method=NEW.advance_method_snapshot
    AND r.payment_terms_days=NEW.payment_terms_days_snapshot AND r.currency=NEW.currency_snapshot
    AND r.fx_rate_micro=NEW.fx_rate_micro_snapshot AND r.approved_at IS NOT NULL
)
BEGIN SELECT RAISE(ABORT, 'CERTIFICATE_SNAPSHOT_REVISION_MISMATCH'); END;

CREATE TRIGGER validate_submitted_certificate_revision_update BEFORE UPDATE ON payment_certificates
WHEN NEW.status IN ('SUBMITTED','APPROVED','PAID') AND (
  NEW.contract_revision_id IS NULL OR NEW.contract_value_minor_snapshot IS NULL OR
  NEW.vat_bp_snapshot IS NULL OR NEW.retention_bp_snapshot IS NULL OR
  NEW.withholding_bp_snapshot IS NULL OR NEW.advance_minor_snapshot IS NULL OR
  NEW.advance_method_snapshot IS NULL OR NEW.payment_terms_days_snapshot IS NULL OR
  NEW.currency_snapshot IS NULL OR NEW.fx_rate_micro_snapshot IS NULL
)
BEGIN SELECT RAISE(ABORT, 'SUBMITTED_CERTIFICATE_REQUIRES_EFFECTIVE_REVISION'); END;

CREATE TRIGGER validate_submitted_certificate_snapshot_update BEFORE UPDATE ON payment_certificates
WHEN NEW.status IN ('SUBMITTED','APPROVED','PAID') AND NEW.contract_revision_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM contract_revisions r WHERE r.id=NEW.contract_revision_id AND r.contract_id=NEW.contract_id
    AND r.contract_value_minor=NEW.contract_value_minor_snapshot AND r.vat_bp=NEW.vat_bp_snapshot
    AND r.retention_bp=NEW.retention_bp_snapshot AND r.withholding_bp=NEW.withholding_bp_snapshot
    AND r.advance_minor=NEW.advance_minor_snapshot AND r.advance_recovery_method=NEW.advance_method_snapshot
    AND r.payment_terms_days=NEW.payment_terms_days_snapshot AND r.currency=NEW.currency_snapshot
    AND r.fx_rate_micro=NEW.fx_rate_micro_snapshot AND r.approved_at IS NOT NULL
)
BEGIN SELECT RAISE(ABORT, 'CERTIFICATE_SNAPSHOT_REVISION_MISMATCH'); END;

CREATE TRIGGER prevent_submitted_certificate_snapshot_edit BEFORE UPDATE ON payment_certificates
WHEN OLD.status IN ('SUBMITTED','APPROVED','PAID') AND (
  NEW.contract_revision_id IS NOT OLD.contract_revision_id OR
  NEW.contract_value_minor_snapshot IS NOT OLD.contract_value_minor_snapshot OR
  NEW.vat_bp_snapshot IS NOT OLD.vat_bp_snapshot OR NEW.retention_bp_snapshot IS NOT OLD.retention_bp_snapshot OR
  NEW.withholding_bp_snapshot IS NOT OLD.withholding_bp_snapshot OR
  NEW.advance_minor_snapshot IS NOT OLD.advance_minor_snapshot OR
  NEW.advance_method_snapshot IS NOT OLD.advance_method_snapshot OR
  NEW.payment_terms_days_snapshot IS NOT OLD.payment_terms_days_snapshot OR
  NEW.currency_snapshot IS NOT OLD.currency_snapshot OR NEW.fx_rate_micro_snapshot IS NOT OLD.fx_rate_micro_snapshot
)
BEGIN SELECT RAISE(ABORT, 'SUBMITTED_CERTIFICATE_SNAPSHOT_IMMUTABLE'); END;
