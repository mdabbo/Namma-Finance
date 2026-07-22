import { BP_SCALE, allocate, applyBp, assertMinor, mulDivRound } from "../money/money";
import { z } from "zod";

/**
 * Contract valuation breakdowns (confirmed rules):
 *  - MILESTONES: each milestone is a % of the contract value (basis points);
 *    a valid plan totals exactly 100%. Amounts are derived, never stored.
 *  - DRAWINGS: rows of (count × rate per drawing); the contract value is the
 *    derived sum of all rows.
 * Certificates remain free-form in Phase 1.x.
 */

export interface PercentMilestone {
  [key: string]: unknown;
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
  [key: string]: unknown;
  title: string;
  count: number;
  rateMinor: number;
}

export type StructuredParseResult<T> = { ok:true; value:T } | { ok:false; code:"invalid_json"|"invalid_shape"; raw:string };
export class StructuredDataError extends Error {
  constructor(public readonly field:string,public readonly code:string,public readonly raw:string){super(`${field}:${code}`);}
}

const milestoneSchema=z.object({
  title:z.string(),percentBp:z.number().int().safe().min(0),stageId:z.number().int().safe().nullable().default(null),
  done:z.boolean().default(false),certificateId:z.number().int().safe().nullable().default(null),
}).passthrough();
const drawingSchema=z.object({title:z.string(),count:z.number().int().safe().min(0),rateMinor:z.number().int().safe().min(0)}).passthrough();
const attachmentsSchema=z.array(z.string().min(1));

function parseStructured<T>(raw:string|null|undefined,schema:z.ZodType<T>):StructuredParseResult<T>{
  if(raw==null)return {ok:true,value:schema.parse([])};
  if(raw.trim()==="")return {ok:false,code:"invalid_json",raw};
  let decoded:unknown;
  try{decoded=JSON.parse(raw);}catch{return {ok:false,code:"invalid_json",raw};}
  const parsed=schema.safeParse(decoded);
  return parsed.success?{ok:true,value:parsed.data}:{ok:false,code:"invalid_shape",raw};
}

export function parseMilestonesResult(raw:string|null|undefined):StructuredParseResult<PercentMilestone[]>{
  return parseStructured(raw,z.array(milestoneSchema) as z.ZodType<PercentMilestone[]>);
}

export function parseDrawingsResult(raw:string|null|undefined):StructuredParseResult<DrawingLine[]>{
  return parseStructured(raw,z.array(drawingSchema) as z.ZodType<DrawingLine[]>);
}

export function parseAttachmentsResult(raw:string|null|undefined):StructuredParseResult<string[]>{
  return parseStructured(raw,attachmentsSchema);
}

export function parseMilestones(json: string | null | undefined): PercentMilestone[] {
  const result=parseMilestonesResult(json);
  if(!result.ok)throw new StructuredDataError("milestones",result.code,result.raw);
  return result.value;
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
): ReadyToBill {
  const amounts = milestoneAmounts(valueMinor, milestones);
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
  const result=parseDrawingsResult(json);
  if(!result.ok)throw new StructuredDataError("drawings",result.code,result.raw);
  return result.value;
}

export function milestonesTotalBp(milestones: PercentMilestone[]): number {
  return milestones.reduce((sum, m) => sum + m.percentBp, 0);
}

export function milestonesAreComplete(milestones: PercentMilestone[]): boolean {
  return milestones.length > 0 && milestonesTotalBp(milestones) === BP_SCALE;
}

/**
 * Derive milestone amounts from the contract value.
 * When the plan totals exactly 100%, amounts are allocated by largest
 * remainder so they sum EXACTLY to the contract value; otherwise each is
 * value × percent (a partial plan preview).
 */
export function milestoneAmounts(valueMinor: number, milestones: PercentMilestone[]): number[] {
  assertMinor(valueMinor, "value");
  if (milestones.length === 0) return [];
  if (milestonesAreComplete(milestones)) {
    return allocate(valueMinor, milestones.map((m) => m.percentBp));
  }
  return milestones.map((m) => applyBp(valueMinor, m.percentBp));
}

/** Contract value derived from drawing lines: Σ count × rate. */
export function drawingsValueMinor(lines: DrawingLine[]): number {
  return lines.reduce((sum, line) => sum + mulDivRound(line.rateMinor, line.count, 1), 0);
}
