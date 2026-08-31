import {
  toEgpPiasters,
  type ContractState,
  type FinanceContractInput,
} from "@mep/core";

/**
 * Attention views each finance list accepts via `?view=`. Anything else in the
 * URL (stale links, typos) is ignored rather than silently mis-filtering.
 */
export const FINANCE_ATTENTION_VIEWS = {
  certificates: ["overdue"],
  payments: ["unallocated"],
  expenses: [],
  receivables: ["overdue"],
} as const;

export type FinanceListId = keyof typeof FINANCE_ATTENTION_VIEWS;

export interface FinanceScope {
  view: string | null;
  projectId: number | null;
}

/**
 * Parse the shared `?view=` / `?projectId=` contract used by dashboard
 * attention links and project-workspace shortcuts. Invalid values degrade to
 * the unfiltered list instead of throwing or filtering to nothing.
 */
export function parseFinanceScope(
  params: Pick<URLSearchParams, "get">,
  list: FinanceListId,
): FinanceScope {
  const allowed: readonly string[] = FINANCE_ATTENTION_VIEWS[list];
  const rawView = params.get("view");
  const rawProject = params.get("projectId");
  const projectId = rawProject !== null && /^\d+$/.test(rawProject) ? Number(rawProject) : null;
  return {
    view: rawView !== null && allowed.includes(rawView) ? rawView : null,
    projectId: projectId !== null && projectId > 0 && Number.isSafeInteger(projectId) ? projectId : null,
  };
}

export function inProjectScope(rowProjectId: number | null, projectId: number | null): boolean {
  return projectId === null || rowProjectId === projectId;
}

/** The canonical project-scope parameter. There is deliberately only one. */
export const FINANCE_PROJECT_PARAM = "projectId";

/**
 * Saved-view filter keys the finance lists put in the URL, so applying and
 * resetting a view touch exactly the parameters the page actually reads.
 *
 * Saved views used to write `project` while every reader used `projectId`.
 * Nothing consumed the value, so a restored view reported "applied" over an
 * unscoped list, and reset removed `project` — which was never set — while
 * leaving a real `projectId` in place. One key, written and read by the same
 * name, is what makes the applied state truthful.
 */
export function applyFinanceScopeParams(
  current: URLSearchParams,
  list: FinanceListId,
  filters: Readonly<Record<string, string | undefined>>,
): URLSearchParams {
  const params = new URLSearchParams(current);
  const requested = Number(filters[FINANCE_PROJECT_PARAM]);
  if (Number.isSafeInteger(requested) && requested > 0) {
    params.set(FINANCE_PROJECT_PARAM, String(requested));
  } else {
    params.delete(FINANCE_PROJECT_PARAM);
  }
  const allowed: readonly string[] = FINANCE_ATTENTION_VIEWS[list];
  const view = filters.view ?? "";
  if (allowed.includes(view)) params.set("view", view);
  else params.delete("view");
  return params;
}

/**
 * Clear every URL-driven filter this page owns: the project scope, the
 * attention view, and the legacy `project` key so a stale link cannot leave a
 * parameter behind that outlives the reset.
 */
export function resetFinanceScopeParams(current: URLSearchParams): URLSearchParams {
  const params = new URLSearchParams(current);
  params.delete(FINANCE_PROJECT_PARAM);
  params.delete("view");
  params.delete(LEGACY_FINANCE_PROJECT_PARAM);
  return params;
}

/**
 * The pre-0.7.0 parameter name. It is read ONCE, to normalise an old bookmark
 * onto the canonical key — never written, so there is a single active contract.
 */
export const LEGACY_FINANCE_PROJECT_PARAM = "project";

/**
 * If a URL still carries the legacy `project` parameter, return the params
 * rewritten onto `projectId`; otherwise `null` (nothing to migrate). An
 * unusable legacy value is dropped rather than carried forward, so an invalid
 * id degrades to the unfiltered list.
 */
export function normalizeLegacyProjectParam(current: URLSearchParams): URLSearchParams | null {
  const legacy = current.get(LEGACY_FINANCE_PROJECT_PARAM);
  if (legacy === null) return null;
  const params = new URLSearchParams(current);
  params.delete(LEGACY_FINANCE_PROJECT_PARAM);
  const id = Number(legacy);
  if (!params.has(FINANCE_PROJECT_PARAM) && /^\d+$/.test(legacy) && Number.isSafeInteger(id) && id > 0) {
    params.set(FINANCE_PROJECT_PARAM, String(id));
  }
  return params;
}

