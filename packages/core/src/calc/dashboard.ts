import type { CertificateStatus, Expense, ProjectStatus } from "../domain/types";
import { isBillable } from "../domain/types";
import { toEgpPiasters } from "../money/money";
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
 * exactly one of them — so they sum to totalCashInEgp with nothing double
 * counted. `dashboardCashInComponentsReconcile` asserts that.
 */
export interface DashboardOverview {
  contractValueEgp: number;
  /** All live incoming payments: collections, advances, retention, credit. */
  totalCashInEgp: number;
  /** Payment money actually allocated to certificates. */
  certificateCollectionsEgp: number;
  advanceReceivedEgp: number;
  retentionReleasedEgp: number;
  /** Certificate-payment cash received but not yet allocated to a certificate. */
  unallocatedCustomerCreditEgp: number;
  outstandingReceivablesEgp: number;
  cashOutEgp: number;
  /** Total actual cash in less actual cash out. */
  netCashPositionEgp: number;
}

export interface DashboardAttentionSummary {
  overdueCertificates: { count: number; amountEgp: number };
  readyToInvoice: { count: number; amountEgp: number };
  unallocatedPayments: { count: number; amountEgp: number };
  teamPaymentsDue: { count: number; amountEgp: number };
}

export interface DashboardAttentionInput {
  contracts: readonly {
    state: ContractState;
    projectCurrency: string;
    projectFxRateMicro: number;
  }[];
  projects: readonly ProjectFinancials[];
  readyToInvoiceEgp: readonly number[];
  teamPaymentsDueEgp: readonly number[];
}

/** Derive alert counts and amounts without allowing the view to control financial facts. */
export function computeDashboardAttention(input: DashboardAttentionInput): DashboardAttentionSummary {
  let overdueCount = 0;
  let overdueAmountEgp = 0;
  let unallocatedCount = 0;
  for (const { state, projectCurrency, projectFxRateMicro } of input.contracts) {
    if (state.unallocatedCustomerCreditMinor > 0) unallocatedCount += 1;
    for (const certificate of state.certificates) {
      if (!certificate.overdue || certificate.unpaidMinor <= 0) continue;
      overdueCount += 1;
      overdueAmountEgp += toEgpPiasters(
        certificate.unpaidMinor,
        certificate.certificate.currencySnapshot ?? projectCurrency,
        certificate.certificate.fxRateMicroSnapshot ?? projectFxRateMicro,
      );
    }
  }
  return {
    overdueCertificates: { count: overdueCount, amountEgp: overdueAmountEgp },
    readyToInvoice: {
      count: input.readyToInvoiceEgp.length,
      amountEgp: sum([...input.readyToInvoiceEgp]),
    },
    unallocatedPayments: {
      count: unallocatedCount,
      amountEgp: sum(input.projects.map((project) => project.unallocatedCustomerCreditEgp)),
    },
    teamPaymentsDue: {
      count: input.teamPaymentsDueEgp.length,
      amountEgp: sum([...input.teamPaymentsDueEgp]),
    },
  };
}

/** Derive the overview facts from EGP-valued core aggregates only. */
export function computeDashboardOverview(
  projects: ProjectFinancials[],
  expenses: Expense[],
): DashboardOverview {
  const contractValueEgp = sum(projects.map((project) => project.contractValueEgp));
  const totalCashInEgp = sum(projects.map((project) => project.totalActualCashInEgp));
  const outstandingReceivablesEgp = sum(projects.map((project) => project.outstandingEgp));
  const cashOutEgp = sum(expenses.map((expense) =>
    toEgpPiasters(expense.amountMinor, expense.currency, expense.fxRateMicro)));
  return {
    contractValueEgp,
    totalCashInEgp,
    certificateCollectionsEgp: sum(projects.map((project) => project.certificateCollectionsEgp)),
    advanceReceivedEgp: sum(projects.map((project) => project.advanceReceivedEgp)),
    retentionReleasedEgp: sum(projects.map((project) => project.retentionReleasedEgp)),
    unallocatedCustomerCreditEgp: sum(projects.map((project) => project.unallocatedCustomerCreditEgp)),
    outstandingReceivablesEgp,
    cashOutEgp,
    netCashPositionEgp: totalCashInEgp - cashOutEgp,
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
    overview.certificateCollectionsEgp
    + overview.advanceReceivedEgp
    + overview.retentionReleasedEgp
    + overview.unallocatedCustomerCreditEgp
  ) === overview.totalCashInEgp;
}

export interface DashboardCashIn {
  date: string;
  egpMinor: number;
}

export interface MonthlyCashPoint {
  month: string;
  cashInEgp: number;
  cashOutEgp: number;
  netEgp: number;
}

/** Build a display series from immutable source rows while retaining integer piasters. */
export function buildMonthlyCashSeries(
  cashIn: readonly DashboardCashIn[],
  expenses: readonly Expense[],
): MonthlyCashPoint[] {
  const buckets = new Map<string, { cashInEgp: number; cashOutEgp: number }>();
  const bucket = (date: string) => {
    const month = date.slice(0, 7);
    const current = buckets.get(month) ?? { cashInEgp: 0, cashOutEgp: 0 };
    buckets.set(month, current);
    return current;
  };
  for (const payment of cashIn) bucket(payment.date).cashInEgp += payment.egpMinor;
  for (const expense of expenses) {
    bucket(expense.date).cashOutEgp += toEgpPiasters(
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
      netEgp: amounts.cashInEgp - amounts.cashOutEgp,
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
  unpaidEgp: number;
}

/**
 * Every billable certificate with money still owed by the client, valued at
 * its own commercial FX snapshot. The workspace receivables surface and the
 * dashboard overdue alert both derive from this single selection.
 */
export function selectOpenReceivables(contracts: readonly FinanceContractInput[]): ReceivableCertificate[] {
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
        unpaidEgp: toEgpPiasters(
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
  totalEgp: number;
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
    totalEgp: sum(items.map((item) => item.unpaidEgp)),
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
    .sort((left, right) => right.contractValueEgp - left.contractValueEgp)
    .slice(0, Math.max(0, limit));
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
