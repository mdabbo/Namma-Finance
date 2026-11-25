import type { Expense, Project, ProjectAssignment, PersonPayment } from "../domain/types";
import { isBillable } from "../domain/types";
import { ratioBp } from "../money/money";
import type { CurrencyValuation } from "../money/currencyValuation";
import type { ContractState } from "./contract";

/**
 * Cross-currency rollups.
 *
 * Every consolidated figure is a sum of source amounts valued by the caller's
 * `CurrencyValuation` — see money/currencyValuation.ts for why the currency decision is made
 * per record rather than after summing.
 *
 * NAMING: the consolidated fields carry a `Reporting` suffix (they were named
 * `…Egp` until plan step C2). They hold amounts in `valuation.currency`:
 * EGP piasters under EGP_VALUATION, the reporting currency's minor units
 * otherwise. Never convert them again.
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
  contractValueReporting: number;
  revenueReporting: number; // certified base (excl. VAT)
  billableRevenueReporting: number;
  invoicedAmountReporting: number;
  /** @deprecated Use certificateCollectionsReporting. */
  collectedReporting: number;
  certificateCollectionsReporting: number;
  advanceReceivedReporting: number;
  retentionReleasedReporting: number;
  totalActualCashInReporting: number;
  unallocatedCustomerCreditReporting: number;
  outstandingReporting: number;
  expensesReporting: number; // direct project expenses
  profitReporting: number; // revenue − direct expenses
  marginBp: number;
  overdueCertificates: number;
}

export interface ProjectCashValuationReporting {
  certificateCollectionsReporting: number;
  advanceReceivedReporting: number;
  retentionReleasedReporting: number;
  totalActualCashInReporting: number;
  unallocatedCustomerCreditReporting: number;
}

/**
 * Cash valuation is REQUIRED. It used to be optional, and the fallback valued
 * certificate collections at each certificate's FX snapshot while the other
 * cash components used the project rate — so the four components stopped
 * summing to the headline total, which is the one thing the dashboard promises
 * about them. Callers build it with `computeProjectCashValuation`.
 */
export function computeProjectFinancials(
  project: Project,
  contractStates: ContractState[],
  projectExpenses: Expense[],
  cashValuation: ProjectCashValuationReporting,
  valuation: CurrencyValuation,
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

  const toReporting = (minor: number) => valuation.value(minor, project.currency, project.fxRateMicro);
  const certificateReporting = (
    pick: (state: ContractState["certificates"][number]) => number,
    billableOnly: boolean,
  ) => sum(contractStates.flatMap((contractState) =>
    contractState.certificates
      .filter((state) => !billableOnly || isBillable(state.certificate.status))
      .map((state) => valuation.value(
        pick(state),
        state.certificate.currencySnapshot ?? project.currency,
        state.certificate.fxRateMicroSnapshot ?? project.fxRateMicro,
      )),
  ));
  const expensesReporting = sum(projectExpenses.map((e) => valuation.value(e.amountMinor, e.currency, e.fxRateMicro)));
  const revenueReporting = certificateReporting((state) => state.breakdown.baseMinor, true);
  const invoicedAmountReporting = certificateReporting((state) => state.breakdown.netPayableMinor, true);
  const outstandingReporting = certificateReporting((state) => state.unpaidMinor, true);
  const profitReporting = revenueReporting - expensesReporting;

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
    contractValueReporting: toReporting(contractValue),
    revenueReporting,
    billableRevenueReporting: certificateReporting((state) => state.breakdown.baseMinor, false),
    invoicedAmountReporting,
    collectedReporting: cashValuation.certificateCollectionsReporting,
    certificateCollectionsReporting: cashValuation.certificateCollectionsReporting,
    advanceReceivedReporting: cashValuation.advanceReceivedReporting,
    retentionReleasedReporting: cashValuation.retentionReleasedReporting,
    totalActualCashInReporting: cashValuation.totalActualCashInReporting,
    unallocatedCustomerCreditReporting: cashValuation.unallocatedCustomerCreditReporting,
    outstandingReporting,
    expensesReporting,
    profitReporting,
    marginBp: ratioBp(profitReporting, revenueReporting),
    overdueCertificates: sum(contractStates.map((c) => c.certificates.filter((s) => s.overdue).length)),
  };
}

export interface ClientFinancials {
  clientId: number;
  projectCount: number;
  contractValueReporting: number;
  collectedReporting: number;
  certificateCollectionsReporting: number;
  advanceReceivedReporting: number;
  retentionReleasedReporting: number;
  totalActualCashInReporting: number;
  unallocatedCustomerCreditReporting: number;
  outstandingReporting: number;
}

export function computeClientFinancials(clientId: number, projects: ProjectFinancials[]): ClientFinancials {
  const own = projects.filter((p) => p.project.clientId === clientId);
  return {
    clientId,
    projectCount: own.length,
    contractValueReporting: sum(own.map((p) => p.contractValueReporting)),
    collectedReporting: sum(own.map((p) => p.collectedReporting)),
    certificateCollectionsReporting: sum(own.map((p) => p.certificateCollectionsReporting)),
    advanceReceivedReporting: sum(own.map((p) => p.advanceReceivedReporting)),
    retentionReleasedReporting: sum(own.map((p) => p.retentionReleasedReporting)),
    totalActualCashInReporting: sum(own.map((p) => p.totalActualCashInReporting)),
    unallocatedCustomerCreditReporting: sum(own.map((p) => p.unallocatedCustomerCreditReporting)),
    outstandingReporting: sum(own.map((p) => p.outstandingReporting)),
  };
}

export interface DashboardKpis {
  contractValueReporting: number;
  revenueReporting: number;
  collectedReporting: number;
  certificateCollectionsReporting: number;
  advanceReceivedReporting: number;
  retentionReleasedReporting: number;
  totalActualCashInReporting: number;
  unallocatedCustomerCreditReporting: number;
  outstandingReporting: number;
  expensesReporting: number; // ALL expenses incl. overhead
  profitReporting: number; // revenue − all expenses
  marginBp: number;
  activeProjects: number;
  completedProjects: number;
  overdueCertificates: number;
}

export function computeDashboardKpis(
  projects: ProjectFinancials[],
  allExpenses: Expense[],
  valuation: CurrencyValuation,
): DashboardKpis {
  const expensesReporting = sum(allExpenses.map((e) => valuation.value(e.amountMinor, e.currency, e.fxRateMicro)));
  const revenueReporting = sum(projects.map((p) => p.revenueReporting));
  const profitReporting = revenueReporting - expensesReporting;
  return {
    contractValueReporting: sum(projects.map((p) => p.contractValueReporting)),
    revenueReporting,
    collectedReporting: sum(projects.map((p) => p.collectedReporting)),
    certificateCollectionsReporting: sum(projects.map((p) => p.certificateCollectionsReporting)),
    advanceReceivedReporting: sum(projects.map((p) => p.advanceReceivedReporting)),
    retentionReleasedReporting: sum(projects.map((p) => p.retentionReleasedReporting)),
    totalActualCashInReporting: sum(projects.map((p) => p.totalActualCashInReporting)),
    unallocatedCustomerCreditReporting: sum(projects.map((p) => p.unallocatedCustomerCreditReporting)),
    outstandingReporting: sum(projects.map((p) => p.outstandingReporting)),
    expensesReporting,
    profitReporting,
    marginBp: ratioBp(profitReporting, revenueReporting),
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
