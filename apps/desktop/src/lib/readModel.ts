/**
 * Presenting figures the financial read model owns.
 *
 * List queries and the financial read model are separate queries that resolve
 * independently, so a table can be on screen while its money is still loading.
 * Coalescing that gap to zero prints a definite financial claim — "this client
 * has collected 0.00" — when the truth is "not known yet". On screen that is
 * misleading for a moment; exported to CSV it becomes a saved, shareable file
 * asserting a figure that was never measured.
 *
 * A missing row is therefore rendered as "not known" and exported as blank. A
 * real zero still prints as zero, because a measured nil is a fact.
 */

/** Shown when the audited read model has no figure for a row yet. */
export const UNKNOWN_AMOUNT = "—";

export function readModelAmount<T>(
  record: T | undefined,
  format: (record: T) => string,
): string {
  return record === undefined ? UNKNOWN_AMOUNT : format(record);
}

/**
 * The export counterpart. An empty cell reads as "no value" in a spreadsheet,
 * where "0" would be summed as a real amount.
 */
export function readModelExport<T>(
  record: T | null | undefined,
  format: (record: T) => string,
): string {
  return record === null || record === undefined ? "" : format(record);
}

/** Render a figure the read model has not produced yet. */
export function readModelDisplay<T>(
  record: T | null | undefined,
  format: (record: T) => string,
): string {
  return record === null || record === undefined ? UNKNOWN_AMOUNT : format(record);
}
