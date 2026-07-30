import { describe, expect, it } from "vitest";
import { ASSIGNMENT_LIFECYCLES, assignmentCostPosition, assignmentRaisesAlerts } from "../src";

/**
 * Lifecycle decides how an assignment's money is derived; archiving only
 * decides whether it is shown. These tests pin that separation, because
 * conflating them is what let archived assignments keep committing their full
 * agreed fee and keep raising alerts.
 */
describe("assignmentCostPosition", () => {
  it("offers exactly the three operational lifecycles", () => {
    expect(ASSIGNMENT_LIFECYCLES).toEqual(["ACTIVE", "COMPLETED", "CANCELLED"]);
  });

  it("commits the whole agreed fee while work is running", () => {
    expect(assignmentCostPosition({
      lifecycle: "ACTIVE",
      agreedMinor: 60_000,
      releasedMinor: 20_000,
      paidOutMinor: 5_000,
      earnedAtCancellationMinor: null,
    })).toEqual({ earnedMinor: 20_000, paidMinor: 5_000, dueMinor: 15_000, committedMinor: 60_000 });
  });

  it("keeps a finished assignment committed and its unpaid earnings payable", () => {
    expect(assignmentCostPosition({
      lifecycle: "COMPLETED",
      agreedMinor: 60_000,
      releasedMinor: 45_000,
      paidOutMinor: 45_000,
      earnedAtCancellationMinor: null,
    })).toEqual({ earnedMinor: 45_000, paidMinor: 45_000, dueMinor: 0, committedMinor: 60_000 });

    expect(assignmentCostPosition({
      lifecycle: "COMPLETED",
      agreedMinor: 60_000,
      releasedMinor: 45_000,
      paidOutMinor: 10_000,
      earnedAtCancellationMinor: null,
    }).dueMinor).toBe(35_000);
  });

  /** The point of cancelling: the unearned remainder stops being committed. */
  it("drops the unearned remainder when cancelled", () => {
    expect(assignmentCostPosition({
      lifecycle: "CANCELLED",
      agreedMinor: 60_000,
      releasedMinor: 45_000,
      paidOutMinor: 5_000,
      earnedAtCancellationMinor: 12_000,
    })).toEqual({ earnedMinor: 12_000, paidMinor: 5_000, dueMinor: 7_000, committedMinor: 12_000 });
  });

  it("cancels an unstarted assignment to nothing at all", () => {
    expect(assignmentCostPosition({
      lifecycle: "CANCELLED",
      agreedMinor: 60_000,
      releasedMinor: 0,
      paidOutMinor: 0,
      earnedAtCancellationMinor: 0,
    })).toEqual({ earnedMinor: 0, paidMinor: 0, dueMinor: 0, committedMinor: 0 });
  });

  /**
   * A cancelled assignment must ignore later releases: the client paying more
   * certificates cannot accrue value to work that stopped.
   */
  it("ignores releases that happen after cancellation", () => {
    const position = assignmentCostPosition({
      lifecycle: "CANCELLED",
      agreedMinor: 60_000,
      releasedMinor: 60_000,
      paidOutMinor: 0,
      earnedAtCancellationMinor: 12_000,
    });
    expect(position.earnedMinor).toBe(12_000);
    expect(position.committedMinor).toBe(12_000);
  });

  it("never reports a negative balance when overpaid", () => {
    expect(assignmentCostPosition({
      lifecycle: "ACTIVE",
      agreedMinor: 60_000,
      releasedMinor: 10_000,
      paidOutMinor: 25_000,
      earnedAtCancellationMinor: null,
    }).dueMinor).toBe(0);
  });

  /**
   * Regression: person payments are not capped, so paid can exceed the agreed
   * fee or the frozen earned figure. Committed cost must never report less than
   * cash already spent, or project committed/accrued/actual stop reconciling.
   */
  it("never commits less than what was actually paid out", () => {
    expect(assignmentCostPosition({
      lifecycle: "CANCELLED",
      agreedMinor: 60_000,
      releasedMinor: 45_000,
      paidOutMinor: 50_000,
      earnedAtCancellationMinor: 12_000,
    })).toMatchObject({ earnedMinor: 12_000, paidMinor: 50_000, dueMinor: 0, committedMinor: 50_000 });

    expect(assignmentCostPosition({
      lifecycle: "ACTIVE",
      agreedMinor: 60_000,
      releasedMinor: 10_000,
      paidOutMinor: 75_000,
      earnedAtCancellationMinor: null,
    }).committedMinor).toBe(75_000);

    expect(assignmentCostPosition({
      lifecycle: "COMPLETED",
      agreedMinor: 60_000,
      releasedMinor: 60_000,
      paidOutMinor: 61_000,
      earnedAtCancellationMinor: null,
    }).committedMinor).toBe(61_000);
  });

  it("treats a cancelled assignment with no frozen figure as having earned nothing", () => {
    expect(assignmentCostPosition({
      lifecycle: "CANCELLED",
      agreedMinor: 60_000,
      releasedMinor: 45_000,
      paidOutMinor: 0,
      earnedAtCancellationMinor: null,
    }).earnedMinor).toBe(0);
  });
});

describe("assignmentRaisesAlerts", () => {
  it("alerts only for visible assignments that owe money", () => {
    expect(assignmentRaisesAlerts({ archived: false, personArchived: false, dueMinor: 100 })).toBe(true);
    expect(assignmentRaisesAlerts({ archived: false, personArchived: false, dueMinor: 0 })).toBe(false);
  });

  it("stays silent for archived assignments and archived people", () => {
    expect(assignmentRaisesAlerts({ archived: true, personArchived: false, dueMinor: 100 })).toBe(false);
    expect(assignmentRaisesAlerts({ archived: false, personArchived: true, dueMinor: 100 })).toBe(false);
  });
});
