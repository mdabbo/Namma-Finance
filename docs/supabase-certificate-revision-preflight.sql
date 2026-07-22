-- Read-only audit for legacy cloud contracts/certificates created before
-- immutable contract revisions were introduced. This query changes no data.

WITH certificate_issues AS (
  SELECT
    certificate.uuid,
    certificate.number,
    certificate.status,
    certificate.contract_id,
    contract.number AS contract_number,
    certificate.contract_revision_id,
    (certificate.contract_revision_id IS NULL) AS revision_missing,
    (
      certificate.contract_value_minor_snapshot IS NULL OR
      certificate.vat_bp_snapshot IS NULL OR
      certificate.retention_bp_snapshot IS NULL OR
      certificate.withholding_bp_snapshot IS NULL OR
      certificate.advance_minor_snapshot IS NULL OR
      certificate.advance_method_snapshot IS NULL OR
      certificate.payment_terms_days_snapshot IS NULL OR
      certificate.currency_snapshot IS NULL OR
      certificate.fx_rate_micro_snapshot IS NULL
    ) AS snapshot_missing,
    (revision.uuid IS NULL AND certificate.contract_revision_id IS NOT NULL) AS revision_not_found,
    (
      revision.uuid IS NOT NULL AND (
        revision.contract_id IS DISTINCT FROM certificate.contract_id OR
        revision.approved_at IS NULL OR
        revision.contract_value_minor IS DISTINCT FROM certificate.contract_value_minor_snapshot OR
        revision.vat_bp IS DISTINCT FROM certificate.vat_bp_snapshot OR
        revision.retention_bp IS DISTINCT FROM certificate.retention_bp_snapshot OR
        revision.withholding_bp IS DISTINCT FROM certificate.withholding_bp_snapshot OR
        revision.advance_minor IS DISTINCT FROM certificate.advance_minor_snapshot OR
        revision.advance_recovery_method IS DISTINCT FROM certificate.advance_method_snapshot OR
        revision.payment_terms_days IS DISTINCT FROM certificate.payment_terms_days_snapshot OR
        revision.currency IS DISTINCT FROM certificate.currency_snapshot OR
        revision.fx_rate_micro IS DISTINCT FROM certificate.fx_rate_micro_snapshot
      )
    ) AS snapshot_mismatch
  FROM public.payment_certificates AS certificate
  JOIN public.contracts AS contract ON contract.uuid = certificate.contract_id
  LEFT JOIN public.contract_revisions AS revision
    ON revision.uuid = certificate.contract_revision_id
  WHERE certificate.deleted_at IS NULL
    AND certificate.status IN ('SUBMITTED', 'APPROVED', 'PAID')
),
contract_counts AS (
  SELECT
    count(*) AS contracts,
    count(*) FILTER (
      WHERE NOT EXISTS (
        SELECT 1
        FROM public.contract_revisions AS revision
        WHERE revision.contract_id = contract.uuid
          AND revision.approved_at IS NOT NULL
          AND revision.deleted_at IS NULL
      )
    ) AS contracts_without_approved_revision
  FROM public.contracts AS contract
  WHERE contract.deleted_at IS NULL
)
SELECT jsonb_build_object(
  'contracts', contract_counts.contracts,
  'contracts_without_approved_revision', contract_counts.contracts_without_approved_revision,
  'submitted_certificates', (SELECT count(*) FROM certificate_issues),
  'submitted_without_revision', (
    SELECT count(*) FROM certificate_issues WHERE revision_missing
  ),
  'submitted_missing_snapshot', (
    SELECT count(*) FROM certificate_issues WHERE snapshot_missing
  ),
  'submitted_revision_not_found', (
    SELECT count(*) FROM certificate_issues WHERE revision_not_found
  ),
  'submitted_snapshot_mismatch', (
    SELECT count(*) FROM certificate_issues WHERE snapshot_mismatch
  ),
  'affected_certificates', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'uuid', uuid,
      'number', number,
      'contract_number', contract_number,
      'status', status,
      'revision_missing', revision_missing,
      'snapshot_missing', snapshot_missing,
      'revision_not_found', revision_not_found,
      'snapshot_mismatch', snapshot_mismatch
    ) ORDER BY contract_number, number)
    FROM certificate_issues
    WHERE revision_missing OR snapshot_missing OR revision_not_found OR snapshot_mismatch
  ), '[]'::jsonb)
) AS namaa_revision_audit
FROM contract_counts;
