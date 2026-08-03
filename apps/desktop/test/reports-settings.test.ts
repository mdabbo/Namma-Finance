import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SECONDARY_NAVIGATION,
  SETTINGS_SECTIONS,
  breadcrumbsForPath,
  canOpenSettingsSection,
  settingsSectionsForRole,
} from "../src/app/navigation";
import { allowedPath } from "../src/lib/roles";

const src = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const read = (relative: string) => readFileSync(join(src, relative), "utf8");

/**
 * Milestone 7: Reports holds reporting only, and Settings is one linkable
 * section at a time with role access unchanged.
 */

describe("reports holds reporting only", () => {
  it("no longer mounts the import wizard or payment integrity review", () => {
    const page = read("features/reports/ReportsPage.tsx");
    expect(page).not.toContain("ImportWizard");
    expect(page).not.toContain("PaymentIntegrityView");
  });

  it("moves both technical tools into settings data tools", () => {
    const settings = read("features/settings/SettingsPage.tsx");
    expect(settings).toContain("ImportWizard");
    expect(settings).toContain("PaymentIntegrityView");
    expect(settings).toContain('section === "data-tools"');
  });

  /** One implementation each: cash flow and receivables stay under Finance. */
  it("links cash flow and receivables instead of rebuilding them", () => {
    const reports = SECONDARY_NAVIGATION.reports;
    expect(reports.find((item) => item.id === "cash-flow")?.to).toBe("/finance/cash-flow");
    expect(reports.find((item) => item.id === "receivables")?.to).toBe("/finance/receivables");
    const page = read("features/reports/ReportsPage.tsx");
    expect(page).not.toContain("CashflowView");
  });

  it("gives every report its own address", () => {
    for (const id of ["profitability", "costing", "export"]) {
      expect(SECONDARY_NAVIGATION.reports.some((item) => item.to === `/reports/${id}`)).toBe(true);
    }
    expect(breadcrumbsForPath("/reports/costing").map((crumb) => crumb.labelKey))
      .toEqual(["nav.reports", "reports.costing"]);
  });
});

describe("settings sections are linkable and role aware", () => {
  it("covers the groups the redesign calls for", () => {
    expect(SETTINGS_SECTIONS.map((section) => section.id)).toEqual([
      "general", "company", "finance", "numbering", "categories",
      "backup", "sync", "security", "data-tools", "advanced", "audit",
    ]);
  });

  it("builds a breadcrumb for each section", () => {
    for (const section of SETTINGS_SECTIONS) {
      const path = section.id === "audit" ? "/settings/audit" : `/settings/${section.id}`;
      expect(breadcrumbsForPath(path).map((crumb) => crumb.labelKey))
        .toEqual(["nav.settings", section.labelKey]);
    }
  });

  /**
   * Engineers get personal preferences only. The menu and the route guard read
   * the same list, so a section they may not open stays closed however it is
   * reached.
   */
  it("keeps engineers to personal preferences", () => {
    const engineer = settingsSectionsForRole("ENGINEER").map((section) => section.id);
    expect(engineer).toEqual(["general", "sync", "security", "advanced"]);
    expect(canOpenSettingsSection("ENGINEER", "company")).toBe(false);
    expect(canOpenSettingsSection("ENGINEER", "data-tools")).toBe(false);
    expect(canOpenSettingsSection("ENGINEER", "backup")).toBe(false);
  });

  it("lets accountants and admins open every section", () => {
    for (const role of ["ACCOUNTANT", "ADMIN"]) {
      expect(settingsSectionsForRole(role)).toHaveLength(SETTINGS_SECTIONS.length);
    }
  });

  /**
   * Regression: settings moved from one page to a route per section, so the
   * engineer's own preferences are at /settings/general. A guard that still
   * only allowed the bare /settings would have locked them out entirely.
   */
  it("routes the role guard per settings section", () => {
    expect(allowedPath("ENGINEER", "/settings")).toBe(true);
    expect(allowedPath("ENGINEER", "/settings/general")).toBe(true);
    expect(allowedPath("ENGINEER", "/settings/company")).toBe(false);
    expect(allowedPath("ENGINEER", "/settings/data-tools")).toBe(false);
    expect(allowedPath("ACCOUNTANT", "/settings/data-tools")).toBe(true);
  });

  it("shows one section at a time", () => {
    const page = read("features/settings/SettingsPage.tsx");
    for (const id of ["company", "general", "numbering", "finance", "categories", "backup", "advanced"]) {
      expect(page, `settings must gate the ${id} section`).toContain(`section === "${id}"`);
    }
  });
});
