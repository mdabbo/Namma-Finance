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

/**
 * Settings groups, one visible at a time and each directly linkable.
 *
 * `full` marks a section an engineer may not open: engineers get personal
 * preferences only, and the route guard uses this same list so the sidebar and
 * the URL can never disagree.
 */
export interface SettingsSection {
  id: string;
  labelKey: string;
  /** Requires a non-engineer role. */
  full: boolean;
  /** Requires ADMIN. */
  admin?: boolean;
}

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  { id: "general", labelKey: "settings.general", full: false },
  { id: "company", labelKey: "settings.companyProfile", full: true },
  { id: "finance", labelKey: "nav.finance", full: true },
  { id: "numbering", labelKey: "settings.numberingTitle", full: true },
  { id: "categories", labelKey: "settings.expenseCategories", full: true },
  { id: "backup", labelKey: "settings.dataAndBackup", full: true },
  { id: "sync", labelKey: "settings.syncTitle", full: false },
  { id: "security", labelKey: "settings.securityTitle", full: false },
  { id: "data-tools", labelKey: "settings.dataTools", full: true },
  { id: "advanced", labelKey: "settings.advanced", full: false },
  { id: "audit", labelKey: "nav.audit", full: true },
] as const;

/**
 * Settings sections in named groups.
 *
 * Eleven flat entries recreated the tab overload the redesign set out to
 * remove, so the sidebar groups them. The groups are presentation only: every
 * section keeps its own URL, and membership references SETTINGS_SECTIONS by id
 * so a section can never appear in the menu without an authorization rule (or
 * vice versa) — `settingsNavigationGroups` asserts the two stay in step.
 */
export interface SettingsGroup {
  id: string;
  labelKey: string;
  sectionIds: readonly string[];
}

export const SETTINGS_GROUPS: readonly SettingsGroup[] = [
  { id: "general", labelKey: "settings.groups.general", sectionIds: ["general", "company"] },
  { id: "finance", labelKey: "settings.groups.finance", sectionIds: ["finance", "numbering", "categories"] },
  { id: "data", labelKey: "settings.groups.data", sectionIds: ["backup", "sync", "data-tools", "audit"] },
  { id: "system", labelKey: "settings.groups.system", sectionIds: ["security", "advanced"] },
] as const;

/** Sections a role may open. Engineers keep personal preferences only. */
export function settingsSectionsForRole(role: string): readonly SettingsSection[] {
  return SETTINGS_SECTIONS.filter((section) => {
    if (section.admin && role !== "ADMIN") return false;
    if (section.full && role === "ENGINEER") return false;
    return true;
  });
}

export function canOpenSettingsSection(role: string, sectionId: string): boolean {
  return settingsSectionsForRole(role).some((section) => section.id === sectionId);
}

/** The canonical URL of a settings section. */
export function settingsSectionPath(sectionId: string): string {
  return `/settings/${sectionId}`;
}

export interface SettingsNavigationGroup {
  id: string;
  labelKey: string;
  sections: readonly SettingsSection[];
}

/**
 * The grouped menu for a role: the same authorization filter the route guard
 * uses, arranged into groups. Groups with nothing visible are dropped, so a
 * role never sees an empty heading.
 */
export function settingsNavigationGroups(role: string): readonly SettingsNavigationGroup[] {
  const allowed = settingsSectionsForRole(role);
  const byId = new Map(allowed.map((section) => [section.id, section]));
  return SETTINGS_GROUPS.flatMap((group) => {
    const sections = group.sectionIds
      .map((id) => byId.get(id))
      .filter((section): section is SettingsSection => section !== undefined);
    return sections.length === 0 ? [] : [{ id: group.id, labelKey: group.labelKey, sections }];
  });
}

/** The first section a role may open; where a bare or forbidden URL lands. */
export function firstSettingsSectionForRole(role: string): string {
  return settingsSectionsForRole(role)[0]?.id ?? "general";
}

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
  // Reports holds reporting only. Cash flow and receivables keep their single
  // home under Finance and are linked here rather than rebuilt, so there is one
  // implementation and one place to fix.
  reports: [
    { id: "profitability", labelKey: "reports.profitability", to: "/reports/profitability" },
    { id: "costing", labelKey: "reports.costing", to: "/reports/costing" },
    { id: "receivables", labelKey: "financeSection.receivables", to: "/finance/receivables" },
    { id: "cash-flow", labelKey: "reports.cashflow", to: "/finance/cash-flow" },
    { id: "export", labelKey: "reports.center", to: "/reports/export" },
  ],
  // Settings deliberately has NO global secondary navigation. Its sections are
  // listed once, by the sidebar inside SettingsPage: rendering them here too
  // put two navigation rows on screen showing the same eleven destinations.
  settings: [],
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
  const settingsSection = /^\/settings\/([^/]+)$/.exec(pathname)?.[1];
  if (settingsSection) {
    const section = SETTINGS_SECTIONS.find((item) => item.id === settingsSection);
    if (section) return [root, { labelKey: section.labelKey }];
  }
  const report = /^\/reports\/([^/]+)$/.exec(pathname)?.[1];
  if (report) {
    const item = SECONDARY_NAVIGATION.reports.find((entry) => entry.id === report);
    if (item) return [root, { labelKey: item.labelKey }];
  }
  return [root];
}
