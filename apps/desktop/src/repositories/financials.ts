import { useQuery } from "@tanstack/react-query";
import {
  assignmentCostPosition,
  assignmentRaisesAlerts,
  computeContractState,
  computeProjectFinancials,
  computeReadyToBill,
  computeProjectCostProfile,
  computeTeamPayout,
  laborCostMinor,
  parseMilestones,
  resolveEffectiveFxSnapshot,
  toEgpPiasters,
  type Contract,
  type ContractState,
  type Expense,
  type PaymentAllocation,
  type PaymentKind,
  type ProjectFinancials,
  type ProjectCostProfile,
  type AssignmentLifecycle,
  type ProjectCashValuationEgp,
} from "@mep/core";
import { select } from "../lib/db";
import { todayIso } from "../lib/format";
import { mapProject, type ProjectRow } from "./projects";
import { mapContract, type ContractRow } from "./contracts";
import { mapCertificate, type CertificateRow } from "./certificates";
import { mapPayment, type PaymentRow } from "./payments";

/**
 * Financial state is always recomputed from source records via @mep/core —
 * nothing derived is read from the database.
 */

export type FinancialSelect = <T>(sql: string, params?: unknown[]) => Promise<T[]>;

async function loadAllocations(read: FinancialSelect): Promise<PaymentAllocation[]> {
  return read<PaymentAllocation>(
    `SELECT a.id, a.payment_id AS paymentId, a.certificate_id AS certificateId, a.amount_minor AS amountMinor
     FROM payment_certificate_allocations a
     JOIN payments pm ON pm.id=a.payment_id
     JOIN payment_certificates pc ON pc.id=a.certificate_id
     JOIN contracts c ON c.id=pm.contract_id AND c.id=pc.contract_id
     JOIN projects p ON p.id=c.project_id
     WHERE pm.deleted_at IS NULL AND pm.voided_at IS NULL
       AND pc.deleted_at IS NULL AND pc.voided_at IS NULL AND pc.archived_at IS NULL
       AND c.archived_at IS NULL AND p.archived_at IS NULL`,
  );
}

async function loadExpenses(read: FinancialSelect): Promise<Expense[]> {
  const rows = await read<{
    id: number; date: string; category_id: number; description: string; project_id: number | null;
    supplier: string | null; amount_minor: number; currency: string; fx_rate_micro: number;
    attachment_path: string | null; created_at: string;
  }>(`SELECT e.* FROM expenses e
      WHERE e.voided_at IS NULL AND e.archived_at IS NULL
        AND (e.project_id IS NULL OR EXISTS(
          SELECT 1 FROM projects p WHERE p.id=e.project_id AND p.archived_at IS NULL
        ))`);
  return rows.map((r) => ({
    id: r.id, date: r.date, categoryId: r.category_id, description: r.description,
    projectId: r.project_id, supplier: r.supplier, amountMinor: r.amount_minor,
    currency: r.currency, fxRateMicro: r.fx_rate_micro, attachmentPath: r.attachment_path,
    createdAt: r.created_at,
  }));
}

export interface ReadyToCollectItem {
  contractId: number;
  contractNumber: string;
  projectId: number;
  projectName: string;
  projectCode: string;
  currency: string;
  achievedTitles: string[];
  readyMinor: number;
  readyEgp: number;
}

export interface TeamPayableItem {
  assignmentId: number;
  personId: number;
  personName: string;
  projectId: number;
  projectName: string;
  projectCode: string;
  currency: string;
  dueMinor: number;
  dueEgp: number;
  /** Released stage titles not yet paid to the person. */
  dueTitles: string[];
}

export interface TeamAccountItem {
  assignmentId: number;
  projectId: number;
  currency: string;
  /** What happened to the work; drives how the figures below are derived. */
  lifecycleStatus: AssignmentLifecycle;
  /** Visibility only — an archived assignment still owes what it earned. */
  archived: boolean;
  /**
   * Fee earned: released by paid client certificates while ACTIVE or
   * COMPLETED, or the balance frozen at cancellation.
   */
  accruedMinor: number;
  /** Real person-payment records posted against the assignment. */
  paidMinor: number;
  /** Earned less paid, floored at zero. */
  dueMinor: number;
  /** Cost the project has committed: the agreed fee, or earned if cancelled. */
  committedMinor: number;
}

