import type { Expense, ProjectStatus } from "../domain/types";
import { toEgpPiasters } from "../money/money";
import type { ProjectFinancials } from "./aggregate";
import type { ContractState } from "./contract";

export interface DashboardOverview {
  contractValueEgp: number;
  cashCollectedEgp: number;
  outstandingReceivablesEgp: number;
  cashOutEgp: number;
  netCashPositionEgp: number;
  unallocatedCustomerCreditEgp: number;
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

/** Derive the four overview facts from EGP-valued core aggregates only. */
export function computeDashboardOverview(
  projects: ProjectFinancials[],
  expenses: Expense[],
): DashboardOverview {
  const contractValueEgp = sum(projects.map((project) => project.contractValueEgp));
  const cashCollectedEgp = sum(projects.map((project) => project.totalActualCashInEgp));
  const outstandingReceivablesEgp = sum(projects.map((project) => project.outstandingEgp));
  const unallocatedCustomerCreditEgp = sum(projects.map((project) => project.unallocatedCustomerCreditEgp));
  const cashOutEgp = sum(expenses.map((expense) =>
    toEgpPiasters(expense.amountMinor, expense.currency, expense.fxRateMicro)));
  return {
    contractValueEgp,
    cashCollectedEgp,
    outstandingReceivablesEgp,
    cashOutEgp,
    netCashPositionEgp: cashCollectedEgp - cashOutEgp,
    unallocatedCustomerCreditEgp,
  };
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
