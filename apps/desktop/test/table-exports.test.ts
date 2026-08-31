import { describe, expect, it } from "vitest";
import { buildCsv, type Column } from "../src/components/DataTable";
import { minorToInput } from "../src/lib/format";
import { isFormulaInjectionRisk, sanitizeExportCell } from "../src/lib/export";
import { UNKNOWN_AMOUNT, readModelDisplay, readModelExport } from "../src/lib/readModel";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const src = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const read = (relative: string) => readFileSync(join(src, relative), "utf8");

/**
 * Milestone 6: DataTable supported CSV export and saved views, but only one
 * page enabled them. These assertions pin that every major list keeps them —
 * a list that silently loses its export is the exact regression this milestone
 * exists to fix.
 */
const LISTS: { file: string; exportName: string; viewKey: string }[] = [
  { file: "features/projects/ProjectsPage.tsx", exportName: "projects", viewKey: "projects" },
  { file: "features/clients/ClientsPage.tsx", exportName: "clients", viewKey: "clients" },
  { file: "features/certificates/CertificatesPage.tsx", exportName: "certificates", viewKey: "certificates" },
  { file: "features/payments/PaymentsPage.tsx", exportName: "payments", viewKey: "payments" },
  { file: "features/expenses/ExpensesPage.tsx", exportName: "expenses", viewKey: "expenses" },
  { file: "features/finance/ReceivablesPage.tsx", exportName: "receivables", viewKey: "finance-receivables" },
  { file: "features/people/PeoplePage.tsx", exportName: "people", viewKey: "people" },
  { file: "features/time/TimePage.tsx", exportName: "time-entries", viewKey: "time-entries" },
];