export interface WorkspaceFinancials {
  projects: ProjectFinancials[];
  contractStates: Map<number, ContractState>;
  allExpenses: Expense[];
  /** Every live incoming payment with its EGP-converted amount (for cash-flow charts). */
  cashIn: {
    paymentId: number;
    number: string;
    date: string;
    kind: PaymentKind;
    projectId: number;
    egpMinor: number;
  }[];
  /** Achieved milestones not yet certified — work the client should be billed for. */
  readyToCollect: ReadyToCollectItem[];
  /** Paid certificates whose team-member share has not been paid out yet. */
  teamPayables: TeamPayableItem[];
  /** Audited payout state for every live assignment, including fully paid rows. */
  teamAccounts: TeamAccountItem[];
  /** Analytical labor cost per project (EGP) from logged time — costing only,
   *  deliberately NOT part of cash net profit (salaries stay overhead). */
  laborByProjectEgp: Map<number, number>;
  /** Separate cash, accrual, commitment, and forecast views by project. */
  costsByProject: Map<number, ProjectCostProfile>;
}

interface RevisionFxRow {
  contract_id: number;
  revision_number: number;
  effective_date: string;
  currency: string;
  fx_rate_micro: number;
}

async function financialReadRevision(read: FinancialSelect): Promise<number> {
  const rows = await read<{ revision: number }>(
    "SELECT COALESCE(MAX(id),0) AS revision FROM audit_logs",
  );
  return rows[0]?.revision ?? 0;
}

