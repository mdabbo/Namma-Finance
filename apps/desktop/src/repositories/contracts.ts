import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Contract, ContractInput, ContractRevision } from "@mep/core";
import { execute, select, selectOne } from "../lib/db";
import { invoke } from "@tauri-apps/api/core";

export interface RevisionMetadata { effectiveDate: string; reason: string }

interface RevisionRow {
  id: number; contract_id: number; revision_number: number; effective_date: string;
  contract_value_minor: number; vat_bp: number; retention_bp: number; withholding_bp: number;
  advance_minor: number; advance_recovery_method: Contract["advanceRecoveryMethod"];
  payment_terms_days: number; currency: string; fx_rate_micro: number; reason: string;
  approved_at: string | null; created_at: string;
}

export async function listContractRevisions(contractId: number): Promise<ContractRevision[]> {
  const rows = await select<RevisionRow>("SELECT * FROM contract_revisions WHERE contract_id=$1 ORDER BY revision_number", [contractId]);
  return rows.map((r) => ({ id: r.id, contractId: r.contract_id, revisionNumber: r.revision_number,
    effectiveDate: r.effective_date, contractValueMinor: r.contract_value_minor, vatBp: r.vat_bp,
    retentionBp: r.retention_bp, withholdingBp: r.withholding_bp, advanceMinor: r.advance_minor,
    advanceRecoveryMethod: r.advance_recovery_method, paymentTermsDays: r.payment_terms_days,
    currency: r.currency, fxRateMicro: r.fx_rate_micro, reason: r.reason,
    approvedAt: r.approved_at, createdAt: r.created_at }));
}

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
    "SELECT * FROM contracts WHERE project_id = $1 AND archived_at IS NULL ORDER BY created_at, id",
    [projectId],
  );
  return rows.map(mapContract);
}

export async function getContract(id: number): Promise<Contract | null> {
  const row = await selectOne<ContractRow>("SELECT * FROM contracts WHERE id=$1 AND archived_at IS NULL", [id]);
  return row ? mapContract(row) : null;
}

/**
 * Next contract number for a project: the project's own code plus a per-project
 * counter, e.g. PRJ-2026-001-C1, PRJ-2026-001-C2. The counter is the highest
 * existing -C<n> suffix + 1 (robust to deletions and manual numbers).
 */
export async function nextContractNumber(_projectId: number, prefix = "CON"): Promise<string> {
  const { reserveNextNumber } = await import("./numbering");
  return reserveNextNumber("CONTRACT", prefix);
}

export async function createContract(input: ContractInput): Promise<number> {
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    return invoke<number>("create_contract_atomic", { input });
  }
  await execute("BEGIN IMMEDIATE");
  try {
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
    const id = r.lastInsertId ?? 0;
    const project = await selectOne<{ currency: string; fxRateMicro: number }>("SELECT currency, fx_rate_micro AS fxRateMicro FROM projects WHERE id=$1", [input.projectId]);
    if (!project) throw new Error("PROJECT_NOT_FOUND");
    await execute(
      `INSERT INTO contract_revisions (contract_id,revision_number,effective_date,contract_value_minor,vat_bp,retention_bp,withholding_bp,advance_minor,advance_recovery_method,payment_terms_days,currency,fx_rate_micro,reason,approved_at)
       VALUES ($1,1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'Initial contract terms',datetime('now'))`,
      [id, input.signedDate ?? new Date().toISOString().slice(0, 10), input.valueMinor, input.vatBp, input.retentionBp,
       input.withholdingBp, input.advanceMinor, input.advanceRecoveryMethod, input.paymentTermsDays, project.currency, project.fxRateMicro],
    );
    await execute("COMMIT");
    return id;
  } catch (error) {
    await execute("ROLLBACK");
    throw error;
  }
}

