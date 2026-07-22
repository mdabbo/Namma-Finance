import { useQuery } from "@tanstack/react-query";
import {
  computeContractState,
  computeProjectFinancials,
  computeReadyToBill,
  computeProjectCostProfile,
  computeTeamPayout,
  laborCostMinor,
  parseMilestones,
  toEgpPiasters,
  type Contract,
  type ContractState,
  type Expense,
  type PaymentAllocation,
  type PaymentKind,
  type ProjectFinancials,
  type ProjectCostProfile,
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

async function loadAllocations(): Promise<PaymentAllocation[]> {
  return select<PaymentAllocation>(
    `SELECT id, payment_id AS paymentId, certificate_id AS certificateId, amount_minor AS amountMinor
     FROM payment_certificate_allocations`,
  );
}

async function loadExpenses(): Promise<Expense[]> {
  const rows = await select<{
    id: number; date: string; category_id: number; description: string; project_id: number | null;
    supplier: string | null; amount_minor: number; currency: string; fx_rate_micro: number;
    attachment_path: string | null; created_at: string;
  }>("SELECT * FROM expenses WHERE voided_at IS NULL AND archived_at IS NULL");
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

export interface WorkspaceFinancials {
  projects: ProjectFinancials[];
  contractStates: Map<number, ContractState>;
  allExpenses: Expense[];
  /** Every live incoming payment with its EGP-converted amount (for cash-flow charts). */
  cashIn: { date: string; kind: PaymentKind; projectId: number; egpMinor: number }[];
  /** Achieved milestones not yet certified — work the client should be billed for. */
  readyToCollect: ReadyToCollectItem[];
  /** Paid certificates whose team-member share has not been paid out yet. */
  teamPayables: TeamPayableItem[];
  /** Analytical labor cost per project (EGP) from logged time — costing only,
   *  deliberately NOT part of cash net profit (salaries stay overhead). */
  laborByProjectEgp: Map<number, number>;
  /** Separate cash, accrual, commitment, and forecast views by project. */
  costsByProject: Map<number, ProjectCostProfile>;
}

/** Load everything and compute the full financial state of the office. */
export async function loadWorkspaceFinancials(): Promise<WorkspaceFinancials> {
  const today = todayIso();
  const [projectRows, contractRows, certRows, paymentRows, allocations, expenses] = await Promise.all([
    select<ProjectRow>("SELECT p.*, c.name AS client_name FROM projects p JOIN clients c ON c.id = p.client_id WHERE p.archived_at IS NULL"),
    select<ContractRow>("SELECT * FROM contracts WHERE archived_at IS NULL"),
    select<CertificateRow>("SELECT * FROM payment_certificates WHERE deleted_at IS NULL AND voided_at IS NULL AND archived_at IS NULL"),
    select<PaymentRow>("SELECT * FROM payments WHERE deleted_at IS NULL AND voided_at IS NULL"),
    loadAllocations(),
    loadExpenses(),
  ]);

  const projects = projectRows.map(mapProject);
  const contracts: Contract[] = contractRows.map(mapContract);
  const certificates = certRows.map(mapCertificate);
  const payments = paymentRows.map(mapPayment);

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

  const projectFinancials = projects.map((project) =>
    computeProjectFinancials(
      project,
      contracts.filter((c) => c.projectId === project.id).map((c) => contractStates.get(c.id)!),
      expenses.filter((e) => e.projectId === project.id),
    ),
  );

  const projectByContract = new Map(contracts.map((c) => [c.id, projects.find((p) => p.id === c.projectId)]));
  const cashIn = payments.flatMap((p) => {
    const project = projectByContract.get(p.contractId);
    if (!project) return [];
    return [{
      date: p.date,
      kind: p.kind,
      projectId: project.id,
      egpMinor: toEgpPiasters(p.amountMinor, project.currency, project.fxRateMicro),
    }];
  });
  const cashInByProjectEgp = new Map<number, number>();
  for (const payment of payments) {
    const project = projectByContract.get(payment.contractId);
    if (!project) continue;
    const amountEgp = toEgpPiasters(payment.amountMinor, project.currency, project.fxRateMicro);
    cashInByProjectEgp.set(project.id, (cashInByProjectEgp.get(project.id) ?? 0) + amountEgp);
  }

  // achieved-milestone billing alerts (milestones link to completed stages or are checked manually)
  const completedStages = await select<{ id: number; project_id: number }>(
    "SELECT id, project_id FROM project_stages WHERE status = 'COMPLETED'",
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
  const assignments = await select<{
    id: number; person_id: number; project_id: number; agreed_minor: number;
    currency: string; fx_rate_micro: number; person_name: string;
  }>(
    `SELECT a.id, a.person_id, a.project_id, a.agreed_minor, a.currency, a.fx_rate_micro, pe.name AS person_name
     FROM project_assignments a JOIN people pe ON pe.id = a.person_id`,
  );
  const paidByAssignment = new Map<number, number>();
  for (const r of await select<{ assignment_id: number; paid: number }>(
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
  const projectById = new Map(projects.map((p) => [p.id, p]));
  const teamPayables: TeamPayableItem[] = [];
  for (const a of assignments) {
    const project = projectById.get(a.project_id);
    if (!project) continue;
    const payout = computeTeamPayout(
      a.agreed_minor,
      statesByProject.get(a.project_id) ?? [],
      paidByAssignment.get(a.id) ?? 0,
    );
    if (payout.dueMinor > 0) {
      teamPayables.push({
        assignmentId: a.id,
        personId: a.person_id,
        personName: a.person_name,
        projectId: project.id,
        projectName: project.name,
        projectCode: project.code,
        currency: a.currency,
        dueMinor: payout.dueMinor,
        dueEgp: toEgpPiasters(payout.dueMinor, a.currency, a.fx_rate_micro),
        dueTitles: payout.dueTitles,
      });
    }
  }
  teamPayables.sort((a, b) => b.dueEgp - a.dueEgp);

  // analytical labor cost per project: Σ (minutes × person hourly rate),
  // each entry converted to EGP at the person currency's stored rate
  const rateByCurrency = new Map<string, number>([["EGP", 1_000_000]]);
  for (const c of await select<{ code: string; fx_rate_micro: number }>("SELECT code, fx_rate_micro FROM currencies")) {
    rateByCurrency.set(c.code, c.fx_rate_micro);
  }
  const laborRows = await select<{ project_id: number; minutes: number; hourly_rate_minor: number | null; currency: string }>(
    `SELECT te.project_id, te.minutes, pe.hourly_rate_minor, pe.currency
     FROM time_entries te JOIN people pe ON pe.id = te.person_id`,
  );
  const laborByProjectEgp = new Map<number, number>();
  for (const row of laborRows) {
    const costMinor = laborCostMinor(row.minutes, row.hourly_rate_minor);
    if (costMinor === 0) continue;
    const egp = toEgpPiasters(costMinor, row.currency, rateByCurrency.get(row.currency) ?? 1_000_000);
    laborByProjectEgp.set(row.project_id, (laborByProjectEgp.get(row.project_id) ?? 0) + egp);
  }

  const nonTeamExpenseByProject = new Map<number, number>();
  for (const row of await select<{ project_id: number; amount_minor: number; currency: string; fx_rate_micro: number }>(
    `SELECT project_id,amount_minor,currency,fx_rate_micro FROM expenses
     WHERE project_id IS NOT NULL AND person_payment_id IS NULL AND voided_at IS NULL AND archived_at IS NULL`,
  )) {
    const egp = toEgpPiasters(row.amount_minor, row.currency, row.fx_rate_micro);
    nonTeamExpenseByProject.set(row.project_id, (nonTeamExpenseByProject.get(row.project_id) ?? 0) + egp);
  }
  const committedTeamByProject = new Map<number, number>();
  for (const assignment of assignments) {
    const egp = toEgpPiasters(assignment.agreed_minor, assignment.currency, assignment.fx_rate_micro);
    committedTeamByProject.set(assignment.project_id, (committedTeamByProject.get(assignment.project_id) ?? 0) + egp);
  }
  const accruedByProject = new Map<number, number>();
  for (const payable of teamPayables) {
    accruedByProject.set(payable.projectId, (accruedByProject.get(payable.projectId) ?? 0) + payable.dueEgp);
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

  return { projects: projectFinancials, contractStates, allExpenses: expenses, cashIn, readyToCollect, teamPayables, laborByProjectEgp, costsByProject };
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
