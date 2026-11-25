import type { CertificateStatus, Expense, ProjectStatus } from "../domain/types";
import { isBillable } from "../domain/types";
import type { CurrencyValuation } from "../money/currencyValuation";
import type { ProjectFinancials } from "./aggregate";
import type { ContractState } from "./contract";

/**
 * Headline cash is reported as TOTAL CASH IN, never as "collected".
 *
 * Every incoming payment record counts toward the headline, but only some of it
 * is money collected against certificates: advances, retention releases and
 * customer money not yet allocated are cash in hand without being a collection.
 * Labelling the total "Cash Collected" overstated certificate collection, so the
 * total is named for what it measures and the components are reported beside it.
 *
 * The four components partition the total exactly — each live inflow lands in
 * exactly one of them — so they sum to totalCashInReporting with nothing double
 * counted. `dashboardCashInComponentsReconcile` asserts that.
 */
export interface DashboardOverview {
  contractValueReporting: number;
  /** All live incoming payments: collections, advances, retention, credit. */
  totalCashInReporting: number;
  /** Payment money actually allocated to certificates. */
  certificateCollectionsReporting: number;
  advanceReceivedReporting: number;
  retentionReleasedReporting: number;
  /** Certificate-payment cash received but not yet allocated to a certificate. */
  unallocatedCustomerCreditReporting: number;
  outstandingReceivablesReporting: number;
  cashOutReporting: number;
  /** Total actual cash in less actual cash out. */
  netCashPositionReporting: number;
}

export interface DashboardAttentionSummary {
  overdueCertificates: { count: number; amountReporting: number };
  readyToInvoice: { count: number; amountReporting: number };
  unallocatedPayments: { count: number; amountReporting: number };
  teamPaymentsDue: { count: number; amountReporting: number };
}

export interface DashboardAttentionInput {
  contracts: readonly {
    state: ContractState;
    projectCurrency: string;
    projectFxRateMicro: number;
  }[];
  projects: readonly ProjectFinancials[];
  readyToInvoiceReporting: readonly number[];
  teamPaymentsDueReporting: readonly number[];
}

/** Derive alert counts and amounts without allowing the view to control financial facts. */
export function computeDashboardAttention(
  input: DashboardAttentionInput,
  valuation: CurrencyValuation,
): DashboardAttentionSummary {
  let overdueCount = 0;
  let overdueAmountReporting = 0;
  let unallocatedCount = 0;
  for (const { state, projectCurrency, projectFxRateMicro } of input.contracts) {
    if (state.unallocatedCustomerCreditMinor > 0) unallocatedCount += 1;
    for (const certificate of state.certificates) {
      if (!certificate.overdue || certificate.unpaidMinor <= 0) continue;
      overdueCount += 1;
      overdueAmountReporting += valuation.value(
        certificate.unpaidMinor,
        certificate.certificate.currencySnapshot ?? projectCurrency,
        certificate.certificate.fxRateMicroSnapshot ?? projectFxRateMicro,
      );
    }
  }
  return {
    overdueCertificates: { count: overdueCount, amountReporting: overdueAmountReporting },
    readyToInvoice: {
      count: input.readyToInvoiceReporting.length,
      amountReporting: sum([...input.readyToInvoiceReporting]),
    },
    unallocatedPayments: {
      count: unallocatedCount,
      amountReporting: sum(input.projects.map((project) => project.unallocatedCustomerCreditReporting)),
    },
    teamPaymentsDue: {
      count: input.teamPaymentsDueReporting.length,
      amountReporting: sum([...input.teamPaymentsDueReporting]),
    },
  };
}

/**
 * Derive the overview facts from core aggregates only. `projects` must have
 * been built with the same valuation, or the totals mix two currencies.
 */
export function computeDashboardOverview(
  projects: ProjectFinancials[],
  expenses: Expense[],
  valuation: CurrencyValuation,
): DashboardOverview {
  const contractValueReporting = sum(projects.map((project) => project.contractValueReporting));
  const totalCashInReporting = sum(projects.map((project) => project.totalActualCashInReporting));
  const outstandingReceivablesReporting = sum(projects.map((project) => project.outstandingReporting));
  const cashOutReporting = sum(expenses.map((expense) =>
    valuation.value(expense.amountMinor, expense.currency, expense.fxRateMicro)));
  return {
    contractValueReporting,
    totalCashInReporting,
    certificateCollectionsReporting: sum(projects.map((project) => project.certificateCollectionsReporting)),
    advanceReceivedReporting: sum(projects.map((project) => project.advanceReceivedReporting)),
    retentionReleasedReporting: sum(projects.map((project) => project.retentionReleasedReporting)),
    unallocatedCustomerCreditReporting: sum(projects.map((project) => project.unallocatedCustomerCreditReporting)),
    outstandingReceivablesReporting,
    cashOutReporting,
    netCashPositionReporting: totalCashInReporting - cashOutReporting,
  };
}

/**
 * Whether the reported components account for the headline total exactly.
 *
 * The dashboard shows the total and its parts side by side, so a shortfall or an
 * overlap would be visible as money that appeared or vanished between them.
 */
export function dashboardCashInComponentsReconcile(overview: DashboardOverview): boolean {
  return (
    overview.certificateCollectionsReporting
    + overview.advanceReceivedReporting
    + overview.retentionReleasedReporting
    + overview.unallocatedCustomerCreditReporting
  ) === overview.totalCashInReporting;
}

export interface DashboardCashIn {
  date: string;
  egpMinor: number;
}

