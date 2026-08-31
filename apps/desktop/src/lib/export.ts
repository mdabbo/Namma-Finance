import * as XLSX from "xlsx";
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile, writeTextFile } from "@tauri-apps/plugin-fs";

/**
 * Report exports. SheetJS builds the workbook in memory; the file is written
 * through the Tauri fs plugin after a save dialog (browser-style downloads
 * don't exist inside the WebView).
 */

export async function exportXlsx(defaultName: string, sheetName: string, rows: Record<string, unknown>[]): Promise<boolean> {
  const path = await save({
    defaultPath: `${defaultName}.xlsx`,
    filters: [{ name: "Excel", extensions: ["xlsx"] }],
  });
  if (!path) return false;
  const sheet = XLSX.utils.json_to_sheet(sanitizeExportRows(rows));
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, sheetName.slice(0, 31));
  const buffer = XLSX.write(book, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
  await writeFile(path, new Uint8Array(buffer));
  return true;
}

export async function exportCsv(defaultName: string, rows: Record<string, unknown>[]): Promise<boolean> {
  const path = await save({
    defaultPath: `${defaultName}.csv`,
    filters: [{ name: "CSV", extensions: ["csv"] }],
  });
  if (!path) return false;
  const sheet = XLSX.utils.json_to_sheet(sanitizeExportRows(rows));
  const csv = XLSX.utils.sheet_to_csv(sheet);
  // BOM so Excel opens Arabic text correctly
  await writeTextFile(path, "﻿" + csv);
  return true;
}

/**
 * A cell a spreadsheet would evaluate rather than read.
 *
 * A negative NUMBER is not one of them. Quoting `-1234.50` to defend against
 * formula injection turns every loss, negative margin and credit note into
 * text, which a spreadsheet will not sum — so a workbook of financial results
 * silently stops adding up in exactly the rows that matter most. A leading
 * `-` is only dangerous when what follows is not a plain number.
 *
 * Shared with `buildCsv` in DataTable so table exports and report exports
 * cannot disagree about what is safe to write.
 */
export const NUMERIC_CELL = /^-?\d+(\.\d+)?$/;

export function isFormulaInjectionRisk(value: string): boolean {
  if (NUMERIC_CELL.test(value)) return false;
  // Control characters are deliberate: a payload can hide behind a leading tab
  // or NUL and still be evaluated once the cell is opened.
  // eslint-disable-next-line no-control-regex
  return /^[\s\u0000-\u001f]*[=+\-@]/.test(value);
}

/** Prevent CSV/Excel formula execution when exported text is opened. */
export function sanitizeExportCell(value: unknown): unknown {
  return typeof value === "string" && isFormulaInjectionRisk(value) ? `'${value}` : value;
}

export function sanitizeExportRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, sanitizeExportCell(value)])));
}

/** Read an Excel file into an array of row objects keyed by header text. */
export function parseWorkbook(data: Uint8Array): { sheets: string[]; read: (sheet: string) => Record<string, unknown>[] } {
  const book = XLSX.read(data, { type: "array", cellDates: true });
  return {
    sheets: book.SheetNames,
    read: (sheet: string) =>
      XLSX.utils.sheet_to_json<Record<string, unknown>>(book.Sheets[sheet]!, { defval: null, raw: true }),
  };
}
