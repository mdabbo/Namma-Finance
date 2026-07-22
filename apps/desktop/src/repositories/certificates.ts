import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CertificateInput, CertificateStatus, PaymentCertificate } from "@mep/core";
import { execute, select, selectOne } from "../lib/db";

export interface CertificateRow {
  id: number;
  contract_id: number;
  seq: number;
  number: string;
  date: string;
  submission_date: string | null;
  due_date_override: string | null;
  description: string | null;
  gross_minor: number;
  discount_minor: number;
  manual_advance_recovery_minor: number | null;
  contract_revision_id: number | null;
  contract_value_minor_snapshot: number | null;
  vat_bp_snapshot: number | null;
  retention_bp_snapshot: number | null;
  withholding_bp_snapshot: number | null;
  advance_minor_snapshot: number | null;
  advance_method_snapshot: PaymentCertificate["advanceMethodSnapshot"];
  payment_terms_days_snapshot: number | null;
  currency_snapshot: string | null;
  fx_rate_micro_snapshot: number | null;
  status: CertificateStatus;
  deleted_at: string | null;
  created_at: string;
  contract_number?: string;
  project_id?: number;
  project_name?: string;
  project_code?: string;
  currency?: string;
  client_name?: string;
}

export interface CertificateListItem extends PaymentCertificate {
  contractNumber: string;
  projectId: number;
  projectName: string;
  projectCode: string;
  currency: string;
  clientName: string;
}

export function mapCertificate(r: CertificateRow): CertificateListItem {
  return {
    id: r.id,
    contractId: r.contract_id,
    seq: r.seq,
    number: r.number,
    date: r.date,
    submissionDate: r.submission_date,
    dueDateOverride: r.due_date_override,
    description: r.description,
    grossMinor: r.gross_minor,
    discountMinor: r.discount_minor,
    manualAdvanceRecoveryMinor: r.manual_advance_recovery_minor,
    contractRevisionId: r.contract_revision_id,
    contractValueMinorSnapshot: r.contract_value_minor_snapshot,
    vatBpSnapshot: r.vat_bp_snapshot,
    retentionBpSnapshot: r.retention_bp_snapshot,
    withholdingBpSnapshot: r.withholding_bp_snapshot,
    advanceMinorSnapshot: r.advance_minor_snapshot,
    advanceMethodSnapshot: r.advance_method_snapshot,
    paymentTermsDaysSnapshot: r.payment_terms_days_snapshot,
    currencySnapshot: r.currency_snapshot,
    fxRateMicroSnapshot: r.fx_rate_micro_snapshot,
    status: r.status,
    deletedAt: r.deleted_at,
    createdAt: r.created_at,
    contractNumber: r.contract_number ?? "",
    projectId: r.project_id ?? 0,
    projectName: r.project_name ?? "",
    projectCode: r.project_code ?? "",
    currency: r.currency ?? "EGP",
    clientName: r.client_name ?? "",
  };
}

const LIST_SQL = `
  SELECT pc.*, ct.number AS contract_number, p.id AS project_id, p.name AS project_name,
         p.code AS project_code, COALESCE(pc.currency_snapshot,p.currency) AS currency, cl.name AS client_name
  FROM payment_certificates pc
  JOIN contracts ct ON ct.id = pc.contract_id
  JOIN projects p ON p.id = ct.project_id
  JOIN clients cl ON cl.id = p.client_id
  WHERE pc.deleted_at IS NULL AND pc.voided_at IS NULL AND pc.archived_at IS NULL`;

export async function listCertificates(): Promise<CertificateListItem[]> {
  const rows = await select<CertificateRow>(`${LIST_SQL} ORDER BY pc.date DESC, pc.id DESC`);
  return rows.map(mapCertificate);
}

export async function listCertificatesByContract(contractId: number): Promise<CertificateListItem[]> {
  const rows = await select<CertificateRow>(`${LIST_SQL} AND pc.contract_id = $1 ORDER BY pc.seq, pc.id`, [contractId]);
  return rows.map(mapCertificate);
}

export async function getCertificate(id: number): Promise<CertificateListItem | null> {
  const row = await selectOne<CertificateRow>(`${LIST_SQL} AND pc.id = $1`, [id]);
  return row ? mapCertificate(row) : null;
}

export async function nextCertificateSeq(contractId: number): Promise<number> {
  const row = await selectOne<{ max_seq: number | null }>(
    "SELECT MAX(seq) AS max_seq FROM payment_certificates WHERE contract_id = $1 AND deleted_at IS NULL",
    [contractId],
  );
  return (row?.max_seq ?? 0) + 1;
}