/**
 * Pair each live contract state with its project's FX context so the core
 * receivables selectors can value certificates at their historical terms.
 */
export function financeContractInputs(input: {
  contractStates: ReadonlyMap<number, ContractState>;
  projects: readonly { project: { id: number; currency: string; fxRateMicro: number } }[];
}): FinanceContractInput[] {
  const projectById = new Map(input.projects.map((item) => [item.project.id, item.project]));
  return [...input.contractStates.values()].flatMap((state) => {
    const project = projectById.get(state.contract.projectId);
    return project
      ? [{ state, projectCurrency: project.currency, projectFxRateMicro: project.fxRateMicro }]
      : [];
  });
}

/**
 * The consolidated per-project figures the section KPIs are summed from.
 * Monetary facts stay owned by the financial read model (ProjectFinancials
 * is structurally assignable) — nothing here re-derives money from raw rows,
 * so the numbers always agree with the dashboard.
 */
export interface ProjectMoneyFacts {
  project: { id: number };
  invoicedAmountEgp: number;
  outstandingEgp: number;
  overdueCertificates: number;
  totalActualCashInEgp: number;
  unallocatedCustomerCreditEgp: number;
}

export interface ExpenseMoneyFacts {
  date: string;
  projectId: number | null;
  amountMinor: number;
  currency: string;
  fxRateMicro: number;
}

function scoped<T extends ProjectMoneyFacts>(projects: readonly T[], projectId: number | null): readonly T[] {
  return projectId === null ? projects : projects.filter((p) => p.project.id === projectId);
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function sameMonth(dateIso: string, todayIso: string): boolean {
  return dateIso.slice(0, 7) === todayIso.slice(0, 7);
}

export interface CertificateSectionKpis {
  invoicedEgp: number;
  outstandingEgp: number;
  overdueCount: number;
}

export function certificateSectionKpis(
  projects: readonly ProjectMoneyFacts[],
  projectId: number | null,
): CertificateSectionKpis {
  const own = scoped(projects, projectId);
  return {
    invoicedEgp: sum(own.map((p) => p.invoicedAmountEgp)),
    outstandingEgp: sum(own.map((p) => p.outstandingEgp)),
    overdueCount: sum(own.map((p) => p.overdueCertificates)),
  };
}

export interface PaymentSectionKpis {
  totalCashInEgp: number;
  monthCashInEgp: number;
  unallocatedCreditEgp: number;
}

export function paymentSectionKpis(input: {
  projects: readonly ProjectMoneyFacts[];
  cashIn: readonly { date: string; projectId: number; egpMinor: number }[];
  projectId: number | null;
  todayIso: string;
}): PaymentSectionKpis {
  const own = scoped(input.projects, input.projectId);
  const cash = input.cashIn.filter((item) => inProjectScope(item.projectId, input.projectId));
  return {
    totalCashInEgp: sum(own.map((p) => p.totalActualCashInEgp)),
    monthCashInEgp: sum(cash.filter((item) => sameMonth(item.date, input.todayIso)).map((item) => item.egpMinor)),
    unallocatedCreditEgp: sum(own.map((p) => p.unallocatedCustomerCreditEgp)),
  };
}

export interface ExpenseSectionKpis {
  totalEgp: number;
  monthEgp: number;
  overheadEgp: number;
  projectEgp: number;
}

export function expenseSectionKpis(
  expenses: readonly ExpenseMoneyFacts[],
  projectId: number | null,
  todayIso: string,
): ExpenseSectionKpis {
  const own = expenses.filter((expense) => inProjectScope(expense.projectId, projectId));
  const egp = (expense: ExpenseMoneyFacts) => toEgpPiasters(expense.amountMinor, expense.currency, expense.fxRateMicro);
  return {
    totalEgp: sum(own.map(egp)),
    monthEgp: sum(own.filter((expense) => sameMonth(expense.date, todayIso)).map(egp)),
    overheadEgp: sum(own.filter((expense) => expense.projectId === null).map(egp)),
    projectEgp: sum(own.filter((expense) => expense.projectId !== null).map(egp)),
  };
}
