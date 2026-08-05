import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROJECT_FINANCE_VIEWS,
  PROJECT_WORKSPACE_TABS,
  UNKNOWN_AMOUNT,
  projectActivityDestination,
  projectAttentionSummary,
  projectTabsForRole,
  readModelAmount,
} from "../src/features/projects/projectWorkspaceModel";

describe("Milestone 4 project workspace", () => {
  it("uses the approved six-tab information architecture", () => {
    expect(PROJECT_WORKSPACE_TABS).toEqual([
      "summary",
      "contracts",
      "finance",
      "team",
      "time",
      "documents",
    ]);
    expect(PROJECT_FINANCE_VIEWS).toEqual([
      "certificates",
      "payments",
      "expenses",
      "receivables",
    ]);
    expect(projectTabsForRole("ADMIN")).toBe(PROJECT_WORKSPACE_TABS);
    expect(projectTabsForRole("ACCOUNTANT")).toBe(PROJECT_WORKSPACE_TABS);
  });

  it("keeps engineers on operational tabs without financial workspaces", () => {
    expect(projectTabsForRole("ENGINEER")).toEqual([
      "summary",
      "time",
      "documents",
    ]);
  });

  it("builds attention counts without recalculating monetary values", () => {
    expect(projectAttentionSummary({
      projectId: 7,
      overdueCertificates: 2,
      unallocatedCustomerCreditEgp: 1,
      readyToCollect: [{ projectId: 7 }, { projectId: 8 }, { projectId: 7 }],
      teamPayables: [{ projectId: 8 }, { projectId: 7 }],
    })).toEqual({
      overdueCertificates: 2,
      readyToInvoice: 2,
      unallocatedPayments: 1,
      teamPaymentsDue: 1,
    });
  });

  /**
   * Milestone 4-5 independent-audit regression. The workspace loads payments
   * and assignments from queries that resolve independently of the audited
   * financial snapshot; formatting a missing figure as zero told the user a
   * real payment or payout balance was nil.
   */
  it("never renders a figure the financial read model has not produced", () => {
    expect(readModelAmount({ egpMinor: 500_00 }, (row) => `EGP ${row.egpMinor}`))
      .toBe("EGP 50000");
    expect(readModelAmount(undefined, () => "EGP 0")).toBe(UNKNOWN_AMOUNT);
    expect(UNKNOWN_AMOUNT).not.toMatch(/\d/);
    // A genuine zero from the read model is still reported as zero.
    expect(readModelAmount({ dueMinor: 0 }, (row) => `EGP ${row.dueMinor}`))
      .toBe("EGP 0");
  });

  it("routes activity to a workspace tab without exposing technical pages", () => {
    expect(projectActivityDestination("contract_revision")).toEqual({
      tab: "contracts",
    });
    expect(projectActivityDestination("payment_certificate")).toEqual({
      tab: "finance",
      financeView: "certificates",
    });
    expect(projectActivityDestination("person_payment")).toEqual({
      tab: "team",
    });
    expect(projectActivityDestination("project_stage")).toEqual({
      tab: "summary",
    });
  });
});

/**
 * M1: the workspace summary asserted 0.00 for money it had not measured.
 *
 * The list query and the financial read model resolve independently, so on
 * every open of a project there is a window where `financials` is undefined.
 * Coalescing that to zero prints "this project has collected 0.00" when the
 * truth is "not known yet" — the exact claim readModel.ts exists to prevent,
 * made by the screen a project manager looks at first.
 */
describe("workspace summary never asserts money it has not measured", () => {
  const src = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
  const summary = readFileSync(join(src, "features/projects/ProjectSummaryTab.tsx"), "utf8");
  const clientDetail = readFileSync(join(src, "features/clients/ClientDetailPage.tsx"), "utf8");

  it("renders a placeholder rather than a formatted zero", () => {
    expect(readModelAmount(undefined, () => "EGP 0")).toBe(UNKNOWN_AMOUNT);
    expect(readModelAmount({ egp: 0 }, () => "EGP 0")).toBe("EGP 0");
  });

  it.each([
    ["contractValueEgp"],
    ["revenueEgp"],
    ["certificateCollectionsEgp"],
    ["outstandingEgp"],
    ["actualPaidCostEgp"],
    ["actualProfitEgp"],
  ])("guards %s instead of coalescing it to zero", (field) => {
    // Double-escaped on purpose: a single `\?` in a template literal is just
    // `?`, which makes the pattern a quantifier and the assertion vacuous.
    expect(summary).not.toMatch(new RegExp(`${field} \\?\\? 0`));
    expect(summary).toContain(field);
  });

  it("guards the ratios too, since a percentage over an absent figure is the same claim", () => {
    expect(summary).not.toMatch(/certifiedRatioBp \?\? 0/);
    expect(summary).not.toMatch(/collectionRatioBp \?\? 0/);
  });

  it("applies the same rule to the client detail KPIs", () => {
    expect(clientDetail).not.toMatch(/Egp \?\? 0/);
    expect(clientDetail).toContain("readModelAmount(");
  });
});
