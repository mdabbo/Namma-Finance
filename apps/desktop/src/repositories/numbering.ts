import { execute, selectOne } from "../lib/db";
import { withLock } from "../lib/mutex";

export type SequenceType = "PROJECT" | "CONTRACT" | "CERTIFICATE" | "PAYMENT" | "EXPENSE";

export function reserveNextNumber(type: SequenceType, prefix: string, date = new Date()): Promise<string> {
  return withLock(() => reserveNextNumberWithinExistingLock(type, prefix, date));
}

/** For workflows already holding the global mutation lock. */
export async function reserveNextNumberWithinExistingLock(type: SequenceType, prefix: string, date: Date): Promise<string> {
  const clean = prefix.trim().toUpperCase();
  if (!/^[A-Z0-9]{1,12}$/.test(clean)) throw new Error("INVALID_NUMBER_PREFIX");
  const year = date.getUTCFullYear();
  await execute("BEGIN IMMEDIATE");
  try {
    await execute("INSERT OR IGNORE INTO numbering_sequences(sequence_type,year,prefix,last_number) VALUES($1,$2,$3,0)", [type, year, clean]);
    const source = type === "PROJECT" ? { table: "projects", column: "code" } :
      type === "CONTRACT" ? { table: "contracts", column: "number" } :
      type === "CERTIFICATE" ? { table: "payment_certificates", column: "number" } :
      type === "PAYMENT" ? { table: "payments", column: "number" } : { table: "expenses", column: "number" };
    const stem = `${clean}-${year}-`;
    const existing = await selectOne<{ max_number: number | null }>(
      `SELECT MAX(CAST(substr(${source.column},length($1)+1) AS INTEGER)) AS max_number FROM ${source.table} WHERE ${source.column} LIKE $2`,
      [stem, `${stem}%`],
    );
    await execute("UPDATE numbering_sequences SET last_number=MAX(last_number,$1) WHERE sequence_type=$2 AND year=$3 AND prefix=$4", [existing?.max_number ?? 0, type, year, clean]);
    await execute("UPDATE numbering_sequences SET last_number=last_number+1 WHERE sequence_type=$1 AND year=$2 AND prefix=$3", [type, year, clean]);
    const row = await selectOne<{ last_number: number }>("SELECT last_number FROM numbering_sequences WHERE sequence_type=$1 AND year=$2 AND prefix=$3", [type, year, clean]);
    if (!row) throw new Error("NUMBER_RESERVATION_FAILED");
    await execute("COMMIT");
    return `${clean}-${year}-${String(row.last_number).padStart(type === "PROJECT" ? 3 : 4, "0")}`;
  } catch (error) {
    await execute("ROLLBACK");
    throw error;
  }
}
