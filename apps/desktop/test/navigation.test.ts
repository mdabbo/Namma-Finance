import { describe, expect, it } from "vitest";
import {
  PRIMARY_NAVIGATION,
  SECONDARY_NAVIGATION,
  activeSecondaryItemId,
  activeSectionForPath,
  breadcrumbsForPath,
} from "../src/app/navigation";
import {
  ROLE_REFRESH_INTERVAL_MS,
  allowedPath,
  canMountRoute,
  homePath,
  roleRedirectTarget,
  searchScopeForRole,
} from "../src/lib/roles";

describe("Milestone 1 navigation", () => {
  it("exposes exactly the six approved primary sections", () => {
    expect(PRIMARY_NAVIGATION.map((item) => item.id)).toEqual([
      "overview",
      "projects",
      "finance",
      "team",
      "reports",
      "settings",
    ]);
  });

  it.each([
    ["/overview", "overview"],
    ["/projects", "projects"],
    ["/projects/clients/12", "projects"],
    ["/projects/41", "projects"],
    ["/finance/certificates", "finance"],
    ["/finance/payments", "finance"],
    ["/finance/expenses", "finance"],
    ["/finance/cash-flow", "finance"],
    ["/team/people/8", "team"],
    ["/team/time", "team"],
    ["/reports", "reports"],
    ["/settings/audit", "settings"],
  ])("maps %s to the %s section", (pathname, section) => {
    expect(activeSectionForPath(pathname)).toBe(section);
  });

  it.each([
    ["/clients/12", "projects"],
    ["/certificates", "finance"],
    ["/payments", "finance"],
    ["/expenses", "finance"],
    ["/people/8", "team"],
    ["/time", "team"],
    ["/audit", "settings"],
  ])("keeps legacy path %s associated with the correct section", (pathname, section) => {
    expect(activeSectionForPath(pathname)).toBe(section);
  });

  it("selects the most specific secondary item", () => {
    expect(activeSecondaryItemId("/projects/clients/7", SECONDARY_NAVIGATION.projects)).toBe("clients");
    expect(activeSecondaryItemId("/projects/7", SECONDARY_NAVIGATION.projects)).toBe("projects");
    expect(activeSecondaryItemId("/team/people/7", SECONDARY_NAVIGATION.team)).toBe("people");
    expect(activeSecondaryItemId("/settings/audit", SECONDARY_NAVIGATION.settings)).toBe("audit");
  });

  it("builds linked breadcrumbs for grouped detail routes", () => {
    expect(breadcrumbsForPath("/projects/clients/7")).toEqual([
      { labelKey: "nav.projects", to: "/projects" },
      { labelKey: "nav.clients", to: "/projects/clients" },
      { labelKey: "clients.single" },
    ]);
    expect(breadcrumbsForPath("/team/people/7")).toEqual([
      { labelKey: "nav.team", to: "/team" },
      { labelKey: "people.title", to: "/team/people" },
      { labelKey: "people.single" },
    ]);
  });

  it("preserves the engineer role boundary after clients move under projects", () => {
    expect(allowedPath("ENGINEER", "/projects")).toBe(true);
    expect(allowedPath("ENGINEER", "/projects/41")).toBe(true);
    expect(allowedPath("ENGINEER", "/projects/clients")).toBe(false);
    expect(allowedPath("ENGINEER", "/projects/clients/12")).toBe(false);
    expect(allowedPath("ENGINEER", "/finance/certificates")).toBe(false);
    expect(allowedPath("ENGINEER", "/settings")).toBe(true);
    expect(allowedPath("ENGINEER", "/settings/audit")).toBe(false);
    expect(allowedPath("ENGINEER", "/audit")).toBe(false);
    expect(homePath("ENGINEER")).toBe("/projects");
    expect(homePath("ACCOUNTANT")).toBe("/overview");
  });

  it("does not redirect from a restricted fallback role while the real role is loading", () => {
    expect(roleRedirectTarget("ENGINEER", "/overview", true)).toBeNull();
    expect(roleRedirectTarget("ADMIN", "/overview", false)).toBeNull();
    expect(roleRedirectTarget("ENGINEER", "/overview", false)).toBe("/projects");
  });

  it("never mounts protected route content before or after an engineer role resolves", () => {
    expect(canMountRoute("ENGINEER", "/finance/payments", true)).toBe(false);
    expect(canMountRoute("ENGINEER", "/finance/payments", false)).toBe(false);
    expect(canMountRoute("ENGINEER", "/settings/audit", false)).toBe(false);
    expect(canMountRoute("ACCOUNTANT", "/finance/payments", false)).toBe(true);
  });

  it("limits engineer global search to project records", () => {
    expect(searchScopeForRole("ENGINEER")).toBe("PROJECTS_ONLY");
    expect(searchScopeForRole("ACCOUNTANT")).toBe("FULL");
    expect(searchScopeForRole("ADMIN")).toBe("FULL");
  });

  it("periodically revalidates roles so remote downgrades do not remain cached indefinitely", () => {
    expect(ROLE_REFRESH_INTERVAL_MS).toBeGreaterThan(0);
    expect(ROLE_REFRESH_INTERVAL_MS).toBeLessThanOrEqual(60_000);
  });
});
