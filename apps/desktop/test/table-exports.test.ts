import { describe, expect, it } from "vitest";
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
