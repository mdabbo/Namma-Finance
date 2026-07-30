/**
 * Assignment lifecycle and its effect on project cost.
 *
 * Archiving used to be the only signal available, and it could not say whether
 * work was finished or called off — so an archived assignment kept committing
 * its full agreed fee and kept raising payment alerts. Lifecycle answers "what
 * happened to the work"; archiving answers "is it still shown". They are
 * deliberately separate, so a completed assignment can be archived without
 * pretending its unpaid earned value went away.
 */
export type AssignmentLifecycle = "ACTIVE" | "COMPLETED" | "CANCELLED";

export const ASSIGNMENT_LIFECYCLES: readonly AssignmentLifecycle[] = [
  "ACTIVE",
  "COMPLETED",
  "CANCELLED",
];

export interface AssignmentCostInput {
  lifecycle: AssignmentLifecycle;
  /** The agreed fee for the whole scope. */
  agreedMinor: number;
  /** Fee released by client certificates that have been paid, computed live. */
  releasedMinor: number;
  /** Real person-payment records posted against the assignment. */
  paidOutMinor: number;
  /**
   * Earned value frozen when the assignment was cancelled. Required for
   * CANCELLED: without it, certificates the client pays afterwards would keep
   * accruing to work that was called off.
   */
  earnedAtCancellationMinor: number | null;
}

export interface AssignmentCostPosition {
  /** What the person has earned — the basis for what is owed. */
  earnedMinor: number;
  paidMinor: number;
  /** Earned less paid, floored at zero: payable to the person now. */
  dueMinor: number;
  /**
   * Cost the project has committed to. ACTIVE and COMPLETED carry the whole
   * agreed fee, because the scope is either still running or done and will be
   * owed as the client pays. CANCELLED carries only what was earned, so the
   * unearned remainder stops inflating the project's committed cost.
   */
  committedMinor: number;
}

export function assignmentCostPosition(input: AssignmentCostInput): AssignmentCostPosition {
  const paidMinor = Math.max(0, input.paidOutMinor);
  const earnedMinor =
    input.lifecycle === "CANCELLED"
      ? Math.max(0, input.earnedAtCancellationMinor ?? 0)
      : Math.max(0, input.releasedMinor);
  const committedMinor =
    input.lifecycle === "CANCELLED" ? earnedMinor : Math.max(0, input.agreedMinor);
  return {
    earnedMinor,
    paidMinor,
    dueMinor: Math.max(0, earnedMinor - paidMinor),
    committedMinor,
  };
}

/**
 * Whether an assignment should still raise operational team-payment alerts.
 *
 * Money already earned stays owed and stays in the project's cost whatever the
 * visibility state, but an archived assignment — or one belonging to an
 * archived person — must stop generating new work for the office.
 */
export function assignmentRaisesAlerts(input: {
  archived: boolean;
  personArchived: boolean;
  dueMinor: number;
}): boolean {
  return !input.archived && !input.personArchived && input.dueMinor > 0;
}
