export type NavigationSectionId = "overview" | "projects" | "finance" | "team" | "reports" | "settings";

export interface PrimaryNavigationItem {
  id: NavigationSectionId;
  labelKey: string;
  to: string;
}

export interface SecondaryNavigationItem {
  id: string;
  labelKey: string;
  to: string;
  exact?: boolean;
}

export interface BreadcrumbItem {
  labelKey: string;
  to?: string;
}

export const PRIMARY_NAVIGATION: readonly PrimaryNavigationItem[] = [
  { id: "overview", labelKey: "nav.overview", to: "/overview" },
  { id: "projects", labelKey: "nav.projects", to: "/projects" },
  { id: "finance", labelKey: "nav.finance", to: "/finance" },
  { id: "team", labelKey: "nav.team", to: "/team" },
  { id: "reports", labelKey: "nav.reports", to: "/reports" },
  { id: "settings", labelKey: "nav.settings", to: "/settings" },
] as const;

export const SECONDARY_NAVIGATION: Readonly<Record<NavigationSectionId, readonly SecondaryNavigationItem[]>> = {
  overview: [],
  projects: [
    { id: "projects", labelKey: "nav.projects", to: "/projects" },
    { id: "clients", labelKey: "nav.clients", to: "/projects/clients" },
  ],
  finance: [
    { id: "overview", labelKey: "financeSection.overview", to: "/finance", exact: true },
    { id: "certificates", labelKey: "nav.certificates", to: "/finance/certificates" },
    { id: "payments", labelKey: "nav.payments", to: "/finance/payments" },
    { id: "expenses", labelKey: "nav.expenses", to: "/finance/expenses" },
    { id: "receivables", labelKey: "financeSection.receivables", to: "/finance/receivables" },
    { id: "cash-flow", labelKey: "reports.cashflow", to: "/finance/cash-flow" },
  ],
  team: [
    { id: "people", labelKey: "people.title", to: "/team/people" },
    { id: "time", labelKey: "time.title", to: "/team/time" },
  ],
  reports: [],
  settings: [
    { id: "settings", labelKey: "settings.title", to: "/settings", exact: true },
    { id: "audit", labelKey: "nav.audit", to: "/settings/audit" },
  ],
};

const LEGACY_SECTION_PREFIXES: ReadonlyArray<readonly [string, NavigationSectionId]> = [
  ["/clients", "projects"],
  ["/certificates", "finance"],
  ["/payments", "finance"],
  ["/expenses", "finance"],
  ["/people", "team"],
  ["/time", "team"],
  ["/audit", "settings"],
];

function matchesPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function activeSectionForPath(pathname: string): NavigationSectionId | null {
  if (pathname === "/" || matchesPrefix(pathname, "/overview")) return "overview";
  for (const section of PRIMARY_NAVIGATION.slice(1)) {
    if (matchesPrefix(pathname, section.to)) return section.id;
  }
  return LEGACY_SECTION_PREFIXES.find(([prefix]) => matchesPrefix(pathname, prefix))?.[1] ?? null;
}

export function activeSecondaryItemId(
  pathname: string,
  items: readonly SecondaryNavigationItem[],
): string | null {
  const matches = items
    .filter((item) => pathname === item.to || (!item.exact && pathname.startsWith(`${item.to}/`)))
    .sort((a, b) => b.to.length - a.to.length);
  return matches[0]?.id ?? null;
}

export function breadcrumbsForPath(pathname: string): BreadcrumbItem[] {
  const sectionId = activeSectionForPath(pathname);
  const section = PRIMARY_NAVIGATION.find((item) => item.id === sectionId);
  if (!section) return [];

  const root: BreadcrumbItem = { labelKey: section.labelKey };
  if (pathname === section.to || pathname === "/") return [root];
  root.to = section.to;

  if (matchesPrefix(pathname, "/projects/clients") || matchesPrefix(pathname, "/clients")) {
    const detail = /^\/(?:projects\/)?clients\/[^/]+$/.test(pathname);
    return [
      root,
      { labelKey: "nav.clients", ...(detail ? { to: "/projects/clients" } : {}) },
      ...(detail ? [{ labelKey: "clients.single" }] : []),
    ];
  }
  if (/^\/projects\/[^/]+$/.test(pathname)) {
    return [root, { labelKey: "projects.single" }];
  }
  if (matchesPrefix(pathname, "/finance/certificates") || matchesPrefix(pathname, "/certificates")) {
    return [root, { labelKey: "nav.certificates" }];
  }
  if (matchesPrefix(pathname, "/finance/payments") || matchesPrefix(pathname, "/payments")) {
    return [root, { labelKey: "nav.payments" }];
  }
  if (matchesPrefix(pathname, "/finance/expenses") || matchesPrefix(pathname, "/expenses")) {
    return [root, { labelKey: "nav.expenses" }];
  }
  if (matchesPrefix(pathname, "/finance/receivables")) {
    return [root, { labelKey: "financeSection.receivables" }];
  }
  if (matchesPrefix(pathname, "/finance/cash-flow")) {
    return [root, { labelKey: "reports.cashflow" }];
  }
  if (matchesPrefix(pathname, "/team/people") || matchesPrefix(pathname, "/people")) {
    const detail = /^\/(?:team\/)?people\/[^/]+$/.test(pathname);
    return [
      root,
      { labelKey: "people.title", ...(detail ? { to: "/team/people" } : {}) },
      ...(detail ? [{ labelKey: "people.single" }] : []),
    ];
  }
  if (matchesPrefix(pathname, "/team/time") || matchesPrefix(pathname, "/time")) {
    return [root, { labelKey: "time.title" }];
  }
  if (matchesPrefix(pathname, "/settings/audit") || matchesPrefix(pathname, "/audit")) {
    return [root, { labelKey: "nav.audit" }];
  }
  return [root];
}
