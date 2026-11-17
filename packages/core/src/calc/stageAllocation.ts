import { allocate, assertMinor } from "../money/money";

/**
 * Per-contract fees for a team assignment.
 *
 * An assignment normally carries ONE agreed fee that is split across every
 * stage of the project's contracts by value share, which gives uneven cents
 * whenever the contracts differ in size. A fee may instead be fixed PER
 * CONTRACT ("20,000 for contract 0004, 18,000 for contract 0006"); that
 * contract's stages then split exactly that fee by their own shares.
 *
 * Stored on the assignment as JSON `{ "<contract number>": <fee minor> }`. The
 * key is the contract NUMBER, not its local id, because local ids differ from
 * device to device while numbers travel through sync unchanged.
 *
 * Rules (mirrored 1:1 by `allocate_stage_amounts` in the Rust engine; the
 * shared cases live in fixtures/team-payout.json):
 *  - a fee for a contract that is not on the project is ignored;
 *  - fees are applied in contract order and each is capped at what is left of
 *    the agreed fee, so the stages never add up to more than agreed;
 *  - contracts WITHOUT a fee share what is left (agreed − applied fees)
 *    proportionally, exactly as before — so an assignment with no fees at all
 *    behaves identically to the single-fee rule.
 */
export type ContractFees = Record<string, number>;

export interface AllocationStage {
  contractNumber: string;
  weightMinor: number;
}

/** Parse the stored JSON. Malformed or non-integer entries are dropped, never thrown. */
export function parseContractFees(raw: string | null | undefined): ContractFees {
  if (!raw || !raw.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const fees: ContractFees = {};
  for (const [number, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) fees[number] = value;
  }
  return fees;
}

export function serializeContractFees(fees: ContractFees): string | null {
  const entries = Object.entries(fees).filter(([, v]) => Number.isSafeInteger(v) && v >= 0);
  return entries.length === 0 ? null : JSON.stringify(Object.fromEntries(entries));
}

/**
 * Split `agreedMinor` over `stages`. `stages` must already be in schedule
 * order (contracts ascending by id). Returns one amount per stage.
 */
export function allocateStageAmounts(
  agreedMinor: number,
  stages: AllocationStage[],
  fees: ContractFees = {},
): number[] {
  assertMinor(agreedMinor, "agreedMinor");
  const amounts = new Array<number>(stages.length).fill(0);

  // Contract order = order of first appearance in the schedule.
  const order: string[] = [];
  for (const s of stages) if (!order.includes(s.contractNumber)) order.push(s.contractNumber);

  let remaining = agreedMinor;
  const feed = new Set<string>();
  for (const number of order) {
    const fee = fees[number];
    if (fee === undefined) continue;
    const applied = Math.min(fee, remaining);
    remaining -= applied;
    feed.add(number);
    const indexes = stages.flatMap((s, i) => (s.contractNumber === number ? [i] : []));
    const parts = allocate(applied, indexes.map((i) => stages[i]!.weightMinor));
    indexes.forEach((stageIndex, k) => {
      amounts[stageIndex] = parts[k] ?? 0;
    });
  }

  const free = stages.flatMap((s, i) => (feed.has(s.contractNumber) ? [] : [i]));
  if (free.length > 0) {
    const parts = allocate(remaining, free.map((i) => stages[i]!.weightMinor));
    free.forEach((stageIndex, k) => {
      amounts[stageIndex] = parts[k] ?? 0;
    });
  }
  return amounts;
}
