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
  billableRevenueMinor: number;
  invoicedAmountMinor: number;
  totalDueMinor: number;
  /** @deprecated Use certificateCollectionsMinor. */
  totalPaidMinor: number;
  certificateCollectionsMinor: number;
  advanceReceivedMinor: number;
  retentionReleasedMinor: number;
  totalActualCashInMinor: number;
  unallocatedCustomerCreditMinor: number;
  outstandingMinor: number;
  outstandingReceivablesMinor: number;
  remainingUncertifiedMinor: number;
  retentionHeldMinor: number;
  certifiedRatioBp: number;
  collectionRatioBp: number;

  // Consolidated to EGP piasters:
  contractValueEgp: number;
  revenueEgp: number; // certified base (excl. VAT)
  billableRevenueEgp: number;
  invoicedAmountEgp: number;
  /** @deprecated Use certificateCollectionsEgp. */
  collectedEgp: number;
  certificateCollectionsEgp: number;
  advanceReceivedEgp: number;
  retentionReleasedEgp: number;
  totalActualCashInEgp: number;
  unallocatedCustomerCreditEgp: number;
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
  const billableRevenue = sum(contractStates.map((c) => c.billableRevenueMinor));
  const invoicedAmount = sum(contractStates.map((c) => c.invoicedAmountMinor));
  const totalDue = sum(contractStates.map((c) => c.totalDueMinor));
  const totalPaid = sum(contractStates.map((c) => c.totalPaidMinor));
  const advanceReceived = sum(contractStates.map((c) => c.advanceReceivedMinor));
  const retentionReleased = sum(contractStates.map((c) => c.retentionReleasedMinor));
  const totalActualCashIn = sum(contractStates.map((c) => c.totalActualCashInMinor));
  const unallocatedCustomerCredit = sum(contractStates.map((c) => c.unallocatedCustomerCreditMinor));
  const remainingUncertified = sum(contractStates.map((c) => c.remainingUncertifiedMinor));
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
    billableRevenueMinor: billableRevenue,
    invoicedAmountMinor: invoicedAmount,
    totalDueMinor: totalDue,
    totalPaidMinor: totalPaid,
    certificateCollectionsMinor: totalPaid,
    advanceReceivedMinor: advanceReceived,
    retentionReleasedMinor: retentionReleased,
    totalActualCashInMinor: totalActualCashIn,
    unallocatedCustomerCreditMinor: unallocatedCustomerCredit,
    outstandingMinor: totalDue - totalPaid,
    outstandingReceivablesMinor: totalDue - totalPaid,
    remainingUncertifiedMinor: remainingUncertified,
    retentionHeldMinor: retentionHeld,
    certifiedRatioBp: ratioBp(certifiedBase, contractValue),
    collectionRatioBp: ratioBp(totalPaid, totalDue),
    contractValueEgp: toEgp(contractValue),
    revenueEgp,
    billableRevenueEgp: toEgp(billableRevenue),
    invoicedAmountEgp: toEgp(invoicedAmount),
    collectedEgp: toEgp(totalPaid),
    certificateCollectionsEgp: toEgp(totalPaid),
    advanceReceivedEgp: toEgp(advanceReceived),
    retentionReleasedEgp: toEgp(retentionReleased),
    totalActualCashInEgp: toEgp(totalActualCashIn),
    unallocatedCustomerCreditEgp: toEgp(unallocatedCustomerCredit),
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
  certificateCollectionsEgp: number;
  advanceReceivedEgp: number;
  retentionReleasedEgp: number;
  totalActualCashInEgp: number;
  unallocatedCustomerCreditEgp: number;
  outstandingEgp: number;
}

export function computeClientFinancials(clientId: number, projects: ProjectFinancials[]): ClientFinancials {
  const own = projects.filter((p) => p.project.clientId === clientId);
  return {
    clientId,
    projectCount: own.length,
    contractValueEgp: sum(own.map((p) => p.contractValueEgp)),
    collectedEgp: sum(own.map((p) => p.collectedEgp)),
    certificateCollectionsEgp: sum(own.map((p) => p.certificateCollectionsEgp)),
    advanceReceivedEgp: sum(own.map((p) => p.advanceReceivedEgp)),
    retentionReleasedEgp: sum(own.map((p) => p.retentionReleasedEgp)),
    totalActualCashInEgp: sum(own.map((p) => p.totalActualCashInEgp)),
    unallocatedCustomerCreditEgp: sum(own.map((p) => p.unallocatedCustomerCreditEgp)),
    outstandingEgp: sum(own.map((p) => p.outstandingEgp)),
  };
}

export interface DashboardKpis {
  contractValueEgp: number;
  revenueEgp: number;
  collectedEgp: number;
  certificateCollectionsEgp: number;
  advanceReceivedEgp: number;
  retentionReleasedEgp: number;
  totalActualCashInEgp: number;
  unallocatedCustomerCreditEgp: number;
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
    certificateCollectionsEgp: sum(projects.map((p) => p.certificateCollectionsEgp)),
    advanceReceivedEgp: sum(projects.map((p) => p.advanceReceivedEgp)),
    retentionReleasedEgp: sum(projects.map((p) => p.retentionReleasedEgp)),
    totalActualCashInEgp: sum(projects.map((p) => p.totalActualCashInEgp)),
    unallocatedCustomerCreditEgp: sum(projects.map((p) => p.unallocatedCustomerCreditEgp)),
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
