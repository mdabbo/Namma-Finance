import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * C5: colours come from theme tokens (`text-muted`, `bg-surface-subtle`,
 * `border-border-subtle`, …), not hard-coded slate/gray utilities. Tokens flip
 * with the theme and were checked for contrast in both; `text-slate-400`
 * measures 2.5:1 on white and `text-slate-500` 4.4:1 on the page background.
 *
 * This is a ratchet. Each file not yet migrated has a ceiling equal to its
 * current count: it may fall, never rise. Migrating a file means deleting its
 * entry; the test then requires zero. A ceiling above the real count fails too,
 * so the list cannot go stale and quietly excuse new greys.
 *
 * Exempt for good: printed documents. Paper is white in both themes, and a
 * token would print dark-mode colours — so everything inside <PrintPortal> and
 * the files in PRINT_ONLY keep fixed colours.
 */
const SRC = join(import.meta.dirname, "..", "src");
const PRINT_ONLY = new Set(["features/certificates/CertificateDocument.tsx"]);
const HARD_CODED = /\b(?:text|bg|border|divide|ring|fill|stroke|outline|placeholder)-(?:slate|gray|zinc|neutral|stone)-\d+/g;

/** Files still to migrate → their current count. Lower or delete entries; never add. */
const CEILINGS: Record<string, number> = {
  "components/ui.tsx": 25,
  "features/settings/SettingsPage.tsx": 25,
  "features/audit/AuditPage.tsx": 24,
  "components/NotificationBell.tsx": 18,
  "features/projects/StagesTab.tsx": 17,
  "app/Layout.tsx": 16,
  "features/clients/ClientDetailPage.tsx": 15,
  "features/projects/ContractForm.tsx": 15,
  "features/reports/CashflowView.tsx": 15,
  "features/reports/ProfitabilityView.tsx": 10,
  "features/search/SearchPalette.tsx": 9,
  "features/projects/DocumentsTab.tsx": 8,
  "features/reports/CostingView.tsx": 8,
  "components/ConfirmDialog.tsx": 6,
  "components/ErrorBoundary.tsx": 6,
  "components/LockScreen.tsx": 6,
  "features/certificates/CertificateForm.tsx": 6,
  "features/reports/ImportWizard.tsx": 6,
  "features/expenses/ExpensesPage.tsx": 5,
  "features/payments/PaymentForm.tsx": 5,
  "main.tsx": 5,
  "features/reports/PaymentIntegrityView.tsx": 4,
  "components/DataTable.tsx": 3,
  "features/dashboard/DashboardPage.tsx": 3,
  "features/finance/FinanceOverviewPage.tsx": 3,
  "features/projects/ProjectsPage.tsx": 3,
  "features/time/TimePage.tsx": 3,
  "features/onboarding/OnboardingPanel.tsx": 2,
  "features/payments/PaymentsPage.tsx": 2,
  "features/certificates/CertificatesPage.tsx": 1,
  "features/clients/ClientsPage.tsx": 1,
  "features/finance/ReceivablesPage.tsx": 1,
  "features/reports/ReportsCenter.tsx": 1,
};

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return files(full);
    return /\.tsx$/.test(entry) ? [full] : [];
  });
}

/** Counts hard-coded greys, ignoring lines inside <PrintPortal>…</PrintPortal>. */
export function countHardCoded(source: string): number {
  let inPrint = false;
  let count = 0;
  for (const line of source.split(/\r?\n/)) {
    if (/<PrintPortal\b/.test(line)) inPrint = true;
    if (!inPrint) count += line.match(HARD_CODED)?.length ?? 0;
    if (/<\/PrintPortal>/.test(line)) inPrint = false;
  }
  return count;
}

const counts = new Map<string, number>();
for (const file of files(SRC)) {
  const name = relative(SRC, file).replaceAll("\\", "/");
  if (PRINT_ONLY.has(name)) continue;
  counts.set(name, countHardCoded(readFileSync(file, "utf8")));
}

describe("C5 design tokens", () => {
  it("scans the source tree", () => {
    expect(counts.size).toBeGreaterThan(40);
  });

  it("adds no hard-coded slate/gray utilities beyond each file's ceiling", () => {
    const over = [...counts]
      .filter(([name, n]) => n > (CEILINGS[name] ?? 0))
      .map(([name, n]) => `${name}: ${n} (ceiling ${CEILINGS[name] ?? 0})`);
    expect(over).toEqual([]);
  });

  it("keeps every ceiling equal to the real count, so none goes stale", () => {
    const stale = Object.entries(CEILINGS)
      .filter(([name, ceiling]) => counts.get(name) !== ceiling)
      .map(([name, ceiling]) => `${name}: ceiling ${ceiling}, actual ${counts.get(name) ?? "missing"}`);
    expect(stale).toEqual([]);
  });

  it("counts only what it should", () => {
    const portal = `<PrintPortal>\n<p className="text-slate-600">x</p>\n</PrintPortal>\n`;
    expect(countHardCoded(portal)).toBe(0);
    expect(countHardCoded(`<p className="text-slate-400 dark:text-slate-300">x</p>`)).toBe(2);
    expect(countHardCoded(`<p className="text-muted border-border-subtle">x</p>`)).toBe(0);
    expect(countHardCoded(`${portal}<i className="bg-slate-50" />`)).toBe(1);
  });
});
