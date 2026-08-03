import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROJECT_FINANCE_VIEWS,
  PROJECT_WORKSPACE_TABS,
  parseProjectWorkspaceLocation,
  projectActivityDestination,
  projectTabsForRole,
  projectWorkspacePath,
  projectWorkspaceSearch,
} from "../src/features/projects/projectWorkspaceModel";

const src = resolve(dirname(fileURLToPath(import.meta.url)), "../src");

/**
 * Milestone 8: the project workspace location lives in the URL.
 *
 * It used to be React state, so a refresh dropped the user back on Summary,
 * history ignored tab changes, and nothing could link to a project's payments.
 * The URL is now authoritative — and therefore untrusted input.
 */

const params = (query: string) => new URLSearchParams(query);

describe("workspace location comes from the URL", () => {
  it("reads the tab and finance view", () => {
    expect(parseProjectWorkspaceLocation(params("tab=finance&view=payments"), "ADMIN"))
      .toEqual({ tab: "finance", financeView: "payments" });
  });

  it("defaults to the first allowed tab when nothing is asked for", () => {
    expect(parseProjectWorkspaceLocation(params(""), "ADMIN").tab).toBe("summary");
    expect(parseProjectWorkspaceLocation(params(""), "ENGINEER").tab).toBe("summary");
  });

  it("round-trips every tab", () => {
    for (const tab of PROJECT_WORKSPACE_TABS) {
      expect(parseProjectWorkspaceLocation(params(`tab=${tab}`), "ADMIN").tab).toBe(tab);
    }
  });

  it("round-trips every finance view", () => {
    for (const view of PROJECT_FINANCE_VIEWS) {
      expect(parseProjectWorkspaceLocation(params(`tab=finance&view=${view}`), "ADMIN").financeView)
        .toBe(view);
    }
  });

  it("falls back rather than rendering an unknown tab or view", () => {
    expect(parseProjectWorkspaceLocation(params("tab=nonsense"), "ADMIN").tab).toBe("summary");
    expect(parseProjectWorkspaceLocation(params("tab=finance&view=nonsense"), "ADMIN").financeView)
      .toBe("certificates");
  });

  /**
   * The engineer role is enforced on the way in, not just by hiding buttons:
   * typing ?tab=finance must not open the money screens.
   */
  it("refuses a tab the role may not open, however it is reached", () => {
    for (const tab of ["finance", "contracts", "team"]) {
      const location = parseProjectWorkspaceLocation(params(`tab=${tab}`), "ENGINEER");
      expect(location.tab).toBe("summary");
      expect(projectTabsForRole("ENGINEER")).not.toContain(tab);
    }
    // Tabs an engineer may open still work.
    expect(parseProjectWorkspaceLocation(params("tab=time"), "ENGINEER").tab).toBe("time");
    expect(parseProjectWorkspaceLocation(params("tab=documents"), "ENGINEER").tab).toBe("documents");
  });
});

describe("workspace links", () => {
  it("builds a link to a tab, carrying the finance view only where it applies", () => {
    expect(projectWorkspaceSearch({ tab: "team" })).toBe("?tab=team");
    expect(projectWorkspaceSearch({ tab: "finance", financeView: "expenses" }))
      .toBe("?tab=finance&view=expenses");
    // A stale view on a non-finance tab would be noise in the URL.
    expect(projectWorkspaceSearch({ tab: "summary", financeView: "payments" }))
      .toBe("?tab=summary");
  });

  it("addresses a specific project view", () => {
    expect(projectWorkspacePath(42, { tab: "finance", financeView: "receivables" }))
      .toBe("/projects/42?tab=finance&view=receivables");
  });

  /** Activity rows and notifications resolve to a real, linkable location. */
  it("routes every activity entity to a location the URL can express", () => {
    for (const entity of [
      "contract", "payment_certificate", "payment", "expense",
      "project_assignment", "time_entry", "document", "unknown_thing",
    ]) {
      const destination = projectActivityDestination(entity);
      const parsed = parseProjectWorkspaceLocation(
        params(projectWorkspaceSearch(destination).slice(1)),
        "ADMIN",
      );
      expect(parsed.tab).toBe(destination.tab);
      if (destination.financeView) expect(parsed.financeView).toBe(destination.financeView);
    }
  });
});

describe("the workspace is split into focused components", () => {
  it("leaves ProjectDetailPage as an orchestrator", () => {
    const page = readFileSync(join(src, "features/projects/ProjectDetailPage.tsx"), "utf8");
    expect(page.split("\n").length).toBeLessThan(400);
    for (const component of [
      "ProjectSummaryTab", "ProjectContractsTab", "ProjectFinanceTab",
      "ProjectTeamTab", "ProjectTimeTab",
    ]) {
      expect(page, `must delegate to ${component}`).toContain(`./${component}`);
    }
  });

  /** Money stays owned by the read model, never recomputed in a tab. */
  it("keeps financial calculation out of the workspace components", () => {
    for (const file of [
      "ProjectSummaryTab.tsx", "ProjectContractsTab.tsx", "ProjectFinanceTab.tsx",
      "ProjectTeamTab.tsx", "ProjectTimeTab.tsx", "ProjectDetailPage.tsx",
    ]) {
      const source = readFileSync(join(src, "features/projects", file), "utf8");
      expect(source, `${file} must not compute contract state`).not.toContain("computeContractState");
      expect(source, `${file} must not compute certificates`).not.toContain("computeCertificate(");
    }
  });
});
