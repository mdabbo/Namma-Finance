import type { Role } from "../../lib/roles";

export const PROJECT_WORKSPACE_TABS = [
  "summary",
  "contracts",
  "finance",
  "team",
  "time",
  "documents",
] as const;

export type ProjectWorkspaceTab = (typeof PROJECT_WORKSPACE_TABS)[number];

export const PROJECT_FINANCE_VIEWS = [
  "certificates",
  "payments",
  "expenses",
  "receivables",
] as const;

export type ProjectFinanceView = (typeof PROJECT_FINANCE_VIEWS)[number];

const ENGINEER_TABS: readonly ProjectWorkspaceTab[] = [
  "summary",
  "time",
  "documents",
];

export function projectTabsForRole(role: Role): readonly ProjectWorkspaceTab[] {
  return role === "ENGINEER" ? ENGINEER_TABS : PROJECT_WORKSPACE_TABS;
}

export interface ProjectAttentionSummary {
  overdueCertificates: number;
  readyToInvoice: number;
  unallocatedPayments: number;
  teamPaymentsDue: number;
}

/**
 * Build navigation counts only. Monetary facts remain owned by the financial
 * read model and are never recalculated by the project workspace.
 */
export function projectAttentionSummary(input: {
  projectId: number;
  overdueCertificates: number;
  unallocatedCustomerCreditEgp: number;
  readyToCollect: readonly { projectId: number }[];
  teamPayables: readonly { projectId: number }[];
}): ProjectAttentionSummary {
  return {
    overdueCertificates: input.overdueCertificates,
    readyToInvoice: input.readyToCollect.filter(
      (item) => item.projectId === input.projectId,
    ).length,
    unallocatedPayments: input.unallocatedCustomerCreditEgp > 0 ? 1 : 0,
    teamPaymentsDue: input.teamPayables.filter(
      (item) => item.projectId === input.projectId,
    ).length,
  };
}

/** Shown when the audited read model has no figure for a row yet. */
export const UNKNOWN_AMOUNT = "—";

/**
 * Render a monetary figure that the financial read model owns. A missing row
 * means "not known yet" — printing a formatted zero would state, on a live
 * financial screen, that a real payment or payout balance is nil.
 */
export function readModelAmount<T>(
  record: T | undefined,
  format: (record: T) => string,
): string {
  return record === undefined ? UNKNOWN_AMOUNT : format(record);
}

export interface ProjectWorkspaceLocation {
  tab: ProjectWorkspaceTab;
  financeView: ProjectFinanceView;
}

/**
 * Resolve where the workspace is from the URL.
 *
 * The tab used to be React state, so a refresh dropped the user back on
 * Summary, history ignored tab changes and nothing could link to a project's
 * payments. It now lives in the query string, which makes the URL untrusted
 * input: an unknown tab, or one this role may not open, falls back to the first
 * tab the role is allowed rather than rendering something it should not see.
 */
export function parseProjectWorkspaceLocation(
  params: { get(key: string): string | null },
  role: Role,
): ProjectWorkspaceLocation {
  const allowed = projectTabsForRole(role);
  const requested = params.get("tab");
  const tab = allowed.find((candidate) => candidate === requested) ?? allowed[0]!;
  const requestedView = params.get("view");
  const financeView =
    PROJECT_FINANCE_VIEWS.find((candidate) => candidate === requestedView)
    ?? "certificates";
  return { tab, financeView };
}

/** The query string for a workspace location, omitting defaults. */
export function projectWorkspaceSearch(location: {
  tab: ProjectWorkspaceTab;
  financeView?: ProjectFinanceView;
}): string {
  const params = new URLSearchParams({ tab: location.tab });
  if (location.tab === "finance" && location.financeView) {
    params.set("view", location.financeView);
  }
  return `?${params.toString()}`;
}

/** A link straight to one project view, for activity rows and notifications. */
export function projectWorkspacePath(
  projectId: number,
  location: { tab: ProjectWorkspaceTab; financeView?: ProjectFinanceView },
): string {
  return `/projects/${projectId}${projectWorkspaceSearch(location)}`;
}

export function projectActivityDestination(entityType: string): {
  tab: ProjectWorkspaceTab;
  financeView?: ProjectFinanceView;
} {
  switch (entityType) {
    case "contract":
    case "contract_revision":
      return { tab: "contracts" };
    case "payment_certificate":
      return { tab: "finance", financeView: "certificates" };
    case "payment":
    case "payment_allocation":
      return { tab: "finance", financeView: "payments" };
    case "expense":
    case "recurring_expense":
      return { tab: "finance", financeView: "expenses" };
    case "project_assignment":
    case "person_payment":
    case "person":
      return { tab: "team" };
    case "time_entry":
      return { tab: "time" };
    case "document":
      return { tab: "documents" };
    default:
      return { tab: "summary" };
  }
}
