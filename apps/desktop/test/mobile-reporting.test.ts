import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { EGP_VALUATION } from "@mep/core";
import { formatRateMicro, parseRateMicro, suggestRate, valuationFor } from "../../mobile/src/lib/reporting";
import { loadMobileWorkspace } from "../../mobile/src/lib/workspace";
import { createPreviewClient } from "../../mobile/src/preview/previewClient";

/**
 * The phone's reporting currency (plan step F7). The phone has no test runner
 * of its own yet (plan step C7), so its react-native-free modules are tested
 * here, the same way as mobile-rtl.test.ts.
 */

describe("a rate typed on the phone", () => {
  it("becomes exact integer micro-units, never a float", () => {
    expect(parseRateMicro("12.85")).toBe(12_850_000);
    expect(parseRateMicro(" 3.75 ")).toBe(3_750_000);
    expect(parseRateMicro("48")).toBe(48_000_000);
    expect(parseRateMicro("0.000001")).toBe(1);
    expect(parseRateMicro("12.123456")).toBe(12_123_456);
    // Rates whose float product falls just short: 4.1 * 1e6 is 4099999.9999…,
    // 1.005 * 1e6 is 1004999.9999…; truncating them would lose a micro-unit.
    expect(parseRateMicro("4.1")).toBe(4_100_000);
    expect(parseRateMicro("1.005")).toBe(1_005_000);
  });

  it("accepts Arabic digits and decimal separators", () => {
    expect(parseRateMicro("١٢٫٨٥")).toBe(12_850_000);
    expect(parseRateMicro("۱۲.۵")).toBe(12_500_000);
    expect(parseRateMicro("12,85")).toBe(12_850_000);
  });

  it("refuses anything that is not a positive rate", () => {
    for (const text of ["", "0", "0.0", "-2", "abc", "1e3", "12.1234567", "12.", ".5", "1.2.3", "12 85"]) {
      expect(parseRateMicro(text), text).toBeNull();
    }
  });

  it("reads back the way it was typed", () => {
    expect(formatRateMicro(12_850_000)).toBe("12.85");
    expect(formatRateMicro(48_000_000)).toBe("48");
    expect(formatRateMicro(1)).toBe("0.000001");
    for (const text of ["12.85", "3.75", "48", "0.5"]) expect(formatRateMicro(parseRateMicro(text)!)).toBe(text);
  });
});

describe("the suggested rate", () => {
  const projects = [
    { code: "P-1", currency: "SAR", fxRateMicro: 12_500_000, createdAt: "2026-01-01" },
    { code: "P-2", currency: "SAR", fxRateMicro: 12_900_000, createdAt: "2026-06-01" },
    { code: "P-3", currency: "USD", fxRateMicro: 48_000_000, createdAt: "2026-09-01" },
  ];

  it("is the one stored on the newest project in that currency", () => {
    expect(suggestRate("SAR", projects)?.code).toBe("P-2");
    expect(suggestRate("USD", projects)?.fxRateMicro).toBe(48_000_000);
  });

  it("does not exist when no project uses the currency", () => {
    expect(suggestRate("SAR", projects.filter((p) => p.currency !== "SAR"))).toBeNull();
  });
});

describe("the valuation", () => {
  it("is the EGP pivot for EGP, and none for a foreign currency without a rate", () => {
    expect(valuationFor("EGP", null)).toBe(EGP_VALUATION);
    expect(valuationFor("SAR", null)).toBeNull();
    expect(valuationFor("SAR", 0)).toBeNull();
  });

  it("takes an amount already in the reporting currency at face value", () => {
    const sar = valuationFor("SAR", 12_800_000)!;
    // A SAR 325,000 contract stored at another rate still reads SAR 325,000.
    expect(sar.value(32_500_000, "SAR", 13_100_000)).toBe(32_500_000);
    expect(sar.value(128_000_000, "EGP", 1_000_000)).toBe(10_000_000);
  });
});

describe("the phone's workspace in a chosen currency", () => {
  it("reports in EGP by default", async () => {
    const workspace = await loadMobileWorkspace(createPreviewClient());
    expect(workspace.currency).toBe("EGP");
  });

  it("keeps SAR contracts at face value on a SAR dashboard, and the totals add up", async () => {
    const workspace = await loadMobileWorkspace(createPreviewClient(), valuationFor("SAR", 12_800_000)!);
    expect(workspace.currency).toBe("SAR");
    const narjis = workspace.projects.find((p) => p.project.code === "P-101")!;
    expect(narjis.project.currency).toBe("SAR");
    expect(narjis.contractValueEgp).toBe(48_000_000); // SAR 480,000 exactly
    expect(workspace.kpis.contractValueEgp).toBe(workspace.projects.reduce((s, p) => s + p.contractValueEgp, 0));
    // SAR 4,200 at face value + EGP 158,000 at 12.8 = SAR 16,543.75 exactly.
    expect(workspace.kpis.expensesEgp).toBe(1_654_375);
    expect(workspace.kpis.profitEgp).toBe(workspace.kpis.revenueEgp - workspace.kpis.expensesEgp);
  });

  it("leaves each project's own figures in the project's currency", async () => {
    const egp = await loadMobileWorkspace(createPreviewClient());
    const sar = await loadMobileWorkspace(createPreviewClient(), valuationFor("SAR", 12_800_000)!);
    const pick = (w: typeof egp) => w.projects.map((p) => [p.project.code, p.contractValueMinor, p.totalPaidMinor]);
    expect(pick(sar)).toEqual(pick(egp));
    expect(sar.byCurrency).toEqual(egp.byCurrency);
  });
});

describe("the browser preview stays out of the app", () => {
  const mobile = fileURLToPath(new URL("../../mobile", import.meta.url));
  const files: string[] = [join(mobile, "App.tsx")];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.tsx?$/.test(name)) files.push(path);
    }
  };
  walk(join(mobile, "src"));

  it("is reached only from App.tsx, behind the build-time flag", () => {
    const importers = files
      .filter((path) => !path.includes(`${join("src", "preview")}`))
      .filter((path) => /preview\/previewClient/.test(readFileSync(path, "utf8")))
      .map((path) => relative(mobile, path).replace(/\\/g, "/"));
    expect(importers).toEqual(["App.tsx"]);

    const app = readFileSync(join(mobile, "App.tsx"), "utf8");
    expect(app).toMatch(/const PREVIEW = process\.env\.EXPO_PUBLIC_PREVIEW === "1";/);
    expect(app).not.toMatch(/^import[^\n]*previewClient/m); // a static import would ship it
    expect(app).toMatch(/PREVIEW \? previewClient\(\) : getClient\(boot\.config\)/);
  });
});
