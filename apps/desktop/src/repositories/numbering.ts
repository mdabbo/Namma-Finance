import { execute, selectOne } from "../lib/db";
import { atomicCommand } from "../lib/atomic";
import { withLock } from "../lib/mutex";

export type SequenceType = "PROJECT" | "CONTRACT" | "CERTIFICATE" | "PAYMENT" | "EXPENSE";

const SEQUENCE_SOURCES: Record<SequenceType, { table: string; column: string; width: number }> = {
  PROJECT: { table: "projects", column: "code", width: 3 },
  CONTRACT: { table: "contracts", column: "number", width: 4 },
  CERTIFICATE: { table: "payment_certificates", column: "number", width: 4 },
  PAYMENT: { table: "payments", column: "number", width: 4 },
  EXPENSE: { table: "expenses", column: "number", width: 4 },
};

export function reserveNextNumber(type: SequenceType, prefix: string, date = new Date()): Promise<string> {
  return withLock(() => reserveNextNumberWithinExistingLock(type, prefix, date));
}

/**
 * For workflows already holding the global mutation lock.
 *
 * The reservation reads the highest number already issued and bumps the counter
 * past it, so the read and the write cannot be separable: two reservations that
 * both read the same maximum would hand out the same number. Rust owns that
 * boundary — see `reserve_next_number_atomic`.
 */
export async function reserveNextNumberWithinExistingLock(type: SequenceType, prefix: string, date: Date): Promise<string> {
  const clean = prefix.trim().toUpperCase();
  if (!/^[A-Z0-9]{1,12}$/.test(clean)) throw new Error("INVALID_NUMBER_PREFIX");
  const year = date.getUTCFullYear();
  return atomicCommand<string>(
    "reserve_next_number_atomic",
    { sequenceType: type, prefix: clean, year },
    () => reserveWithinTransaction(type, clean, year),
  );
}

async function reserveWithinTransaction(type: SequenceType, clean: string, year: number): Promise<string> {
  const source = SEQUENCE_SOURCES[type];
  await execute("INSERT OR IGNORE INTO numbering_sequences(sequence_type,year,prefix,last_number) VALUES($1,$2,$3,0)", [type, year, clean]);
  const stem = `${clean}-${year}-`;
  const existing = await selectOne<{ max_number: number | null }>(
    `SELECT MAX(CAST(substr(${source.column},length($1)+1) AS INTEGER)) AS max_number FROM ${source.table} WHERE ${source.column} LIKE $2`,
    [stem, `${stem}%`],
  );
  await execute("UPDATE numbering_sequences SET last_number=MAX(last_number,$1)+1 WHERE sequence_type=$2 AND year=$3 AND prefix=$4", [existing?.max_number ?? 0, type, year, clean]);
  const row = await selectOne<{ last_number: number }>("SELECT last_number FROM numbering_sequences WHERE sequence_type=$1 AND year=$2 AND prefix=$3", [type, year, clean]);
  if (!row) throw new Error("NUMBER_RESERVATION_FAILED");
  return `${clean}-${year}-${String(row.last_number).padStart(source.width, "0")}`;
}