/** One calculation pass. The public loader verifies that its source revision stayed stable. */
async function loadWorkspaceFinancialsOnce(read: FinancialSelect): Promise<WorkspaceFinancials> {
  const today = todayIso();
  const [projectRows, contractRows, certRows, paymentRows, allocations, expenses, revisionFxRows] = await Promise.all([
    read<ProjectRow>("SELECT p.*, c.name AS client_name FROM projects p JOIN clients c ON c.id = p.client_id WHERE p.archived_at IS NULL"),
    read<ContractRow>(`SELECT c.* FROM contracts c
      JOIN projects p ON p.id=c.project_id
      WHERE c.archived_at IS NULL AND p.archived_at IS NULL`),
    read<CertificateRow>(`SELECT pc.* FROM payment_certificates pc
      JOIN contracts c ON c.id=pc.contract_id
      JOIN projects p ON p.id=c.project_id
      WHERE pc.deleted_at IS NULL AND pc.voided_at IS NULL AND pc.archived_at IS NULL
        AND c.archived_at IS NULL AND p.archived_at IS NULL`),
    read<PaymentRow>(`SELECT pm.* FROM payments pm
      JOIN contracts c ON c.id=pm.contract_id
      JOIN projects p ON p.id=c.project_id
      WHERE pm.deleted_at IS NULL AND pm.voided_at IS NULL
        AND c.archived_at IS NULL AND p.archived_at IS NULL`),
    loadAllocations(read),
    loadExpenses(read),
    read<RevisionFxRow>(`SELECT r.contract_id,r.revision_number,r.effective_date,r.currency,r.fx_rate_micro
      FROM contract_revisions r
      JOIN contracts c ON c.id=r.contract_id
      JOIN projects p ON p.id=c.project_id
      WHERE r.approved_at IS NOT NULL AND c.archived_at IS NULL AND p.archived_at IS NULL
      ORDER BY r.contract_id,r.effective_date,r.revision_number`),
  ]);

  const projects = projectRows.map(mapProject);
  const contracts: Contract[] = contractRows.map(mapContract);
  const certificates = certRows.map(mapCertificate);
  const payments = paymentRows.map(mapPayment);
  const fxByContract = new Map<number, RevisionFxRow[]>();
  for (const revision of revisionFxRows) {
    const list = fxByContract.get(revision.contract_id) ?? [];
    list.push(revision);
    fxByContract.set(revision.contract_id, list);
  }
  const projectById = new Map(projects.map((project) => [project.id, project]));
  const projectByContract = new Map(contracts.map((contract) => [
    contract.id,
    projectById.get(contract.projectId),
  ]));
  const paymentFx = new Map<number, { currency: string; fxRateMicro: number }>();
  for (const payment of payments) {
    const project = projectByContract.get(payment.contractId);
    if (!project) continue;
    paymentFx.set(payment.id, resolveEffectiveFxSnapshot(
      (fxByContract.get(payment.contractId) ?? []).map((revision) => ({
        effectiveDate: revision.effective_date,
        revisionNumber: revision.revision_number,
        currency: revision.currency,
        fxRateMicro: revision.fx_rate_micro,
      })),
      payment.date,
      { currency: project.currency, fxRateMicro: project.fxRateMicro },
    ));
  }

  const contractStates = new Map<number, ContractState>();
  for (const contract of contracts) {
    contractStates.set(
      contract.id,
      computeContractState({
        contract,
        certificates: certificates.filter((c) => c.contractId === contract.id),
        payments: payments.filter((p) => p.contractId === contract.id),
        allocations,
        todayIso: today,
      }),
    );
  }

  const cashValuationByProject = new Map<number, ProjectCashValuationEgp>();
  for (const project of projects) {
    const valuation: ProjectCashValuationEgp = {
      certificateCollectionsEgp: 0,
      advanceReceivedEgp: 0,
      retentionReleasedEgp: 0,
      totalActualCashInEgp: 0,
      unallocatedCustomerCreditEgp: 0,
    };
    for (const contract of contracts.filter((item) => item.projectId === project.id)) {
      const state = contractStates.get(contract.id)!;
      const billableCertificateIds = new Set(
        state.certificates
          .filter((item) => item.certificate.status !== "DRAFT")
          .map((item) => item.certificate.id),
      );
      for (const certificate of state.certificates) {
        if (!billableCertificateIds.has(certificate.certificate.id)) continue;
        valuation.certificateCollectionsEgp += toEgpPiasters(
          certificate.paidMinor,
          certificate.certificate.currencySnapshot ?? project.currency,
          certificate.certificate.fxRateMicroSnapshot ?? project.fxRateMicro,
        );
      }
      const allocatedByPayment = new Map<number, number>();
      for (const allocation of allocations) {
        if (!billableCertificateIds.has(allocation.certificateId)) continue;
        allocatedByPayment.set(
          allocation.paymentId,
          (allocatedByPayment.get(allocation.paymentId) ?? 0) + allocation.amountMinor,
        );
      }
      for (const payment of payments.filter((item) => item.contractId === contract.id)) {
        const fx = paymentFx.get(payment.id) ?? {
          currency: project.currency,
          fxRateMicro: project.fxRateMicro,
        };
        valuation.totalActualCashInEgp += toEgpPiasters(
          payment.amountMinor,
          fx.currency,
          fx.fxRateMicro,
        );
        if (payment.kind === "ADVANCE") {
          valuation.advanceReceivedEgp += toEgpPiasters(payment.amountMinor, fx.currency, fx.fxRateMicro);
        } else if (payment.kind === "RETENTION_RELEASE") {
          valuation.retentionReleasedEgp += toEgpPiasters(payment.amountMinor, fx.currency, fx.fxRateMicro);
        } else {
          valuation.unallocatedCustomerCreditEgp += toEgpPiasters(
            Math.max(0, payment.amountMinor - (allocatedByPayment.get(payment.id) ?? 0)),
            fx.currency,
            fx.fxRateMicro,
          );
        }
      }
    }
    cashValuationByProject.set(project.id, valuation);
  }
  const projectFinancials = projects.map((project) => computeProjectFinancials(
    project,
    contracts.filter((contract) => contract.projectId === project.id)
      .map((contract) => contractStates.get(contract.id)!),
    expenses.filter((expense) => expense.projectId === project.id),
    cashValuationByProject.get(project.id),
  ));

  const cashIn = payments.flatMap((p) => {
    const project = projectByContract.get(p.contractId);
    if (!project) return [];
    const fx = paymentFx.get(p.id) ?? {
      currency: project.currency,
      fxRateMicro: project.fxRateMicro,
    };
    return [{
      paymentId: p.id,
      number: p.number,
      date: p.date,
      kind: p.kind,
      projectId: project.id,
      egpMinor: toEgpPiasters(p.amountMinor, fx.currency, fx.fxRateMicro),
    }];
  });
  const cashInByProjectEgp = new Map<number, number>();
  for (const payment of payments) {
    const project = projectByContract.get(payment.contractId);
    if (!project) continue;
    const fx = paymentFx.get(payment.id) ?? {
      currency: project.currency,
      fxRateMicro: project.fxRateMicro,
    };
    const amountEgp = toEgpPiasters(payment.amountMinor, fx.currency, fx.fxRateMicro);
    cashInByProjectEgp.set(project.id, (cashInByProjectEgp.get(project.id) ?? 0) + amountEgp);
  }

  // achieved-milestone billing alerts (milestones link to completed stages or are checked manually)
  const completedStages = await read<{ id: number; project_id: number }>(
    `SELECT s.id,s.project_id FROM project_stages s
     JOIN projects p ON p.id=s.project_id
     WHERE s.status='COMPLETED' AND p.archived_at IS NULL`,
  );
  const completedByProject = new Map<number, Set<number>>();
  for (const s of completedStages) {
    if (!completedByProject.has(s.project_id)) completedByProject.set(s.project_id, new Set());
    completedByProject.get(s.project_id)!.add(s.id);
  }
  const readyToCollect: ReadyToCollectItem[] = [];
  for (const contract of contracts) {
    if (contract.valuationMode !== "MILESTONES") continue;
    const milestones = parseMilestones(contract.milestones);
    if (milestones.length === 0) continue;
    const project = projectByContract.get(contract.id);
    const state = contractStates.get(contract.id);
    if (!project || !state) continue;
    const ready = computeReadyToBill(
      contract.valueMinor,
      milestones,
      completedByProject.get(project.id) ?? new Set(),
      state.certifiedBaseMinor,
    );
    if (ready.readyMinor > 0) {
      readyToCollect.push({
        contractId: contract.id,
        contractNumber: contract.number,
        projectId: project.id,
        projectName: project.name,
        projectCode: project.code,
        currency: project.currency,
        achievedTitles: ready.achievedTitles,
        readyMinor: ready.readyMinor,
        readyEgp: toEgpPiasters(ready.readyMinor, project.currency, project.fxRateMicro),
      });
    }
  }
  readyToCollect.sort((a, b) => b.readyEgp - a.readyEgp);

  // team payables: client paid a certificate → the matching stage of every
  // assignment on that project becomes payable to the team member
  const assignments = await read<{
    id: number; person_id: number; project_id: number; agreed_minor: number;
    currency: string; fx_rate_micro: number; person_name: string;
    lifecycle_status: AssignmentLifecycle;
    earned_minor_at_cancellation: number | null;
    archived_at: string | null;
    person_archived_at: string | null;
  }>(
    `SELECT a.id, a.person_id, a.project_id, a.agreed_minor, a.currency, a.fx_rate_micro,
            a.lifecycle_status, a.earned_minor_at_cancellation, a.archived_at,
            pe.name AS person_name, pe.archived_at AS person_archived_at
     FROM project_assignments a
     JOIN people pe ON pe.id=a.person_id
     JOIN projects p ON p.id=a.project_id
     WHERE p.archived_at IS NULL`,
  );
  const paidByAssignment = new Map<number, number>();
  for (const r of await read<{ assignment_id: number; paid: number }>(
    "SELECT assignment_id, SUM(amount_minor) AS paid FROM person_payments WHERE voided_at IS NULL GROUP BY assignment_id",
  )) {
    paidByAssignment.set(r.assignment_id, r.paid);
  }
  const statesByProject = new Map<number, ContractState[]>();
  for (const contract of contracts) {
    const list = statesByProject.get(contract.projectId) ?? [];
    list.push(contractStates.get(contract.id)!);
    statesByProject.set(contract.projectId, list);
  }
  const teamPayables: TeamPayableItem[] = [];
  const teamAccounts: TeamAccountItem[] = [];
  // Committed and accrued cost are collected for EVERY assignment, archived
  // included: archiving hides a row, it does not unspend the money. Only the
  // operational alert list is filtered.
  const committedTeamByProject = new Map<number, number>();
  const accruedByProject = new Map<number, number>();
  for (const a of assignments) {
    const project = projectById.get(a.project_id);
    if (!project) continue;
    const payout = computeTeamPayout(
      a.agreed_minor,
      statesByProject.get(a.project_id) ?? [],
      paidByAssignment.get(a.id) ?? 0,
    );
    const position = assignmentCostPosition({
      lifecycle: a.lifecycle_status,
      agreedMinor: a.agreed_minor,
      releasedMinor: payout.releasedMinor,
      paidOutMinor: payout.paidOutMinor,
      earnedAtCancellationMinor: a.earned_minor_at_cancellation,
    });
    const toEgp = (minor: number) => toEgpPiasters(minor, a.currency, a.fx_rate_micro);
    teamAccounts.push({
      assignmentId: a.id,
      projectId: project.id,
      currency: a.currency,
      lifecycleStatus: a.lifecycle_status,
      archived: a.archived_at !== null,
      accruedMinor: position.earnedMinor,
      paidMinor: position.paidMinor,
      dueMinor: position.dueMinor,
      committedMinor: position.committedMinor,
    });
    committedTeamByProject.set(
      project.id,
      (committedTeamByProject.get(project.id) ?? 0) + toEgp(position.committedMinor),
    );
    accruedByProject.set(
      project.id,
      (accruedByProject.get(project.id) ?? 0) + toEgp(position.dueMinor),
    );
    if (assignmentRaisesAlerts({
      archived: a.archived_at !== null,
      personArchived: a.person_archived_at !== null,
      dueMinor: position.dueMinor,
    })) {
      teamPayables.push({
        assignmentId: a.id,
        personId: a.person_id,
        personName: a.person_name,
        projectId: project.id,
        projectName: project.name,
        projectCode: project.code,
        currency: a.currency,
        dueMinor: position.dueMinor,
        dueEgp: toEgp(position.dueMinor),
        // A cancelled assignment owes a frozen balance, not further stages.
        dueTitles: a.lifecycle_status === "CANCELLED" ? [] : payout.dueTitles,
      });
    }
  }
  teamPayables.sort((a, b) => b.dueEgp - a.dueEgp);

  // analytical labor cost per project: Σ (minutes × person hourly rate),
  // each entry converted to EGP at the person currency's stored rate
  const rateByCurrency = new Map<string, number>([["EGP", 1_000_000]]);
  for (const c of await read<{ code: string; fx_rate_micro: number }>("SELECT code, fx_rate_micro FROM currencies")) {
    rateByCurrency.set(c.code, c.fx_rate_micro);
  }
  const laborRows = await read<{ project_id: number; minutes: number; hourly_rate_minor: number | null; currency: string }>(
    `SELECT te.project_id, te.minutes, pe.hourly_rate_minor, pe.currency
     FROM time_entries te
     JOIN people pe ON pe.id=te.person_id
     JOIN projects p ON p.id=te.project_id
     WHERE p.archived_at IS NULL`,
  );
  const laborByProjectEgp = new Map<number, number>();
  for (const row of laborRows) {
    const costMinor = laborCostMinor(row.minutes, row.hourly_rate_minor);
    if (costMinor === 0) continue;
    const egp = toEgpPiasters(costMinor, row.currency, rateByCurrency.get(row.currency) ?? 1_000_000);
    laborByProjectEgp.set(row.project_id, (laborByProjectEgp.get(row.project_id) ?? 0) + egp);
  }

  const nonTeamExpenseByProject = new Map<number, number>();
  for (const row of await read<{ project_id: number; amount_minor: number; currency: string; fx_rate_micro: number }>(
    `SELECT e.project_id,e.amount_minor,e.currency,e.fx_rate_micro FROM expenses e
     JOIN projects p ON p.id=e.project_id
     WHERE e.project_id IS NOT NULL AND e.person_payment_id IS NULL
       AND e.voided_at IS NULL AND e.archived_at IS NULL AND p.archived_at IS NULL`,
  )) {
    const egp = toEgpPiasters(row.amount_minor, row.currency, row.fx_rate_micro);
    nonTeamExpenseByProject.set(row.project_id, (nonTeamExpenseByProject.get(row.project_id) ?? 0) + egp);
  }
  const costsByProject = new Map<number, ProjectCostProfile>();
  for (const financial of projectFinancials) {
    const project = financial.project;
    costsByProject.set(project.id, computeProjectCostProfile({
      projectId: project.id,
      recognizedRevenueEgp: financial.revenueEgp,
      forecastRevenueEgp: financial.contractValueEgp,
      actualCashInEgp: cashInByProjectEgp.get(project.id) ?? 0,
      actualPaidCostEgp: financial.expensesEgp,
      accruedCostEgp: accruedByProject.get(project.id) ?? 0,
      committedCostEgp: (committedTeamByProject.get(project.id) ?? 0) + (nonTeamExpenseByProject.get(project.id) ?? 0),
    }));
  }

  return {
    projects: projectFinancials,
    contractStates,
    allExpenses: expenses,
    cashIn,
    readyToCollect,
    teamPayables,
    teamAccounts,
    laborByProjectEgp,
    costsByProject,
  };
}

export async function loadWorkspaceFinancialsConsistently(
  read: FinancialSelect,
  maxAttempts = 3,
): Promise<WorkspaceFinancials> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const before = await financialReadRevision(read);
    const workspace = await loadWorkspaceFinancialsOnce(read);
    const after = await financialReadRevision(read);
    if (before === after) return workspace;
  }
  throw new Error("FINANCIAL_SNAPSHOT_BUSY");
}

/** Load a revision-consistent financial snapshot from the pooled SQLite connection. */
export function loadWorkspaceFinancials(): Promise<WorkspaceFinancials> {
  return loadWorkspaceFinancialsConsistently(select);
}

export function useWorkspaceFinancials() {
  return useQuery({ queryKey: ["financials"], queryFn: loadWorkspaceFinancials });
}

/** Contract state for a single contract (certificate editor, contract card). */
export function useContractState(contractId: number) {
  return useQuery({
    queryKey: ["financials", "contract", contractId],
    queryFn: async () => {
      const ws = await loadWorkspaceFinancials();
      return ws.contractStates.get(contractId) ?? null;
    },
  });
}