export interface MonthlyCashPoint {
  month: string;
  cashInReporting: number;
  cashOutReporting: number;
  netReporting: number;
}

/** Build a display series from immutable source rows while retaining integer piasters. */
export function buildMonthlyCashSeries(
  cashIn: readonly DashboardCashIn[],
  expenses: readonly Expense[],
  valuation: CurrencyValuation,
): MonthlyCashPoint[] {
  const buckets = new Map<string, { cashInReporting: number; cashOutReporting: number }>();
  const bucket = (date: string) => {
    const month = date.slice(0, 7);
    const current = buckets.get(month) ?? { cashInReporting: 0, cashOutReporting: 0 };
    buckets.set(month, current);
    return current;
  };
  for (const payment of cashIn) bucket(payment.date).cashInReporting += payment.egpMinor;
  for (const expense of expenses) {
    bucket(expense.date).cashOutReporting += valuation.value(
      expense.amountMinor,
      expense.currency,
      expense.fxRateMicro,
    );
  }
  return [...buckets.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(-12)
    .map(([month, amounts]) => ({
      month,
      ...amounts,
      netReporting: amounts.cashInReporting - amounts.cashOutReporting,
    }));
}

export interface EffectiveFxSnapshot {
  effectiveDate: string;
  revisionNumber: number;
  currency: string;
  fxRateMicro: number;
}

/**
 * Select the approved commercial FX terms effective on a source record's date.
 * An earlier-than-initial legacy row falls back to the earliest approved terms.
 */
export function resolveEffectiveFxSnapshot(
  snapshots: readonly EffectiveFxSnapshot[],
  date: string,
  fallback: Pick<EffectiveFxSnapshot, "currency" | "fxRateMicro">,
): Pick<EffectiveFxSnapshot, "currency" | "fxRateMicro"> {
  const ordered = [...snapshots].sort((left, right) =>
    left.effectiveDate.localeCompare(right.effectiveDate)
    || left.revisionNumber - right.revisionNumber);
  const eligible = ordered.filter((snapshot) => snapshot.effectiveDate <= date);
  const effective = eligible[eligible.length - 1];
  const selected = effective ?? ordered[0];
  return selected
    ? { currency: selected.currency, fxRateMicro: selected.fxRateMicro }
    : fallback;
}

export interface FinanceContractInput {
  state: ContractState;
  projectCurrency: string;
  projectFxRateMicro: number;
}

export interface ReceivableCertificate {
  certificateId: number;
  certificateNumber: string;
  contractId: number;
  contractNumber: string;
  projectId: number;
  status: CertificateStatus;
  dueDate: string | null;
  overdue: boolean;
  currency: string;
  unpaidMinor: number;
  unpaidReporting: number;
}

/**
 * Every billable certificate with money still owed by the client, valued at
 * its own commercial FX snapshot. The workspace receivables surface and the
 * dashboard overdue alert both derive from this single selection.
 */
export function selectOpenReceivables(
  contracts: readonly FinanceContractInput[],
  valuation: CurrencyValuation,
): ReceivableCertificate[] {
  const rows: ReceivableCertificate[] = [];
  for (const { state, projectCurrency, projectFxRateMicro } of contracts) {
    for (const certificate of state.certificates) {
      if (!isBillable(certificate.certificate.status) || certificate.unpaidMinor <= 0) continue;
      const currency = certificate.certificate.currencySnapshot ?? projectCurrency;
      rows.push({
        certificateId: certificate.certificate.id,
        certificateNumber: certificate.certificate.number,
        contractId: state.contract.id,
        contractNumber: state.contract.number,
        projectId: state.contract.projectId,
        status: certificate.certificate.status,
        dueDate: certificate.dueDate,
        overdue: certificate.overdue,
        currency,
        unpaidMinor: certificate.unpaidMinor,
        unpaidReporting: valuation.value(
          certificate.unpaidMinor,
          currency,
          certificate.certificate.fxRateMicroSnapshot ?? projectFxRateMicro,
        ),
      });
    }
  }
  return rows.sort((left, right) =>
    (left.dueDate ?? "9999-12-31").localeCompare(right.dueDate ?? "9999-12-31")
    || left.certificateId - right.certificateId);
}

export interface UpcomingCollections {
  items: ReceivableCertificate[];
  totalReporting: number;
  horizonEndIso: string;
}

function addDaysIso(dateIso: string, days: number): string {
  const [y, m, d] = dateIso.split("-").map(Number);
  const date = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * Receivables the office should expect to collect within the horizon:
 * not yet overdue, with a due date on or before the horizon end. Overdue
 * amounts stay in the overdue alert instead of being double-forecast.
 */
export function selectUpcomingCollections(
  receivables: readonly ReceivableCertificate[],
  todayIso: string,
  horizonDays = 60,
): UpcomingCollections {
  const horizonEndIso = addDaysIso(todayIso, Math.max(0, horizonDays));
  const items = receivables.filter((item) =>
    !item.overdue && item.dueDate !== null && item.dueDate <= horizonEndIso);
  return {
    items,
    totalReporting: sum(items.map((item) => item.unpaidReporting)),
    horizonEndIso,
  };
}

/** Completed/cancelled projects remain in finance, but not operational health. */
export function selectOperationalProjectHealth(
  projects: ProjectFinancials[],
  limit = 5,
): ProjectFinancials[] {
  const operational = new Set<ProjectStatus>(["ACTIVE", "ON_HOLD"]);
  return projects
    .filter(({ project }) => operational.has(project.status))
    .sort((left, right) => right.contractValueReporting - left.contractValueReporting)
    .slice(0, Math.max(0, limit));
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
