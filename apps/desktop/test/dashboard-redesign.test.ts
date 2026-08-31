import { describe, expect, it } from "vitest";
import type { Expense, ProjectFinancials, ProjectStatus } from "@mep/core";
import {
  DASHBOARD_ATTENTION_ROUTES,
  DASHBOARD_PRIMARY_KPI_IDS,
  activityRoute,
  buildMonthlyCashSeries,
  selectProjectHealth,
} from "../src/features/dashboard/dashboardModel";

function expense(
  date: string,
  amountMinor: number,
  currency = "EGP",
  fxRateMicro = 1_000_000,
): Expense {
  return {
    id: 1,
    date,
    categoryId: 1,
    description: "Test",
    projectId: null,
    supplier: null,
    amountMinor,
    currency,
    fxRateMicro,
    attachmentPath: null,
    createdAt: `${date}T00:00:00.000Z`,
  };
}

function project(
  id: number,
  status: ProjectStatus,
  contractValueEgp: number,
): ProjectFinancials {
  return {
    project: { id, status, name: `Project ${id}` },
    contractValueEgp,
  } as ProjectFinancials;
}

describe("Milestone 3 dashboard model", () => {
  it("keeps exactly four primary KPIs and actionable filtered destinations", () => {
    expect(DASHBOARD_PRIMARY_KPI_IDS).toEqual([
      "contract-value",
      "cash-collected",
      "outstanding-receivables",
      "net-cash-position",
    ]);
    expect(new Set(DASHBOARD_PRIMARY_KPI_IDS).size).toBe(4);
    expect(DASHBOARD_ATTENTION_ROUTES).toEqual({
      overdue: "/finance/receivables?view=overdue",
      readyToInvoice: "/projects?view=ready-to-invoice",
      unallocated: "/finance/payments?view=unallocated",
      teamPayments: "/team/people?view=payments-due",
    });
  });

  it("builds monthly cash series in exact integer EGP piasters", () => {
    const series = buildMonthlyCashSeries(
      [
        {
          date: "2026-05-08",
          kind: "CERTIFICATE",
          projectId: 1,
          egpMinor: 120_00,
        },
        {
          date: "2026-04-03",
          kind: "ADVANCE",
          projectId: 1,
          egpMinor: 25_00,
        },
      ],
      [
        expense("2026-05-10", 40_00),
        expense("2026-04-12", 100_00, "USD", 50_000_000),
      ],
    );

    expect(series).toEqual([
      {
        month: "2026-04",
        cashInEgp: 25_00,
        cashOutEgp: 5_000_00,
        netEgp: -4_975_00,
      },
      {
        month: "2026-05",
        cashInEgp: 120_00,
        cashOutEgp: 40_00,
        netEgp: 80_00,
      },
    ]);
    for (const point of series) {
      expect(Number.isSafeInteger(point.cashInEgp)).toBe(true);
      expect(Number.isSafeInteger(point.cashOutEgp)).toBe(true);
      expect(Number.isSafeInteger(point.netEgp)).toBe(true);
    }
  });

  it("keeps completed and cancelled work out of project health", () => {
    const selected = selectProjectHealth(
      [
        project(1, "COMPLETED", 900_00),
        project(2, "ACTIVE", 200_00),
        project(3, "ON_HOLD", 500_00),
        project(4, "CANCELLED", 800_00),
        project(5, "ACTIVE", 300_00),
      ],
      2,
    );
    expect(selected.map(({ project: item }) => item.id)).toEqual([3, 5]);
  });

  it("routes recent activity to useful workspaces without exposing raw audit data", () => {
    expect(activityRoute({ entityType: "project", entityId: 42 })).toBe(
      "/projects/42",
    );
    expect(
      activityRoute({ entityType: "payment_certificate", entityId: 9 }),
    ).toBe("/finance/certificates");
    expect(activityRoute({ entityType: "payment", entityId: 8 })).toBe(
      "/finance/payments",
    );
    expect(activityRoute({ entityType: "unknown", entityId: null })).toBe(
      "/settings/audit",
    );
  });
});
