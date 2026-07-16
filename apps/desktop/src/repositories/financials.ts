import { useQuery } from "@tanstack/react-query";
import {
  computeContractState,
  computeProjectFinancials,
  computeReadyToBill,
  parseMilestones,
  toEgpPiasters,
  type Contract,
  type ContractState,
  type Expense,
  type PaymentAllocation,
  type ProjectFinancials,
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
  }>("SELECT * FROM expenses");
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

export interface WorkspaceFinancials {
  projects: ProjectFinancials[];
  contractStates: Map<number, ContractState>;
  allExpenses: Expense[];
  /** Every live incoming payment with its EGP-converted amount (for cash-flow charts). */
  cashIn: { date: string; egpMinor: number }[];
  /** Achieved milestones not yet certified — work the client should be billed for. */
  readyToCollect: ReadyToCollectItem[];
}

/** Load everything and compute the full financial state of the office. */
export async function loadWorkspaceFinancials(): Promise<WorkspaceFinancials> {
  const today = todayIso();
  const [projectRows, contractRows, certRows, paymentRows, allocations, expenses] = await Promise.all([
    select<ProjectRow>("SELECT p.*, c.name AS client_name FROM projects p JOIN clients c ON c.id = p.client_id"),
    select<ContractRow>("SELECT * FROM contracts"),
    select<CertificateRow>("SELECT * FROM payment_certificates WHERE deleted_at IS NULL"),
    select<PaymentRow>("SELECT * FROM payments WHERE deleted_at IS NULL"),
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
  const cashIn = payments.map((p) => {
    const project = projectByContract.get(p.contractId);
    return {
      date: p.date,
      egpMinor: project ? toEgpPiasters(p.amountMinor, project.currency, project.fxRateMicro) : p.amountMinor,
    };
  });

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

  return { projects: projectFinancials, contractStates, allExpenses: expenses, cashIn, readyToCollect };
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