export async function updateContract(id: number, input: ContractInput, revision?: RevisionMetadata): Promise<void> {
  const current = await getContract(id);
  if (!current) throw new Error("CONTRACT_NOT_FOUND");
  const protectedChanged = current.valueMinor !== input.valueMinor || current.vatBp !== input.vatBp ||
    current.retentionBp !== input.retentionBp || current.withholdingBp !== input.withholdingBp ||
    current.advanceMinor !== input.advanceMinor || current.advanceRecoveryMethod !== input.advanceRecoveryMethod ||
    current.paymentTermsDays !== input.paymentTermsDays;
  const history = await selectOne<{ count: number }>(
    "SELECT COUNT(*) AS count FROM payment_certificates WHERE contract_id=$1 AND status IN ('SUBMITTED','APPROVED','PAID') AND deleted_at IS NULL",
    [id],
  );
  const hasHistory = (history?.count ?? 0) > 0;
  if (hasHistory && protectedChanged && (!revision?.reason.trim() || !revision.effectiveDate)) throw new Error("CONTRACT_REVISION_REQUIRED");

  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    await invoke("update_contract_atomic", { contractId: id, input, revision: revision ?? null });
    return;
  }

  await execute("BEGIN IMMEDIATE");
  try {
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
    if (protectedChanged) {
      const project = await selectOne<{ currency: string; fxRateMicro: number }>("SELECT currency, fx_rate_micro AS fxRateMicro FROM projects WHERE id=$1", [input.projectId]);
      if (!project) throw new Error("PROJECT_NOT_FOUND");
      const next = await selectOne<{ n: number }>("SELECT COALESCE(MAX(revision_number),0)+1 AS n FROM contract_revisions WHERE contract_id=$1", [id]);
      const effectiveDate = revision?.effectiveDate || input.signedDate || new Date().toISOString().slice(0, 10);
      const reason = revision?.reason.trim() || "Commercial terms corrected before financial history";
      const inserted = await execute(
          `INSERT INTO contract_revisions (contract_id,revision_number,effective_date,contract_value_minor,vat_bp,retention_bp,withholding_bp,advance_minor,advance_recovery_method,payment_terms_days,currency,fx_rate_micro,reason,approved_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,datetime('now'))`,
          [id, next?.n ?? 2, effectiveDate, input.valueMinor, input.vatBp, input.retentionBp,
           input.withholdingBp, input.advanceMinor, input.advanceRecoveryMethod, input.paymentTermsDays,
           project.currency, project.fxRateMicro, reason],
        );
      if (current.valueMinor !== input.valueMinor) {
          await execute(
            `INSERT INTO variation_orders (contract_id,revision_id,number,description,value_delta_minor,approved_at)
             VALUES ($1,$2,$3,$4,$5,datetime('now'))`,
            [id, inserted.lastInsertId, `VO-${next?.n ?? 2}`, reason, input.valueMinor - current.valueMinor],
          );
      }
    }
    await execute("COMMIT");
  } catch (error) {
    await execute("ROLLBACK");
    throw error;
  }
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
  const result = await execute("UPDATE contracts SET archived_at=datetime('now'), archive_reason='Archived by user' WHERE id=$1 AND archived_at IS NULL", [id]);
  if (result.rowsAffected !== 1) throw new Error("CONTRACT_NOT_FOUND_OR_ARCHIVED");
}

export function useContractsByProject(projectId: number) {
  return useQuery({ queryKey: ["contracts", "project", projectId], queryFn: () => listContractsByProject(projectId) });
}
export function useContract(id: number) {
  return useQuery({ queryKey: ["contracts", id], queryFn: () => getContract(id) });
}
export function useContractRevisions(contractId: number) {
  return useQuery({ queryKey: ["contract-revisions", contractId], queryFn: () => listContractRevisions(contractId) });
}

export function useContractMutations() {
  const qc = useQueryClient();
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["contracts"] });
    void qc.invalidateQueries({ queryKey: ["financials"] });
    void qc.invalidateQueries({ queryKey: ["certificates"] });
    void qc.invalidateQueries({ queryKey: ["contract-revisions"] });
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
      mutationFn: async (v: { id: number; input: ContractInput; revision?: RevisionMetadata }) => {
        await updateContract(v.id, v.input, v.revision);
        await reconcile(v.id);
      },
      onSuccess: invalidate,
    }),
    remove: useMutation({ mutationFn: deleteContract, onSuccess: invalidate }),
  };
}
