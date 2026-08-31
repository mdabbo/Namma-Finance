import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import { resources } from "@mep/core/i18n";
import { beforeAll, describe, expect, it } from "vitest";
import { AlertTriangle } from "lucide-react";
import {
  Alert,
  Button,
  DateInput,
  Drawer,
  EmptyState,
  ErrorState,
  Input,
  LoadingState,
  Modal,
  PageHeader,
  RatioBar,
} from "../src/components/ui";
import { MoneyInput, parseMoneyInputEdit } from "../src/components/MoneyInput";
import { buildCsv, isInteractiveTableTarget, type Column } from "../src/components/DataTable";
import { minorToInput, parseToMinor } from "../src/lib/format";

beforeAll(async () => {
  await i18next.use(initReactI18next).init({
    resources,
    lng: "en",
    fallbackLng: "en",
    interpolation: { escapeValue: false },
  });
});

function markup(element: React.ReactElement): string {
  return renderToStaticMarkup(element);
}

describe("Milestone 2 design system", () => {
  it("defines semantic light, dark, status, radius, shadow, and reduced-motion tokens", () => {
    const css = readFileSync(join(import.meta.dirname, "..", "src", "styles.css"), "utf8");
    for (const token of [
      "--ui-canvas",
      "--ui-surface",
      "--ui-foreground",
      "--ui-muted",
      "--ui-success",
      "--ui-warning",
      "--ui-danger",
      "--radius-control",
      "--radius-panel",
      "--shadow-panel",
      "--shadow-overlay",
    ]) {
      expect(css).toContain(token);
    }
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain("font-variant-numeric: tabular-nums");
  });

  it("renders keyboard-visible buttons and explicit invalid form states", () => {
    const button = markup(createElement(Button, { variant: "primary" }, "Save"));
    expect(button).toContain('type="button"');
    expect(button).toContain("focus-visible:ring-2");

    const input = markup(createElement(Input, { "aria-invalid": true }));
    expect(input).toContain('aria-invalid="true"');
    expect(input).toContain("aria-[invalid=true]:border-red-500");
  });

  it("keeps date and money fields directionally isolated with tabular numbers", () => {
    const date = markup(createElement(DateInput, { value: "2026-07-28", readOnly: true }));
    expect(date).toContain('type="date"');
    expect(date).toContain("tnum");

    const money = markup(
      createElement(MoneyInput, {
        valueMinor: 123_45,
        currency: "EGP",
        onChange: () => undefined,
      }),
    );
    expect(money).toContain("tnum");
    expect(money).toContain("123.45");
    expect(money).toContain("EGP");
  });

  it("rejects money precision that cannot be represented in integer minor units", () => {
    expect(parseToMinor("1.99", 2)).toBe(199);
    expect(parseToMinor("1.999", 2)).toBeNull();
    expect(parseToMinor("90071992547409.92", 2)).toBeNull();
    expect(parseMoneyInputEdit("", 2)).toBeNull();
    expect(parseMoneyInputEdit("1.99", 2)).toBe(199);
    expect(parseMoneyInputEdit("1.999", 2)).toBeUndefined();
    expect(parseMoneyInputEdit("not money", 2)).toBeUndefined();
  });

  it("exports spreadsheet-safe CSV without letting cells become formulas", () => {
    interface Row { number: string; description: string; amount: number }
    const columns: Column<Row>[] = [
      { key: "number", header: "Number", value: (row) => row.number },
      { key: "description", header: "Description", value: (row) => row.description },
      { key: "amount", header: "Amount", value: (row) => row.amount },
      { key: "actions", header: "" },
    ];
    const csv = buildCsv(columns, [
      { number: "PC-1", description: '=SUM(A1),"x"', amount: -500 },
      { number: "+PC2", description: "plain", amount: 1200 },
    ]);
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv).toContain("Number,Description,Amount");
    // Formula-looking cells are neutralised, quotes and commas escaped.
    expect(csv).toContain('"\'=SUM(A1),""x"""');
    expect(csv).toContain("'+PC2");
    // Plain negative amounts stay importable numbers.
    expect(csv).toContain(",-500");
    // The actions column has no value and is not exported.
    expect(csv.split("\r\n")[2]).toBe("'+PC2,plain,1200");
  });

  /**
   * Milestone 4-5 independent-audit regression. `value` carries integer minor
   * units so sorting stays exact; exporting it verbatim wrote piasters into a
   * column a spreadsheet sums as pounds — a silent 100x overstatement.
   */
  it("exports money columns as major units, never raw minor units", () => {
    interface Row { unpaidMinor: number; currency: string }
    const columns: Column<Row>[] = [
      { key: "currency", header: "Currency", value: (row) => row.currency },
      {
        key: "unpaid",
        header: "Unpaid",
        value: (row) => row.unpaidMinor,
        exportValue: (row) => minorToInput(row.unpaidMinor, 2),
      },
    ];
    const csv = buildCsv(columns, [
      { unpaidMinor: 50_000, currency: "EGP" },
      { unpaidMinor: 1_234_56, currency: "USD" },
    ]);
    const lines = csv.split("\r\n");
    expect(lines[1]).toBe("EGP,500");
    expect(lines[2]).toBe("USD,1234.56");
    // The sortable minor-unit value must never reach the file.
    expect(csv).not.toContain("50000");
    expect(csv).not.toContain("123456");
  });

  it("does not treat nested table controls as row activation", () => {
    const nestedButton = { closest: (selector: string) => (selector.includes("button") ? {} : null) };
    const ordinaryCell = { closest: () => null };
    expect(isInteractiveTableTarget(nestedButton)).toBe(true);
    expect(isInteractiveTableTarget(ordinaryCell)).toBe(false);
    expect(isInteractiveTableTarget(null)).toBe(false);
  });

  it("provides accessible overlays and state feedback", () => {
    const modal = markup(createElement(Modal, { title: "Edit", onClose: () => undefined }, "Body"));
    expect(modal).toContain('role="dialog"');
    expect(modal).toContain('aria-modal="true"');
    expect(modal).toContain('aria-label="Close"');

    const drawer = markup(createElement(Drawer, { title: "Details", onClose: () => undefined }, "Body"));
    expect(drawer).toContain('role="dialog"');
    expect(drawer).toContain("inset-y-0 end-0");

    expect(markup(createElement(LoadingState, { label: "Loading" }))).toContain('role="status"');
    expect(markup(createElement(ErrorState, { title: "Failed" }))).toContain('role="alert"');
    expect(
      markup(createElement(Alert, { tone: "danger" }, "Invalid")),
    ).toContain('role="alert"');
  });

  it("provides consistent page, empty, and financial progress semantics", () => {
    const header = markup(createElement(PageHeader, { title: "Projects", actions: "Action" }));
    expect(header).toContain("<h1");
    expect(header).toContain("heading-page");

    const empty = markup(
      createElement(EmptyState, {
        title: "No records",
        description: "Create the first record.",
        icon: AlertTriangle,
      }),
    );
    expect(empty).toContain("No records");
    expect(empty).toContain("Create the first record.");

    const ratio = markup(createElement(RatioBar, { ratioBp: 5_000 }));
    expect(ratio).toContain('role="progressbar"');
    expect(ratio).toContain('aria-valuenow="50"');
  });
});