describe("major lists export and remember views", () => {
  it.each(LISTS)("$exportName enables export and saved views", ({ file, exportName, viewKey }) => {
    const source = read(file);
    expect(source, `${file} must enable CSV export`).toContain(`exportName="${exportName}"`);
    expect(source, `${file} must enable saved views`).toContain(`viewKey="${viewKey}"`);
  });

  /**
   * A saved view that drops the page's filters looks applied while showing the
   * wrong rows, so every list that has filter controls must round-trip them.
   */
  it.each(LISTS.filter((list) => list.exportName !== "time-entries"))(
    "$exportName saves and restores its page filters",
    ({ file }) => {
      const source = read(file);
      expect(source, `${file} must pass its filter state`).toMatch(/filters=\{/);
      expect(source, `${file} must restore filters`).toContain("onApplyFilters");
      expect(source, `${file} must support resetting filters`).toContain("onResetFilters");
    },
  );
});

describe("money columns never export minor units", () => {
  /**
   * `value` carries integer minor units so sorting stays exact. Exporting that
   * verbatim writes piasters into a column a spreadsheet sums as pounds — a
   * silent 100x overstatement — so every money column needs its own
   * `exportValue` in major units.
   */
  const MONEY_COLUMNS: { file: string; keys: string[] }[] = [
    { file: "features/projects/ProjectsPage.tsx", keys: ["value"] },
    { file: "features/clients/ClientsPage.tsx", keys: ["contracts", "certificateCollections", "totalCashIn", "outstanding"] },
    { file: "features/certificates/CertificatesPage.tsx", keys: ["gross", "net", "unpaid"] },
    { file: "features/payments/PaymentsPage.tsx", keys: ["amount", "unallocated"] },
    { file: "features/expenses/ExpensesPage.tsx", keys: ["amount"] },
    { file: "features/finance/ReceivablesPage.tsx", keys: ["unpaid", "unpaidBase"] },
    { file: "features/people/PeoplePage.tsx", keys: ["monthly", "hourly"] },
    { file: "features/time/TimePage.tsx", keys: ["cost"] },
  ];

  it.each(MONEY_COLUMNS)("$file converts its money columns for export", ({ file, keys }) => {
    const source = read(file);
    for (const key of keys) {
      const start = source.indexOf(`key: "${key}"`);
      expect(start, `${file} has no column ${key}`).toBeGreaterThan(-1);
      // The column block ends where the next one begins.
      const block = source.slice(start, start + 700);
      expect(block, `${file} column ${key} must export major units`).toContain("exportValue:");
    }
    // Conversion goes through minorToInput with a currency exponent, either
    // inline or via the page's consolidated-export helper.
    expect(source, `${file} must convert minor units for export`).toMatch(/minorToInput\(/);
    expect(source, `${file} must use a currency exponent`).toMatch(/currencyInfo\(/);
  });

  /** Amounts are meaningless without the currency they are denominated in. */
  it.each([
    "features/certificates/CertificatesPage.tsx",
    "features/payments/PaymentsPage.tsx",
    "features/expenses/ExpensesPage.tsx",
    "features/people/PeoplePage.tsx",
    "features/time/TimePage.tsx",
    "features/finance/ReceivablesPage.tsx",
  ])("%s carries a currency column", (file) => {
    expect(read(file)).toContain(`key: "currency"`);
  });

  /** Consolidated columns name their currency in the header instead. */
  it.each([
    "features/projects/ProjectsPage.tsx",
    "features/clients/ClientsPage.tsx",
  ])("%s names the reporting currency in consolidated headers", (file) => {
    expect(read(file)).toMatch(/\(\$\{base\.code\}\)/);
  });
});

/**
 * Audit regression. List rows and the financial read model are separate
 * queries, so a table renders while its money is still loading. Coalescing that
 * gap to zero exported "0.00" — a definite claim that a contract is worth
 * nothing — into a file someone keeps and sends on. A missing row must export
 * blank; a measured zero must still export zero.
 */
describe("money that is not known yet is never exported as zero", () => {
  interface Row { id: number }
  const readModel = new Map<number, { totalEgp: number }>([[1, { totalEgp: 250_00 }], [3, { totalEgp: 0 }]]);
  const columns: Column<Row>[] = [
    { key: "id", header: "Id", value: (row) => row.id },
    {
      key: "total",
      header: "Total (EGP)",
      value: (row) => readModel.get(row.id)?.totalEgp ?? 0,
      exportValue: (row) => readModelExport(readModel.get(row.id), (fin) => minorToInput(fin.totalEgp, 2)),
    },
  ];

  it("exports blank for a row the read model has no figure for", () => {
    const lines = buildCsv(columns, [{ id: 1 }, { id: 2 }, { id: 3 }]).split("\r\n");
    expect(lines[1]).toBe("1,250");        // known figure
    expect(lines[2]).toBe("2,");           // not known yet — blank, not 0
    expect(lines[3]).toBe("3,0");          // a measured zero is a fact
  });

  it("shows a placeholder on screen rather than a formatted zero", () => {
    expect(readModelDisplay(undefined, () => "EGP 0")).toBe(UNKNOWN_AMOUNT);
    expect(readModelDisplay(null, () => "EGP 0")).toBe(UNKNOWN_AMOUNT);
    expect(readModelDisplay({ totalEgp: 0 }, () => "EGP 0")).toBe("EGP 0");
  });

  /** The pages that read money from the workspace read model must use it. */
  it.each([
    "features/projects/ProjectsPage.tsx",
    "features/clients/ClientsPage.tsx",
    "features/certificates/CertificatesPage.tsx",
  ])("%s guards its read-model money columns", (file) => {
    const source = read(file);
    expect(source, `${file} must guard exports`).toContain("readModelExport(");
    expect(source, `${file} must guard rendering`).toContain("readModelDisplay(");
  });
});

/**
 * M2: exported money must be a number a spreadsheet can add.
 *
 * Two rules had drifted apart. `buildCsv` deliberately let plain negatives
 * through; `sanitizeExportCell` — the one used by the XLSX/CSV report exports —
 * quoted anything starting with `-`, so every loss, negative margin and credit
 * note left the app as text. A workbook of financial results that will not sum
 * in exactly those rows is worse than no export.
 */
describe("exported money stays numeric and summable", () => {
  it("treats a negative number as a number, not a formula", () => {
    for (const amount of ["-1234.50", "-0.01", "-1", "1234.50", "0"]) {
      expect(isFormulaInjectionRisk(amount), amount).toBe(false);
      expect(sanitizeExportCell(amount), amount).toBe(amount);
    }
  });

  it("still neutralizes every cell a spreadsheet would evaluate", () => {
    for (const attack of ["=1+1", "+1", "@SUM(A1)", "-1+1", "-A1", "=cmd|'/c calc'!A0", "\t=1+1", "  =1+1"]) {
      expect(isFormulaInjectionRisk(attack), attack).toBe(true);
      expect(sanitizeExportCell(attack), attack).toBe(`'${attack}`);
    }
  });

  it("applies one shared verdict to table exports and report exports", () => {
    const columns: Column<{ amount: string }>[] = [
      { key: "amount", header: "Amount", value: (row) => row.amount },
    ];
    for (const amount of ["-1234.50", "=1+1", "-A1", "0"]) {
      const csvCell = buildCsv(columns, [{ amount }]).split("\r\n")[1]!;
      const sanitized = String(sanitizeExportCell(amount));
      expect(csvCell.startsWith("'"), amount).toBe(sanitized.startsWith("'"));
    }
  });

  /**
   * The report centre builds one row set for printing and for workbooks. Print
   * wants a localized string; a workbook needs a number. Pin that the split
   * exists and that exports take the numeric branch.
   */
  it("builds report rows numerically for workbooks and formatted for print", () => {
    const source = read("features/reports/ReportsCenter.tsx");
    expect(source).toContain("type RowMode");
    expect(source).toMatch(/buildRows\(key, format === "pdf" \? "print" : "export"\)/);
    // Money helpers must branch on the mode rather than always formatting.
    expect(source).toMatch(/mode === "print"\s*\?\s*base\.format/);
    expect(source).toMatch(/mode === "print"\s*$[\s\S]{0,80}fmt\.money/m);
    // No row builder may format money unconditionally any more.
    expect(source).not.toMatch(/\]:\s*fmt\.money\(/);
    expect(source).not.toMatch(/const money = \(egp: number\) => base\.format\(egp\);/);
  });
});
