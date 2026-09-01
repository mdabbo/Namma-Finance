import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Contract, ContractInput, ContractRevision } from "@mep/core";
import { execute, select, selectOne } from "../lib/db";
import { atomicCommand } from "../lib/atomic";

export interface RevisionMetadata { effectiveDate: string; reason: string }

export interface SyncedContractRevisionInput {
  localId: number | null;
  syncUuid: string;
  updatedAt: string;
  contractId: number;
  revisionNumber: number;
  effectiveDate: string;
  contractValueMinor: number;
  vatBp: number;
  retentionBp: number;
  withholdingBp: number;
  advanceMinor: number;
  advanceRecoveryMethod: Contract["advanceRecoveryMethod"];
  paymentTermsDays: number;
  currency: string;
  fxRateMicro: number;
  reason: string;
  createdAt: string | null;
  createdBy: string | null;
  approvedAt: string | null;
}

export interface SyncedVariationOrderInput {
  localId: number | null;
  syncUuid: string;
  updatedAt: string;
  contractId: number;
  revisionId: number | null;
  number: string;
  description: string | null;
  valueDeltaMinor: number;
  approvedAt: string | null;
  createdAt: string | null;
  createdBy: string | null;
}

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
  return atomicCommand<number>("create_contract_atomic", { input }, async () => {
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
    return id;
  });
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

  await atomicCommand<void>("update_contract_atomic", { contractId: id, input, revision: revision ?? null }, async () => {
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
  });
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

/** Archive (soft): the contract is hidden but its certificates and payments remain. */
export async function deleteContract(id: number, reason?: string): Promise<void> {
  const result = await execute(
    "UPDATE contracts SET archived_at=datetime('now'), archive_reason=$2 WHERE id=$1 AND archived_at IS NULL",
    [id, reason?.trim() || "Archived by user"],
  );
  if (result.rowsAffected !== 1) throw new Error("CONTRACT_NOT_FOUND_OR_ARCHIVED");
}

export function applySyncedContractRevision(input: SyncedContractRevisionInput): Promise<void> {
  return atomicCommand<void>("apply_synced_contract_revision_atomic", { input }, () => applySyncedContractRevisionDouble(input));
}

export function applySyncedVariationOrder(input: SyncedVariationOrderInput): Promise<void> {
  return atomicCommand<void>("apply_synced_variation_order_atomic", { input }, () => applySyncedVariationOrderDouble(input));
}

function validateSyncedRevision(input: SyncedContractRevisionInput): void {
  if (!input.syncUuid.trim() || !input.updatedAt.trim()) throw new Error("SYNC_REVISION_IDENTITY_REQUIRED");
  if (input.revisionNumber <= 0 || !input.effectiveDate.trim() || input.contractValueMinor < 0 ||
    input.advanceMinor < 0 || input.advanceMinor > input.contractValueMinor ||
    input.vatBp < 0 || input.vatBp > 10_000 || input.retentionBp < 0 || input.retentionBp > 10_000 ||
    input.withholdingBp < 0 || input.withholdingBp > 10_000 ||
    input.paymentTermsDays < 0 || input.paymentTermsDays > 3650 ||
    !input.currency.trim() || input.fxRateMicro <= 0 || !input.reason.trim()) {
    throw new Error("invalid contract revision");
  }
}

async function assertSyncedContractWritable(contractId: number): Promise<void> {
  const row = await selectOne<{ archivedAt: string | null; projectArchivedAt: string | null }>(
    `SELECT c.archived_at AS archivedAt,p.archived_at AS projectArchivedAt
       FROM contracts c JOIN projects p ON p.id=c.project_id WHERE c.id=$1`,
    [contractId],
  );
  if (!row) throw new Error("CONTRACT_NOT_FOUND");
  if (row.archivedAt !== null || row.projectArchivedAt !== null) throw new Error("ARCHIVED_CONTRACT_IS_READ_ONLY");
}