export async function createCertificate(seq: number, input: CertificateInput): Promise<number> {
  if (input.status === "PAID") throw new Error("PAID_REQUIRES_PAYMENT");
  const r = await execute(
    `INSERT INTO payment_certificates (contract_id, seq, number, date, submission_date, due_date_override,due_date_confirmed_at,
        description, gross_minor, discount_minor, manual_advance_recovery_minor, status,
        contract_revision_id,contract_value_minor_snapshot,vat_bp_snapshot,retention_bp_snapshot,
        withholding_bp_snapshot,advance_minor_snapshot,advance_method_snapshot,payment_terms_days_snapshot,
        currency_snapshot,fx_rate_micro_snapshot)
     SELECT $1,$2,$3,$4,$5,$6,CASE WHEN $7=1 THEN datetime('now') END,$8,$9,$10,$11,$12,
        r.id,r.contract_value_minor,r.vat_bp,r.retention_bp,r.withholding_bp,r.advance_minor,
        r.advance_recovery_method,r.payment_terms_days,r.currency,r.fx_rate_micro
     FROM contract_revisions r WHERE r.contract_id=$1 AND r.approved_at IS NOT NULL
       AND (r.effective_date <= $4 OR r.revision_number=1)
     ORDER BY CASE WHEN r.effective_date <= $4 THEN 0 ELSE 1 END, r.effective_date DESC, r.revision_number DESC LIMIT 1`,
    [input.contractId, seq, input.number, input.date, input.submissionDate ?? null,
     input.dueDateOverride ?? null, input.dueDateConfirmed ? 1 : 0, input.description ?? null, input.grossMinor, input.discountMinor,
     input.manualAdvanceRecoveryMinor ?? null, input.status],
  );
  if (r.rowsAffected !== 1) throw new Error("NO_APPROVED_CONTRACT_REVISION");
  return r.lastInsertId ?? 0;
}

export async function nextCertificateNumber(prefix = "CERT", date = new Date()): Promise<string> {
  const { reserveNextNumber } = await import("./numbering");
  return reserveNextNumber("CERTIFICATE", prefix, date);
}

export async function updateCertificate(id: number, input: CertificateInput): Promise<void> {
  if (input.status === "PAID") throw new Error("PAID_REQUIRES_PAYMENT");
  const previous = await selectOne<{ status: CertificateStatus }>("SELECT status FROM payment_certificates WHERE id=$1 AND deleted_at IS NULL", [id]);
  if (!previous) throw new Error("CERTIFICATE_NOT_FOUND");
  if (input.status === "DRAFT") await assertCertificateHasNoLiveAllocations(id);
  const refreshSnapshot = input.status === "DRAFT" || (previous.status === "DRAFT" && input.status === "SUBMITTED");
  const result = refreshSnapshot
    ? await execute(
      `WITH chosen AS (
         SELECT r.* FROM contract_revisions r
         WHERE r.contract_id=$1 AND r.approved_at IS NOT NULL
           AND (r.effective_date <= $3 OR r.revision_number=1)
         ORDER BY CASE WHEN r.effective_date <= $3 THEN 0 ELSE 1 END, r.effective_date DESC, r.revision_number DESC LIMIT 1
       )
       UPDATE payment_certificates SET number=$2, date=$3, submission_date=$4, due_date_override=$5,
         due_date_confirmed_at=CASE WHEN $6=1 THEN datetime('now') END,
         description=$7, gross_minor=$8, discount_minor=$9, manual_advance_recovery_minor=$10, status=$11,
         contract_revision_id=(SELECT id FROM chosen), contract_value_minor_snapshot=(SELECT contract_value_minor FROM chosen),
         vat_bp_snapshot=(SELECT vat_bp FROM chosen), retention_bp_snapshot=(SELECT retention_bp FROM chosen),
         withholding_bp_snapshot=(SELECT withholding_bp FROM chosen), advance_minor_snapshot=(SELECT advance_minor FROM chosen),
         advance_method_snapshot=(SELECT advance_recovery_method FROM chosen), payment_terms_days_snapshot=(SELECT payment_terms_days FROM chosen),
         currency_snapshot=(SELECT currency FROM chosen), fx_rate_micro_snapshot=(SELECT fx_rate_micro FROM chosen)
       WHERE id=$12 AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM chosen)`,
      [input.contractId, input.number, input.date, input.submissionDate ?? null,
       input.dueDateOverride ?? null, input.dueDateConfirmed ? 1 : 0, input.description ?? null, input.grossMinor, input.discountMinor,
       input.manualAdvanceRecoveryMinor ?? null, input.status, id],
    )
    : await execute(
      `UPDATE payment_certificates SET number=$1, date=$2, submission_date=$3, due_date_override=$4,
          due_date_confirmed_at=CASE WHEN $5=1 THEN datetime('now') END,
          description=$6, gross_minor=$7, discount_minor=$8, manual_advance_recovery_minor=$9, status=$10
       WHERE id=$11 AND deleted_at IS NULL`,
      [input.number, input.date, input.submissionDate ?? null, input.dueDateOverride ?? null,
       input.dueDateConfirmed ? 1 : 0, input.description ?? null, input.grossMinor, input.discountMinor,
       input.manualAdvanceRecoveryMinor ?? null, input.status, id],
    );
  if (result.rowsAffected !== 1) throw new Error(refreshSnapshot ? "CERTIFICATE_REVISION_BIND_FAILED" : "CERTIFICATE_NOT_FOUND");
  const { reconcileCertificateStatuses } = await import("./payments");
  await reconcileCertificateStatuses([id]);
}

