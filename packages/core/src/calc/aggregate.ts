import type { Expense, Project, ProjectAssignment, PersonPayment } from "../domain/types";
import { ratioBp, toEgpPiasters } from "../money/money";
import type { ContractState } from "./contract";

/**
 * Cross-currency rollups. Everything here is consolidated to EGP piasters
 * using each project's / expense's stored FX rate.
 */

export interface ProjectFinancials {
  project: Project;
  contracts: ContractState[];

  // In project currency:
  contractValueMinor: number;
  certifiedBaseMinor: number;
  totalDueMinor: number;
  totalPaidMinor: number;
  outstandingMinor: number;
  retentionHeldMinor: number;
  certifiedRatioBp: number;
  collectionRatioBp: number;

  // Consolidated to EGP piasters:
  contractValueEgp: number;
  revenueEgp: number; // certified base (excl. VAT)
  collectedEgp: number;
  outstandingEgp: number;
  expensesEgp: number; // direct project expenses
  profitEgp: number; // revenue − direct expenses
  marginBp: number;
  overdueCertificates: number;
}

export function computeProjectFinancials(
  project: Project,
  contractStates: ContractState[],
  projectExpenses: Expense[],
): ProjectFinancials {
  const contractValue = sum(contractStates.map((c) => c.contract.valueMinor));
  const certifiedBase = sum(contractStates.map((c) => c.certifiedBaseMinor));
  const totalDue = sum(contractStates.map((c) => c.totalDueMinor));
  const totalPaid = sum(contractStates.map((c) => c.totalPaidMinor));
  const retentionHeld = sum(contractStates.map((c) => c.retentionHeldMinor));

  const toEgp = (minor: number) => toEgpPiasters(minor, project.currency, project.fxRateMicro);
  const expensesEgp = sum(projectExpenses.map((e) => toEgpPiasters(e.amountMinor, e.currency, e.fxRateMicro)));
  const revenueEgp = toEgp(certifiedBase);
  const profitEgp = revenueEgp - expensesEgp;

  return {
    project,
    contracts: contractStates,
    contractValueMinor: contractValue,
    certifiedBaseMinor: certifiedBase,
    totalDueMinor: totalDue,
    totalPaidMinor: totalPaid,
    outstandingMinor: totalDue - totalPaid,
    retentionHeldMinor: retentionHeld,
    certifiedRatioBp: ratioBp(certifiedBase, contractValue),
    collectionRatioBp: ratioBp(totalPaid, totalDue),
    contractValueEgp: toEgp(contractValue),
    revenueEgp,
    collectedEgp: toEgp(totalPaid),
    outstandingEgp: toEgp(totalDue - totalPaid),
    expensesEgp,
    profitEgp,
    marginBp: ratioBp(profitEgp, revenueEgp),
    overdueCertificates: sum(contractStates.map((c) => c.certificates.filter((s) => s.overdue).length)),
  };
}

export interface ClientFinancials {
  clientId: number;
  projectCount: number;
  contractValueEgp: number;
  collectedEgp: number;
  outstandingEgp: number;
}

export function computeClientFinancials(clientId: number, projects: ProjectFinancials[]): ClientFinancials {
  const own = projects.filter((p) => p.project.clientId === clientId);
  return {
    clientId,
    projectCount: own.length,
    contractValueEgp: sum(own.map((p) => p.contractValueEgp)),
    collectedEgp: sum(own.map((p) => p.collectedEgp)),
    outstandingEgp: sum(own.map((p) => p.outstandingEgp)),
  };
}

export interface DashboardKpis {
  contractValueEgp: number;
  revenueEgp: number;
  collectedEgp: number;
  outstandingEgp: number;
  expensesEgp: number; // ALL expenses incl. overhead
  profitEgp: number; // revenue − all expenses
  marginBp: number;
  activeProjects: number;
  completedProjects: number;
  overdueCertificates: number;
}

export function computeDashboardKpis(projects: ProjectFinancials[], allExpenses: Expense[]): DashboardKpis {
  const expensesEgp = sum(allExpenses.map((e) => toEgpPiasters(e.amountMinor, e.currency, e.fxRateMicro)));
  const revenueEgp = sum(projects.map((p) => p.revenueEgp));
  const profitEgp = revenueEgp - expensesEgp;
  return {
    contractValueEgp: sum(projects.map((p) => p.contractValueEgp)),
    revenueEgp,
    collectedEgp: sum(projects.map((p) => p.collectedEgp)),
    outstandingEgp: sum(projects.map((p) => p.outstandingEgp)),
    expensesEgp,
    profitEgp,
    marginBp: ratioBp(profitEgp, revenueEgp),
    activeProjects: projects.filter((p) => p.project.status === "ACTIVE").length,
    completedProjects: projects.filter((p) => p.project.status === "COMPLETED").length,
    overdueCertificates: sum(projects.map((p) => p.overdueCertificates)),
  };
}

export interface AssignmentAccount {
  assignment: ProjectAssignment;
  paidMinor: number;
  remainingMinor: number;
  paidRatioBp: number;
}

export function computeAssignmentAccount(
  assignment: ProjectAssignment,
  payments: PersonPayment[],
): AssignmentAccount {
  const paid = sum(payments.filter((p) => p.assignmentId === assignment.id).map((p) => p.amountMinor));
  return {
    assignment,
    paidMinor: paid,
    remainingMinor: assignment.agreedMinor - paid,
    paidRatioBp: ratioBp(paid, assignment.agreedMinor),
  };
}

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}