async function applySyncedContractRevisionDouble(input: SyncedContractRevisionInput): Promise<void> {
  validateSyncedRevision(input);
  await assertSyncedContractWritable(input.contractId);
  if (input.localId !== null) {
    const stored = await selectOne<RevisionRow>("SELECT * FROM contract_revisions WHERE id=$1", [input.localId]);
    if (!stored) throw new Error("CONTRACT_REVISION_NOT_FOUND");
    if (stored.approved_at !== null) {
      const same = stored.contract_id === input.contractId && stored.revision_number === input.revisionNumber &&
        stored.effective_date === input.effectiveDate && stored.contract_value_minor === input.contractValueMinor &&
        stored.vat_bp === input.vatBp && stored.retention_bp === input.retentionBp &&
        stored.withholding_bp === input.withholdingBp && stored.advance_minor === input.advanceMinor &&
        stored.advance_recovery_method === input.advanceRecoveryMethod &&
        stored.payment_terms_days === input.paymentTermsDays && stored.currency === input.currency &&
        stored.fx_rate_micro === input.fxRateMicro && stored.reason === input.reason &&
        stored.approved_at === input.approvedAt;
      if (!same) throw new Error("APPROVED_CONTRACT_REVISION_IMMUTABLE");
      await execute("UPDATE contract_revisions SET sync_uuid=$1, updated_at=$2 WHERE id=$3", [input.syncUuid, input.updatedAt, input.localId]);
      return;
    }
    await execute(
      `UPDATE contract_revisions SET contract_id=$1,revision_number=$2,effective_date=$3,
         contract_value_minor=$4,vat_bp=$5,retention_bp=$6,withholding_bp=$7,advance_minor=$8,
         advance_recovery_method=$9,payment_terms_days=$10,currency=$11,fx_rate_micro=$12,
         reason=$13,created_by=$14,approved_at=$15,sync_uuid=$16,updated_at=$17 WHERE id=$18`,
      [input.contractId, input.revisionNumber, input.effectiveDate, input.contractValueMinor,
       input.vatBp, input.retentionBp, input.withholdingBp, input.advanceMinor,
       input.advanceRecoveryMethod, input.paymentTermsDays, input.currency, input.fxRateMicro,
       input.reason.trim(), input.createdBy, input.approvedAt, input.syncUuid, input.updatedAt,
       input.localId],
    );
    return;
  }
  await execute(
    `INSERT INTO contract_revisions
       (contract_id,revision_number,effective_date,contract_value_minor,vat_bp,retention_bp,
        withholding_bp,advance_minor,advance_recovery_method,payment_terms_days,currency,
        fx_rate_micro,reason,created_at,created_by,approved_at,sync_uuid,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
    [input.contractId, input.revisionNumber, input.effectiveDate, input.contractValueMinor,
     input.vatBp, input.retentionBp, input.withholdingBp, input.advanceMinor,
     input.advanceRecoveryMethod, input.paymentTermsDays, input.currency, input.fxRateMicro,
     input.reason.trim(), input.createdAt ?? input.updatedAt, input.createdBy, input.approvedAt,
     input.syncUuid, input.updatedAt],
  );
}

async function applySyncedVariationOrderDouble(input: SyncedVariationOrderInput): Promise<void> {
  if (!input.syncUuid.trim() || !input.updatedAt.trim()) throw new Error("SYNC_VARIATION_IDENTITY_REQUIRED");
  if (!input.number.trim()) throw new Error("invalid variation order");
  await assertSyncedContractWritable(input.contractId);
  if (input.revisionId !== null) {
    const revision = await selectOne<{ contractId: number }>("SELECT contract_id AS contractId FROM contract_revisions WHERE id=$1", [input.revisionId]);
    if (!revision) throw new Error("CONTRACT_REVISION_NOT_FOUND");
    if (revision.contractId !== input.contractId) throw new Error("VARIATION_REVISION_CONTRACT_MISMATCH");
  }
  if (input.localId !== null) {
    const stored = await selectOne<{ contract_id: number; revision_id: number | null; number: string; description: string | null; value_delta_minor: number; approved_at: string | null }>(
      "SELECT contract_id,revision_id,number,description,value_delta_minor,approved_at FROM variation_orders WHERE id=$1",
      [input.localId],
    );
    if (!stored) throw new Error("VARIATION_ORDER_NOT_FOUND");
    if (stored.approved_at !== null) {
      const same = stored.contract_id === input.contractId && stored.revision_id === input.revisionId &&
        stored.number === input.number && stored.description === input.description &&
        stored.value_delta_minor === input.valueDeltaMinor && stored.approved_at === input.approvedAt;
      if (!same) throw new Error("APPROVED_VARIATION_ORDER_IMMUTABLE");
      await execute("UPDATE variation_orders SET sync_uuid=$1, updated_at=$2 WHERE id=$3", [input.syncUuid, input.updatedAt, input.localId]);
      return;
    }
    await execute(
      `UPDATE variation_orders SET contract_id=$1,revision_id=$2,number=$3,description=$4,
         value_delta_minor=$5,approved_at=$6,created_by=$7,sync_uuid=$8,updated_at=$9 WHERE id=$10`,
      [input.contractId, input.revisionId, input.number, input.description, input.valueDeltaMinor,
       input.approvedAt, input.createdBy, input.syncUuid, input.updatedAt, input.localId],
    );
    return;
  }
  await execute(
    `INSERT INTO variation_orders
       (contract_id,revision_id,number,description,value_delta_minor,approved_at,created_at,
        created_by,sync_uuid,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [input.contractId, input.revisionId, input.number, input.description, input.valueDeltaMinor,
     input.approvedAt, input.createdAt ?? input.updatedAt, input.createdBy, input.syncUuid,
     input.updatedAt],
  );
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
    remove: useMutation({
      mutationFn: (v: { id: number; reason?: string }) => deleteContract(v.id, v.reason),
      onSuccess: invalidate,
    }),
  };
}
