/**
 * Comparing a local row with the cloud's copy of it.
 *
 * The desktop keeps timestamps as text such as "2026-11-07 11:53:11" (SQLite's
 * datetime('now'), UTC). The cloud stores some of the same columns as
 * timestamptz and hands them back as "2026-11-07T11:53:11+00:00". Both name
 * the same moment, but compared as text they differ — which made the sync
 * engine report a CONCURRENT_EDIT on a financial record nobody had edited.
 *
 * Everything here is for COMPARING. What is stored, pushed and shown in a
 * conflict is never rewritten.
 */

const TIMESTAMP = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|[+-]\d{2}(?::?\d{2})?)?$/;

/**
 * The same moment written one way (ISO 8601, UTC, milliseconds), or the input
 * unchanged when it is not a date-time. A date-time with no zone is UTC, as in
 * SQLite. Date-only values ("2026-07-20") are business dates, not moments, and
 * are left alone.
 */
export function canonicalTimestamp(value: string): string {
  const match = TIMESTAMP.exec(value);
  if (!match) return value;
  const [, date, time, zone] = match;
  let offset = "Z";
  if (zone && zone !== "Z") {
    const digits = zone.slice(1).replace(":", "");
    offset = `${zone[0]}${digits.slice(0, 2)}:${digits.slice(2) || "00"}`;
  }
  const withSeconds = time!.length === 5 ? `${time}:00` : time;
  const parsed = new Date(`${date}T${withSeconds}${offset}`);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

/** A row shape with every date-time string written the canonical way. */
export function canonicalizeShape(shape: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(shape)) {
    out[key] = typeof value === "string" ? canonicalTimestamp(value) : value;
  }
  return out;
}

/** Stable text of a row shape, safe to compare across spellings of a moment. */
export function comparableJson(shape: Record<string, unknown>): string {
  const canonical = canonicalizeShape(shape);
  return JSON.stringify(Object.fromEntries(Object.entries(canonical).sort(([a], [b]) => a.localeCompare(b))));
}

/** The same for a stored JSON text (a baseline or a preserved conflict side). */
export function comparableText(json: string): string {
  try {
    const parsed: unknown = JSON.parse(json);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return comparableJson(parsed as Record<string, unknown>);
  } catch {
    // not JSON: compare as written
  }
  return json;
}

/** True when two row-shape texts describe the same record, whatever the timestamp spelling. */
export function sameRecord(a: string, b: string): boolean {
  return a === b || comparableText(a) === comparableText(b);
}
