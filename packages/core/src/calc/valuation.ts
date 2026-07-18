import { BP_SCALE, allocate, applyBp, assertMinor, mulDivRound, ratioBp } from "../money/money";

/**
 * Contract valuation breakdowns (confirmed rules):
 *  - MILESTONES: each milestone is a % of the contract value (basis points);
 *    a valid plan totals exactly 100%. Amounts are derived, never stored.
 *  - DRAWINGS: rows of (count × rate per drawing); the contract value is the
 *    derived sum of all rows.
 * Certificates remain free-form in Phase 1.x.
 */

export interface PercentMilestone {
  title: string;
  percentBp: number;
  /** Linked project stage — the milestone is achieved when that stage completes. */
  stageId?: number | null;
  /** Manual "achieved" flag (checked by the user). */
  done?: boolean;
  /** Draft certificate auto-prepared when this milestone was achieved. */
  certificateId?: number | null;
}

export interface DrawingLine {
  title: string;
  count: number;
  rateMinor: number;
}

export function parseMilestones(json: string | null | undefined): PercentMilestone[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((m) => m && typeof m.title === "string" && Number.isSafeInteger(m.percentBp) && m.percentBp >= 0)
      .map((m) => ({
        title: m.title,
        percentBp: m.percentBp,
        stageId: Number.isSafeInteger(m.stageId) ? m.stageId : null,
        done: m.done === true,
        certificateId: Number.isSafeInteger(m.certificateId) ? m.certificateId : null,
      }));
  } catch {
    return [];
  }
}

/**
 * A milestone counts as ACHIEVED when its linked stage is completed, or when
 * it was manually checked (items without a linked stage rely on the checkbox).
 */
export function isMilestoneAchieved(milestone: PercentMilestone, completedStageIds: ReadonlySet<number>): boolean {
  if (milestone.done) return true;
  return milestone.stageId != null && completedStageIds.has(milestone.stageId);
}

export interface ReadyToBill {
  /** Achieved milestone value not yet certified — what can be billed now. */
  readyMinor: number;
  achievedMinor: number;
  achievedTitles: string[];
}

/**
 * Compare achieved milestone value against what has already been certified on
 * the contract. Positive `readyMinor` = work the client owes a certificate for.
 */
export function computeReadyToBill(
  valueMinor: number,
  milestones: PercentMilestone[],
  completedStageIds: ReadonlySet<number>,
  certifiedBaseMinor: number,
  advanceBp = 0,
): ReadyToBill {
  const amounts = milestoneAmounts(valueMinor, milestones, advanceBp);
  let achieved = 0;
  const titles: string[] = [];
  milestones.forEach((m, i) => {
    if (isMilestoneAchieved(m, completedStageIds)) {
      achieved += amounts[i] ?? 0;
      titles.push(m.title);
    }
  });
  return {
    readyMinor: Math.max(0, achieved - certifiedBaseMinor),
    achievedMinor: achieved,
    achievedTitles: titles,
  };
}

export function parseDrawings(json: string | null | undefined): DrawingLine[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter(
        (d) =>
          d &&
          typeof d.title === "string" &&
          Number.isSafeInteger(d.count) &&
          d.count >= 0 &&
          Number.isSafeInteger(d.rateMinor) &&
          d.rateMinor >= 0,
      )
      .map((d) => ({ title: d.title, count: d.count, rateMinor: d.rateMinor }));
  } catch {
    return [];
  }
}

export function milestonesTotalBp(milestones: PercentMilestone[]): number {
  return milestones.reduce((sum, m) => sum + m.percentBp, 0);
}

/** The advance's share of the contract value, in basis points. */
export function advanceShareBp(contract: { valueMinor: number; advanceMinor: number }): number {
  if (contract.valueMinor <= 0 || contract.advanceMinor <= 0) return 0;
  return ratioBp(Math.min(contract.advanceMinor, contract.valueMinor), contract.valueMinor);
}

/**
 * A plan is complete when the milestones total 100%, OR — for contracts with
 * a down payment — when advance% + milestones% = 100% (the payment-schedule
 * style: "40% advance, then 20% at each deliverable"). In the second style
 * each milestone's percent is what the CLIENT PAYS at that stage; the
 * certificate base behind it is scaled to the full value, and proportional
 * advance recovery brings its net back to exactly the stated percent.
 */
export function milestonesAreComplete(milestones: PercentMilestone[], advanceBp = 0): boolean {
  if (milestones.length === 0) return false;
  const total = milestonesTotalBp(milestones);
  return total === BP_SCALE || (advanceBp > 0 && total === BP_SCALE - advanceBp);
}

/**
 * Derive milestone CERTIFICATE BASE amounts from the contract value.
 * Complete plans (either style — see milestonesAreComplete) are allocated by
 * largest remainder over the relative weights so they sum EXACTLY to the
 * contract value; otherwise each is value × percent (a partial plan preview).
 */
export function milestoneAmounts(valueMinor: number, milestones: PercentMilestone[], advanceBp = 0): number[] {
  assertMinor(valueMinor, "value");
  if (milestones.length === 0) return [];
  if (milestonesAreComplete(milestones, advanceBp)) {
    return allocate(valueMinor, milestones.map((m) => m.percentBp));
  }
  return milestones.map((m) => applyBp(valueMinor, m.percentBp));
}

/** Contract value derived from drawing lines: Σ count × rate. */
export function drawingsValueMinor(lines: DrawingLine[]): number {
  return lines.reduce((sum, line) => sum + mulDivRound(line.rateMinor, line.count, 1), 0);
}