export async function setCertificateStatus(id: number, status: CertificateStatus, submissionDate?: string, dueDateConfirmed = false): Promise<void> {
  if (status === "PAID") throw new Error("PAID_REQUIRES_PAYMENT");
  if (status === "DRAFT") await assertCertificateHasNoLiveAllocations(id);
  let result;
  if (status === "SUBMITTED") {
    result = await execute(
      `WITH chosen AS (
         SELECT r.* FROM contract_revisions r JOIN payment_certificates pc ON pc.contract_id=r.contract_id
         WHERE pc.id=$1 AND r.approved_at IS NOT NULL
           AND (r.effective_date <= pc.date OR r.revision_number=1)
         ORDER BY CASE WHEN r.effective_date <= pc.date THEN 0 ELSE 1 END, r.effective_date DESC, r.revision_number DESC LIMIT 1
       )
       UPDATE payment_certificates SET status=$2, submission_date=COALESCE(submission_date,$3),
         due_date_confirmed_at=CASE WHEN $4=1 THEN COALESCE(due_date_confirmed_at,datetime('now')) ELSE due_date_confirmed_at END,
         contract_revision_id=(SELECT id FROM chosen), contract_value_minor_snapshot=(SELECT contract_value_minor FROM chosen),
         vat_bp_snapshot=(SELECT vat_bp FROM chosen), retention_bp_snapshot=(SELECT retention_bp FROM chosen),
         withholding_bp_snapshot=(SELECT withholding_bp FROM chosen), advance_minor_snapshot=(SELECT advance_minor FROM chosen),
         advance_method_snapshot=(SELECT advance_recovery_method FROM chosen), payment_terms_days_snapshot=(SELECT payment_terms_days FROM chosen),
         currency_snapshot=(SELECT currency FROM chosen), fx_rate_micro_snapshot=(SELECT fx_rate_micro FROM chosen)
       WHERE id=$1 AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM chosen)`,
      [id, status, submissionDate ?? null, dueDateConfirmed ? 1 : 0],
    );
  } else {
    result = await execute("UPDATE payment_certificates SET status=$1 WHERE id=$2 AND deleted_at IS NULL", [status, id]);
  }
  if (result.rowsAffected !== 1) throw new Error(status === "SUBMITTED" ? "CERTIFICATE_REVISION_BIND_FAILED" : "CERTIFICATE_NOT_FOUND");
  const { reconcileCertificateStatuses } = await import("./payments");
  await reconcileCertificateStatuses([id]);
}

async function assertCertificateHasNoLiveAllocations(id: number): Promise<void> {
  const row = await selectOne<{ count: number }>(
    `SELECT COUNT(*) AS count FROM payment_certificate_allocations a
     JOIN payments pm ON pm.id=a.payment_id
     WHERE a.certificate_id=$1 AND pm.deleted_at IS NULL`,
    [id],
  );
  if ((row?.count ?? 0) > 0) throw new Error("ALLOCATED_CERTIFICATE_CANNOT_BE_DRAFT");
}

/** Soft delete — history matters for certificates. */
export async function deleteCertificate(id: number): Promise<void> {
  await assertCertificateHasNoLiveAllocations(id);
  const result = await execute("UPDATE payment_certificates SET deleted_at=datetime('now'), voided_at=datetime('now'), void_reason='Voided by user' WHERE id=$1 AND voided_at IS NULL", [id]);
  if (result.rowsAffected !== 1) throw new Error("CERTIFICATE_NOT_FOUND_OR_VOIDED");
}

export function useCertificates() {
  return useQuery({ queryKey: ["certificates"], queryFn: listCertificates });
}
export function useCertificatesByContract(contractId: number) {
  return useQuery({
    queryKey: ["certificates", "contract", contractId],
    queryFn: () => listCertificatesByContract(contractId),
  });
}
export function useCertificate(id: number) {
  return useQuery({ queryKey: ["certificates", id], queryFn: () => getCertificate(id) });
}

export function useCertificateMutations() {
  const qc = useQueryClient();
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["certificates"] });
    void qc.invalidateQueries({ queryKey: ["financials"] });
    void qc.invalidateQueries({ queryKey: ["payments"] });
  };
  return {
    create: useMutation({
      mutationFn: async (input: CertificateInput) => {
        const seq = await nextCertificateSeq(input.contractId);
        return createCertificate(seq, input);
      },
      onSettled: invalidate,
    }),
    update: useMutation({
      mutationFn: async (v: { id: number; input: CertificateInput }) => {
        await updateCertificate(v.id, v.input);
      },
      onSettled: invalidate,
    }),
    setStatus: useMutation({
      mutationFn: async (v: { id: number; status: CertificateStatus; submissionDate?: string; dueDateConfirmed?: boolean }) => {
        await setCertificateStatus(v.id, v.status, v.submissionDate, v.dueDateConfirmed);
      },
      onSettled: invalidate,
    }),
    remove: useMutation({ mutationFn: deleteCertificate, onSettled: invalidate }),
  };
}
