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
         p.code AS project_code, p.currency AS currency, cl.name AS client_name
  FROM payment_certificates pc
  JOIN contracts ct ON ct.id = pc.contract_id
  JOIN projects p ON p.id = ct.project_id
  JOIN clients cl ON cl.id = p.client_id
  WHERE pc.deleted_at IS NULL`;

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
  const r = await execute(
    `INSERT INTO payment_certificates (contract_id, seq, number, date, submission_date, due_date_override,
        description, gross_minor, discount_minor, manual_advance_recovery_minor, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [input.contractId, seq, input.number, input.date, input.submissionDate ?? null,
     input.dueDateOverride ?? null, input.description ?? null, input.grossMinor, input.discountMinor,
     input.manualAdvanceRecoveryMinor ?? null, input.status],
  );
  return r.lastInsertId ?? 0;
}

export async function updateCertificate(id: number, input: CertificateInput): Promise<void> {
  await execute(
    `UPDATE payment_certificates SET number=$1, date=$2, submission_date=$3, due_date_override=$4,
        description=$5, gross_minor=$6, discount_minor=$7, manual_advance_recovery_minor=$8, status=$9
     WHERE id=$10`,
    [input.number, input.date, input.submissionDate ?? null, input.dueDateOverride ?? null,
     input.description ?? null, input.grossMinor, input.discountMinor,
     input.manualAdvanceRecoveryMinor ?? null, input.status, id],
  );
}

export async function setCertificateStatus(id: number, status: CertificateStatus, submissionDate?: string): Promise<void> {
  if (status === "SUBMITTED" && submissionDate) {
    await execute(
      "UPDATE payment_certificates SET status=$1, submission_date=COALESCE(submission_date, $2) WHERE id=$3",
      [status, submissionDate, id],
    );
  } else {
    await execute("UPDATE payment_certificates SET status=$1 WHERE id=$2", [status, id]);
  }
}

/** Soft delete — history matters for certificates. */
export async function deleteCertificate(id: number): Promise<void> {
  await execute("UPDATE payment_certificates SET deleted_at = datetime('now') WHERE id = $1", [id]);
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
  // Saving a certificate as PAID must also record the money (see
  // backPaidCertificatesWithPayments) — otherwise "collected" stays 0.
  const backfillIfPaid = async (id: number, status: CertificateStatus) => {
    if (status === "PAID") {
      const { backPaidCertificatesWithPayments } = await import("./payments");
      await backPaidCertificatesWithPayments([id]);
    }
  };
  return {
    create: useMutation({
      mutationFn: async (input: CertificateInput) => {
        const seq = await nextCertificateSeq(input.contractId);
        const id = await createCertificate(seq, input);
        await backfillIfPaid(id, input.status);
        return id;
      },
      onSuccess: invalidate,
    }),
    update: useMutation({
      mutationFn: async (v: { id: number; input: CertificateInput }) => {
        await updateCertificate(v.id, v.input);
        await backfillIfPaid(v.id, v.input.status);
      },
      onSuccess: invalidate,
    }),
    setStatus: useMutation({
      mutationFn: async (v: { id: number; status: CertificateStatus; submissionDate?: string }) => {
        await setCertificateStatus(v.id, v.status, v.submissionDate);
        await backfillIfPaid(v.id, v.status);
      },
      onSuccess: invalidate,
    }),
    remove: useMutation({ mutationFn: deleteCertificate, onSuccess: invalidate }),
  };
}
