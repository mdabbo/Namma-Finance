-- Milestone 5: database-level payment allocation invariants.
-- Existing financial rows are preserved; new and changed allocations are constrained.

-- Permit only the initial trigger-driven binding of an imported submitted row.
-- Once a revision is bound, Milestone 4 snapshots remain immutable.
DROP TRIGGER IF EXISTS prevent_submitted_certificate_snapshot_edit;
CREATE TRIGGER prevent_submitted_certificate_snapshot_edit BEFORE UPDATE ON payment_certificates
WHEN OLD.status IN ('SUBMITTED','APPROVED','PAID') AND OLD.contract_revision_id IS NOT NULL AND (
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

ALTER TABLE payment_certificate_allocations ADD COLUMN integrity_exception INTEGER NOT NULL DEFAULT 0
  CHECK (integrity_exception IN (0,1));

-- Preserve pre-existing duplicate rows exactly, while marking every row after
-- the oldest as a legacy exception for manual review. New exceptions cannot be created.
UPDATE payment_certificate_allocations AS a SET integrity_exception=1
WHERE EXISTS (
  SELECT 1 FROM payment_certificate_allocations older
  WHERE older.payment_id=a.payment_id AND older.certificate_id=a.certificate_id AND older.id<a.id
);

CREATE UNIQUE INDEX idx_allocations_payment_certificate_unique
  ON payment_certificate_allocations(payment_id, certificate_id)
  WHERE integrity_exception=0;

CREATE TRIGGER validate_allocation_insert BEFORE INSERT ON payment_certificate_allocations
BEGIN
  SELECT CASE WHEN NEW.integrity_exception<>0 THEN RAISE(ABORT, 'INTEGRITY_EXCEPTION_IS_MIGRATION_ONLY') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM payment_certificate_allocations a
    WHERE a.payment_id=NEW.payment_id AND a.certificate_id=NEW.certificate_id
  ) THEN RAISE(ABORT, 'DUPLICATE_CERTIFICATE_ALLOCATION') END;
  SELECT CASE WHEN NEW.amount_minor <= 0 THEN RAISE(ABORT, 'ALLOCATION_MUST_BE_POSITIVE') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM payments p WHERE p.id=NEW.payment_id AND p.deleted_at IS NULL
      AND p.voided_at IS NULL AND p.kind='CERTIFICATE'
  ) THEN RAISE(ABORT, 'ALLOCATION_REQUIRES_ACTIVE_CERTIFICATE_PAYMENT') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM payment_certificates c WHERE c.id=NEW.certificate_id
      AND c.deleted_at IS NULL AND c.voided_at IS NULL AND c.archived_at IS NULL
      AND c.status IN ('SUBMITTED','APPROVED','PAID')
  ) THEN RAISE(ABORT, 'ALLOCATION_REQUIRES_BILLABLE_CERTIFICATE') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM payments p JOIN payment_certificates c ON c.id=NEW.certificate_id
    WHERE p.id=NEW.payment_id AND p.contract_id=c.contract_id
  ) THEN RAISE(ABORT, 'ALLOCATION_CONTRACT_MISMATCH') END;
  SELECT CASE WHEN (
    COALESCE((SELECT SUM(a.amount_minor) FROM payment_certificate_allocations a WHERE a.payment_id=NEW.payment_id),0)
    + NEW.amount_minor
  ) > (SELECT amount_minor FROM payments WHERE id=NEW.payment_id)
  THEN RAISE(ABORT, 'ALLOCATIONS_EXCEED_PAYMENT') END;
END;

CREATE TRIGGER validate_allocation_update BEFORE UPDATE OF payment_id,certificate_id,amount_minor,integrity_exception ON payment_certificate_allocations
BEGIN
  SELECT CASE WHEN NEW.integrity_exception<>OLD.integrity_exception THEN RAISE(ABORT, 'INTEGRITY_EXCEPTION_IMMUTABLE') END;
  SELECT CASE WHEN (NEW.payment_id<>OLD.payment_id OR NEW.certificate_id<>OLD.certificate_id) AND EXISTS (
    SELECT 1 FROM payment_certificate_allocations a
    WHERE a.payment_id=NEW.payment_id AND a.certificate_id=NEW.certificate_id AND a.id<>OLD.id
  ) THEN RAISE(ABORT, 'DUPLICATE_CERTIFICATE_ALLOCATION') END;
  SELECT CASE WHEN NEW.amount_minor <= 0 THEN RAISE(ABORT, 'ALLOCATION_MUST_BE_POSITIVE') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM payments p WHERE p.id=NEW.payment_id AND p.deleted_at IS NULL
      AND p.voided_at IS NULL AND p.kind='CERTIFICATE'
  ) THEN RAISE(ABORT, 'ALLOCATION_REQUIRES_ACTIVE_CERTIFICATE_PAYMENT') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM payment_certificates c WHERE c.id=NEW.certificate_id
      AND c.deleted_at IS NULL AND c.voided_at IS NULL AND c.archived_at IS NULL
      AND c.status IN ('SUBMITTED','APPROVED','PAID')
  ) THEN RAISE(ABORT, 'ALLOCATION_REQUIRES_BILLABLE_CERTIFICATE') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM payments p JOIN payment_certificates c ON c.id=NEW.certificate_id
    WHERE p.id=NEW.payment_id AND p.contract_id=c.contract_id
  ) THEN RAISE(ABORT, 'ALLOCATION_CONTRACT_MISMATCH') END;
  SELECT CASE WHEN (
    COALESCE((SELECT SUM(a.amount_minor) FROM payment_certificate_allocations a WHERE a.payment_id=NEW.payment_id AND a.id<>OLD.id),0)
    + NEW.amount_minor
  ) > (SELECT amount_minor FROM payments WHERE id=NEW.payment_id)
  THEN RAISE(ABORT, 'ALLOCATIONS_EXCEED_PAYMENT') END;
END;

CREATE TRIGGER validate_payment_against_allocations BEFORE UPDATE OF amount_minor,kind ON payments
WHEN NEW.deleted_at IS NULL AND NEW.voided_at IS NULL
BEGIN
  SELECT CASE WHEN NEW.kind<>'CERTIFICATE' AND EXISTS (
    SELECT 1 FROM payment_certificate_allocations a WHERE a.payment_id=OLD.id
  ) THEN RAISE(ABORT, 'ALLOCATIONS_REQUIRE_CERTIFICATE_PAYMENT') END;
  SELECT CASE WHEN COALESCE((
    SELECT SUM(a.amount_minor) FROM payment_certificate_allocations a WHERE a.payment_id=OLD.id
  ),0) > NEW.amount_minor THEN RAISE(ABORT, 'ALLOCATIONS_EXCEED_PAYMENT') END;
END;
