import {
  buildMonthlyCashSeries,
  selectOperationalProjectHealth,
} from "@mep/core";
import type { AuditRecord } from "../../repositories/audit";

export { buildMonthlyCashSeries };

export const DASHBOARD_PRIMARY_KPI_IDS = [
  "contract-value",
  "cash-collected",
  "outstanding-receivables",
  "net-cash-position",
] as const;

export const DASHBOARD_ATTENTION_ROUTES = {
  overdue: "/finance/receivables?view=overdue",
  readyToInvoice: "/projects?view=ready-to-invoice",
  unallocated: "/finance/payments?view=unallocated",
  teamPayments: "/team/people?view=payments-due",
} as const;

/** Active operational projects only; completed and cancelled work stays out of health views. */
export const selectProjectHealth = selectOperationalProjectHealth;

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
    case "project_stage":
      return "/projects";
    default:
      return "/settings/audit";
  }
}
