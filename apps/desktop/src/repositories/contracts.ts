import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Contract, ContractInput } from "@mep/core";
import { execute, select, selectOne } from "../lib/db";

export interface ContractRow {
  id: number;
  project_id: number;
  number: string;
  title: string | null;
  value_minor: number;
  vat_bp: number;
  retention_bp: number;
  withholding_bp: number;
  advance_minor: number;
  advance_recovery_method: Contract["advanceRecoveryMethod"];
  performance_bond_bp: number;
  performance_bond_bank: string | null;
  performance_bond_expiry: string | null;
  payment_terms_days: number;
  payment_terms_notes: string | null;
  valuation_mode: Contract["valuationMode"];
  milestones: string | null;
  drawings: string | null;
  attachments: string | null;
  signed_date: string | null;
  notes: string | null;
  created_at: string;
}

export function mapContract(r: ContractRow): Contract {
  return {
    id: r.id,
    projectId: r.project_id,
    number: r.number,
    title: r.title,
    valueMinor: r.value_minor,
    vatBp: r.vat_bp,
    retentionBp: r.retention_bp,
    withholdingBp: r.withholding_bp,
    advanceMinor: r.advance_minor,
    advanceRecoveryMethod: r.advance_recovery_method,
    performanceBondBp: r.performance_bond_bp,
    performanceBondBank: r.performance_bond_bank,
    performanceBondExpiry: r.performance_bond_expiry,
    paymentTermsDays: r.payment_terms_days,
    paymentTermsNotes: r.payment_terms_notes,
    valuationMode: r.valuation_mode,
    milestones: r.milestones,
    drawings: r.drawings,
    attachments: r.attachments,
    signedDate: r.signed_date,
    notes: r.notes,
    createdAt: r.created_at,
  };
}

export async function listContractsByProject(projectId: number): Promise<Contract[]> {
  const rows = await select<ContractRow>(
    "SELECT * FROM contracts WHERE project_id = $1 ORDER BY created_at, id",
    [projectId],
  );
  return rows.map(mapContract);
}

export async function getContract(id: number): Promise<Contract | null> {
  const row = await selectOne<ContractRow>("SELECT * FROM contracts WHERE id = $1", [id]);
  return row ? mapContract(row) : null;
}

export async function createContract(input: ContractInput): Promise<number> {
  const r = await execute(
    `INSERT INTO contracts (project_id, number, title, value_minor, vat_bp, retention_bp, withholding_bp,
        advance_minor, advance_recovery_method, performance_bond_bp, performance_bond_bank,
        performance_bond_expiry, payment_terms_days, payment_terms_notes, valuation_mode, milestones,
        drawings, attachments, signed_date, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
    [input.projectId, input.number, input.title ?? null, input.valueMinor, input.vatBp, input.retentionBp,
     input.withholdingBp, input.advanceMinor, input.advanceRecoveryMethod, input.performanceBondBp,
     input.performanceBondBank ?? null, input.performanceBondExpiry ?? null, input.paymentTermsDays,
     input.paymentTermsNotes ?? null, input.valuationMode, input.milestones ?? null,
     input.drawings ?? null, input.attachments ?? null, input.signedDate ?? null, input.notes ?? null],
  );
  return r.lastInsertId ?? 0;
}

export async function updateContract(id: number, input: ContractInput): Promise<void> {
  await execute(
    `UPDATE contracts SET number=$1, title=$2, value_minor=$3, vat_bp=$4, retention_bp=$5,
        withholding_bp=$6, advance_minor=$7, advance_recovery_method=$8, performance_bond_bp=$9,
        performance_bond_bank=$10, performance_bond_expiry=$11, payment_terms_days=$12,
        payment_terms_notes=$13, valuation_mode=$14, milestones=$15, drawings=$16, attachments=$17,
        signed_date=$18, notes=$19
     WHERE id=$20`,
    [input.number, input.title ?? null, input.valueMinor, input.vatBp, input.retentionBp,
     input.withholdingBp, input.advanceMinor, input.advanceRecoveryMethod, input.performanceBondBp,
     input.performanceBondBank ?? null, input.performanceBondExpiry ?? null, input.paymentTermsDays,
     input.paymentTermsNotes ?? null, input.valuationMode, input.milestones ?? null,
     input.drawings ?? null, input.attachments ?? null, input.signedDate ?? null, input.notes ?? null, id],
  );
}

export async function contractCascadeInfo(id: number) {
  const row = await selectOne<{ certificates: number; payments: number }>(
    `SELECT
       (SELECT COUNT(*) FROM payment_certificates WHERE contract_id=$1) AS certificates,
       (SELECT COUNT(*) FROM payments WHERE contract_id=$1) AS payments`,
    [id],
  );
  return row ?? { certificates: 0, payments: 0 };
}

export async function deleteContract(id: number): Promise<void> {
  await execute("DELETE FROM contracts WHERE id = $1", [id]);
}

export function useContractsByProject(projectId: number) {
  return useQuery({ queryKey: ["contracts", "project", projectId], queryFn: () => listContractsByProject(projectId) });
}
export function useContract(id: number) {
  return useQuery({ queryKey: ["contracts", id], queryFn: () => getContract(id) });
}

export function useContractMutations() {
  const qc = useQueryClient();
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["contracts"] });
    void qc.invalidateQueries({ queryKey: ["financials"] });
    void qc.invalidateQueries({ queryKey: ["certificates"] });
  };
  // achieved milestones auto-prepare their draft certificates
  const reconcile = async (contractId: number) => {
    const { reconcileMilestoneCertificates } = await import("./milestoneCertificates");
    await reconcileMilestoneCertificates(contractId);
  };
  return {
    create: useMutation({
      mutationFn: async (input: ContractInput) => {
        const id = await createContract(input);
        await reconcile(id);
        return id;
      },
      onSuccess: invalidate,
    }),
    update: useMutation({
      mutationFn: async (v: { id: number; input: ContractInput }) => {
        await updateContract(v.id, v.input);
        await reconcile(v.id);
      },
      onSuccess: invalidate,
    }),
    remove: useMutation({ mutationFn: deleteContract, onSuccess: invalidate }),
  };
}
