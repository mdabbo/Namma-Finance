import { describe, expect, it } from "vitest";
import {
  PROJECT_FINANCE_VIEWS,
  PROJECT_WORKSPACE_TABS,
  projectActivityDestination,
  projectAttentionSummary,
  projectTabsForRole,
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
