import { toEgpPiasters, type Expense, type ProjectFinancials } from "@mep/core";
import type { AuditRecord } from "../../repositories/audit";
import type { WorkspaceFinancials } from "../../repositories/financials";

export const DASHBOARD_PRIMARY_KPI_IDS = [
  "contract-value",
  "cash-collected",
  "outstanding-receivables",
  "net-cash-position",
] as const;

export const DASHBOARD_ATTENTION_ROUTES = {
  overdue: "/finance/certificates?view=overdue",
  readyToInvoice: "/projects?view=ready-to-invoice",
  unallocated: "/finance/payments?view=unallocated",
  teamPayments: "/team/people?view=payments-due",
} as const;

export interface MonthlyCashPoint {
  month: string;
  cashInEgp: number;
  cashOutEgp: number;
  netEgp: number;
}

/** Build a display series from immutable source rows while retaining integer piasters. */
export function buildMonthlyCashSeries(
  cashIn: WorkspaceFinancials["cashIn"],
  expenses: Expense[],
): MonthlyCashPoint[] {
  const buckets = new Map<string, { cashInEgp: number; cashOutEgp: number }>();
  const bucket = (date: string) => {
    const month = date.slice(0, 7);
    const current = buckets.get(month) ?? { cashInEgp: 0, cashOutEgp: 0 };
    buckets.set(month, current);
    return current;
  };

  for (const payment of cashIn) {
    bucket(payment.date).cashInEgp += payment.egpMinor;
  }
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

/** Active operational projects only; completed and cancelled work stays out of health views. */
export function selectProjectHealth(
  projects: ProjectFinancials[],
  limit = 5,
): ProjectFinancials[] {
  return projects
    .filter(({ project }) => project.status === "ACTIVE" || project.status === "ON_HOLD")
    .sort((left, right) => right.contractValueEgp - left.contractValueEgp)
    .slice(0, Math.max(0, limit));
}

/** Route recent activity to the closest useful workspace without exposing audit internals. */
export function activityRoute(record: Pick<AuditRecord, "entityType" | "entityId">): string {
  switch (record.entityType) {
    case "project":
      return record.entityId === null ? "/projects" : `/projects/${record.entityId}`;
    case "client":
      return record.entityId === null ? "/projects/clients" : `/projects/clients/${record.entityId}`;
    case "payment_certificate":
      return "/finance/certificates";
    case "payment":
      return "/finance/payments";
    case "expense":
    case "recurring_expense":
      return "/finance/expenses";
    case "person":
      return record.entityId === null ? "/team/people" : `/team/people/${record.entityId}`;
    case "project_assignment":
    case "person_payment":
      return "/team/people";
    case "time_entry":
      return "/team/time";
    default:
      return "/settings/audit";
  }
}
