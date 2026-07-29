import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/db", async () => await import("./db-harness"));

import { resetDb } from "./db-harness";
import {
  ONBOARDING_STEPS,
  onboardingDestination,
  onboardingStatus,
} from "../src/features/onboarding/onboardingModel";
import {
  createDemoWorkspace,
  parseDemoWorkspace,
  removeDemoWorkspace,
} from "../src/repositories/demo";
import { listCertificates } from "../src/repositories/certificates";
import { listPayments } from "../src/repositories/payments";
import { listExpenses } from "../src/repositories/expenses";
import { deleteProject } from "../src/repositories/projects";
import { deleteClient } from "../src/repositories/clients";
import { loadWorkspaceFinancials } from "../src/repositories/financials";
import { loadSettings } from "../src/lib/settings";

describe("Milestone 6 onboarding model", () => {
  const baseInputs = {
    companyName: "",
    currencyConfirmed: false,
    numberingConfirmed: false,
    clientCount: 0,
    projectCount: 0,
    contractCount: 0,
    skipped: false,
  };

  it("walks the six approved steps in order and derives progress from real state", () => {
    expect(ONBOARDING_STEPS).toEqual([
      "company",
      "currency",
      "numbering",
      "client",
      "project",
      "contract",
    ]);
    const fresh = onboardingStatus(baseInputs);
    expect(fresh.completedCount).toBe(0);
    expect(fresh.nextStep).toBe("company");
    expect(fresh.showPanel).toBe(true);

    const midway = onboardingStatus({
      ...baseInputs,
      companyName: "NAMAA Engineering",
      currencyConfirmed: true,
      numberingConfirmed: true,
      clientCount: 1,
    });
    expect(midway.completedCount).toBe(4);
    expect(midway.nextStep).toBe("project");

    const done = onboardingStatus({
      ...baseInputs,
      companyName: "NAMAA Engineering",
      currencyConfirmed: true,
      numberingConfirmed: true,
      clientCount: 1,
      projectCount: 1,
      contractCount: 1,
    });
    expect(done.finished).toBe(true);
    expect(done.showPanel).toBe(false);
  });

  it("hides the panel when skipped but keeps derived progress intact", () => {
    const skipped = onboardingStatus({ ...baseInputs, clientCount: 2, skipped: true });
    expect(skipped.showPanel).toBe(false);
    expect(skipped.finished).toBe(false);
    expect(skipped.completedCount).toBe(1);
  });

  it("sends each step to its workspace destination", () => {
    expect(onboardingDestination("company", null)).toBe("/settings");
    expect(onboardingDestination("client", null)).toBe("/projects/clients");
    expect(onboardingDestination("contract", null)).toBe("/projects");
    expect(onboardingDestination("contract", 12)).toBe("/projects/12");
  });
});

describe("Milestone 6 demo workspace", () => {
  beforeEach(() => resetDb());

  it("loads a marked, realistic workspace and removes it from every surface", async () => {
    await createDemoWorkspace();

    const refs = parseDemoWorkspace((await loadSettings()).demoWorkspace);
    expect(refs).not.toBeNull();
    expect(refs!.projectIds).toHaveLength(2);

    const certificates = await listCertificates();
    expect(certificates).toHaveLength(3);
    expect(certificates.every((row) => row.number.startsWith("DEMOPC-"))).toBe(true);
    // The payment allocation drove one certificate to PAID via real evidence rules.
    expect(certificates.some((row) => row.status === "PAID")).toBe(true);
    expect(await listPayments()).toHaveLength(1);
    expect(await listExpenses()).toHaveLength(2);

    const workspace = await loadWorkspaceFinancials();
    expect(workspace.projects).toHaveLength(2);
    const overdueCount = workspace.projects.reduce(
      (total, project) => total + project.overdueCertificates,
      0,
    );
    expect(overdueCount).toBe(1);
    expect(workspace.teamAccounts).toHaveLength(1);

    await removeDemoWorkspace();
    expect((await loadSettings()).demoWorkspace).toBe("");
    expect(await listCertificates()).toHaveLength(0);
    expect(await listPayments()).toHaveLength(0);
    expect(await listExpenses()).toHaveLength(0);
    expect((await loadWorkspaceFinancials()).projects).toHaveLength(0);
  });

  it("can be reloaded after removal without number collisions", async () => {
    await createDemoWorkspace();
    await removeDemoWorkspace();
    await createDemoWorkspace();
    expect(await listCertificates()).toHaveLength(3);
    await expect(createDemoWorkspace()).rejects.toThrow("DEMO_ALREADY_LOADED");
  });

  /**
   * Milestone 6 independent-audit regression. Demo records are ordinary rows
   * the user can archive from the normal pages. Removal used to abort on the
   * first already-archived record, leaving the demo flag set and the demo
   * overhead expense permanently reducing the real net cash position with no
   * way to withdraw it.
   */
  it("still withdraws everything after the user archived some demo records", async () => {
    await createDemoWorkspace();
    const refs = parseDemoWorkspace((await loadSettings()).demoWorkspace)!;

    await deleteProject(refs.projectIds[0]!);
    await deleteClient(refs.clientIds[0]!);

    await removeDemoWorkspace();

    expect((await loadSettings()).demoWorkspace).toBe("");
    expect(await listExpenses()).toHaveLength(0);
    expect(await listCertificates()).toHaveLength(0);
    expect((await loadWorkspaceFinancials()).projects).toHaveLength(0);
  });

  it("joins a concurrent load instead of seeding a second unremovable workspace", async () => {
    await Promise.all([createDemoWorkspace(), createDemoWorkspace()]);
    expect(await listCertificates()).toHaveLength(3);

    await removeDemoWorkspace();
    expect(await listCertificates()).toHaveLength(0);
    expect(await listExpenses()).toHaveLength(0);
  });
});
