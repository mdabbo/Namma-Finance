import { describe, expect, it } from "vitest";
import {
  SECONDARY_NAVIGATION,
  SETTINGS_GROUPS,
  SETTINGS_SECTIONS,
  canOpenSettingsSection,
  firstSettingsSectionForRole,
  settingsNavigationGroups,
  settingsSectionPath,
  settingsSectionsForRole,
  breadcrumbsForPath,
} from "../src/app/navigation";
import { allowedPath, canMountRoute, roleRedirectTarget } from "../src/lib/roles";

/**
 * Milestone 5: one Settings navigator.
 *
 * Settings sections used to be rendered twice — once by the global secondary
 * navigation in Layout and once by SettingsPage — so the user saw two
 * consecutive rows offering the same eleven destinations. The model tests here
 * pin the single-source contract; the Playwright specs assert that only one
 * navigation landmark reaches the screen.
 */

const ROLES = ["ADMIN", "ACCOUNTANT", "ENGINEER"] as const;

describe("settings navigation model", () => {
  it("gives Settings no global secondary navigation", () => {
    expect(SECONDARY_NAVIGATION.settings).toEqual([]);
  });

  it("groups every section exactly once, and only real sections", () => {
    const grouped = SETTINGS_GROUPS.flatMap((group) => group.sectionIds);
    const known = SETTINGS_SECTIONS.map((section) => section.id);
    // No section may be dropped from the menu…
    expect([...grouped].sort()).toEqual([...known].sort());
    // …and none may appear twice.
    expect(new Set(grouped).size).toBe(grouped.length);
  });

  it("uses the approved grouping", () => {
    expect(SETTINGS_GROUPS.map((group) => [group.id, [...group.sectionIds]])).toEqual([
      ["general", ["general", "company"]],
      ["finance", ["finance", "numbering", "categories"]],
      ["data", ["backup", "sync", "data-tools", "audit"]],
      ["system", ["security", "advanced"]],
    ]);
  });

  it("addresses every section by its own URL", () => {
    for (const section of SETTINGS_SECTIONS) {
      expect(settingsSectionPath(section.id)).toBe(`/settings/${section.id}`);
    }
    // Audit keeps its Settings address rather than a special case.
    expect(settingsSectionPath("audit")).toBe("/settings/audit");
  });

  it("keeps breadcrumbs meaningful for every section", () => {
    for (const section of SETTINGS_SECTIONS) {
      const crumbs = breadcrumbsForPath(settingsSectionPath(section.id));
      expect(crumbs[0]).toMatchObject({ labelKey: "nav.settings", to: "/settings" });
      expect(crumbs.at(-1)?.labelKey, section.id).toBe(section.labelKey);
    }
  });
});

describe("settings role authorization", () => {
  it("shows an admin every section", () => {
    expect(settingsSectionsForRole("ADMIN").map((s) => s.id))
      .toEqual(SETTINGS_SECTIONS.map((s) => s.id));
  });

  it("shows an accountant every non-admin section", () => {
    const accountant = settingsSectionsForRole("ACCOUNTANT").map((s) => s.id);
    const adminOnly = SETTINGS_SECTIONS.filter((s) => s.admin).map((s) => s.id);
    for (const id of adminOnly) expect(accountant).not.toContain(id);
    for (const section of SETTINGS_SECTIONS) {
      if (!section.admin) expect(accountant).toContain(section.id);
    }
  });

  it("restricts an engineer to personal preference sections", () => {
    const engineer = settingsSectionsForRole("ENGINEER").map((s) => s.id);
    expect(engineer).toEqual(["general", "sync", "security", "advanced"]);
    for (const id of ["company", "finance", "numbering", "categories", "backup", "data-tools", "audit"]) {
      expect(engineer, `engineer must not see ${id}`).not.toContain(id);
    }
  });

  it("builds the menu from the same rule that authorizes the route", () => {
    // The defect this prevents: a menu built from one list and a guard from
    // another, so a visible entry 403s or a hidden one still opens.
    for (const role of ROLES) {
      const visible = settingsNavigationGroups(role).flatMap((g) => g.sections.map((s) => s.id));
      // Grouping reorders (Security and Advanced sit under System), so the
      // menu and the authorization list must match as SETS, not sequences.
      expect([...visible].sort()).toEqual(settingsSectionsForRole(role).map((s) => s.id).sort());
      for (const section of SETTINGS_SECTIONS) {
        const inMenu = visible.includes(section.id);
        expect(canOpenSettingsSection(role, section.id), `${role}/${section.id}`).toBe(inMenu);
        expect(allowedPath(role, settingsSectionPath(section.id)), `${role}/${section.id}`).toBe(inMenu);
      }
    }
  });

  it("never renders an empty group heading", () => {
    for (const role of ROLES) {
      for (const group of settingsNavigationGroups(role)) {
        expect(group.sections.length, `${role}/${group.id}`).toBeGreaterThan(0);
      }
    }
  });

  it("keeps Audit out of the menu and the routes for non-admin-permitted roles", () => {
    expect(canOpenSettingsSection("ADMIN", "audit")).toBe(true);
    expect(canOpenSettingsSection("ACCOUNTANT", "audit")).toBe(true);
    expect(canOpenSettingsSection("ENGINEER", "audit")).toBe(false);
    expect(allowedPath("ENGINEER", "/settings/audit")).toBe(false);
  });
});

describe("settings route redirects", () => {
  it("lands each role on a section it may actually open", () => {
    for (const role of ROLES) {
      const first = firstSettingsSectionForRole(role);
      expect(canOpenSettingsSection(role, first), role).toBe(true);
    }
  });

  it("redirects an engineer away from a forbidden settings route", () => {
    expect(canMountRoute("ENGINEER", "/settings/audit", false)).toBe(false);
    expect(roleRedirectTarget("ENGINEER", "/settings/audit", false)).toBe("/projects");
    // A section they may open mounts normally.
    expect(canMountRoute("ENGINEER", "/settings/general", false)).toBe(true);
    expect(roleRedirectTarget("ENGINEER", "/settings/general", false)).toBeNull();
  });

  it("holds every route closed while the role is still loading", () => {
    expect(canMountRoute("ADMIN", "/settings/audit", true)).toBe(false);
    // Pending is not a redirect: the app waits rather than bouncing the user.
    expect(roleRedirectTarget("ADMIN", "/settings/audit", true)).toBeNull();
  });

  it("keeps unknown settings sections out", () => {
    for (const role of ROLES) {
      expect(canOpenSettingsSection(role, "does-not-exist")).toBe(false);
      expect(allowedPath("ENGINEER", "/settings/does-not-exist")).toBe(false);
    }
  });
});
