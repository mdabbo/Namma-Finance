import { describe, expect, it } from "vitest";
import { ar, en } from "../src/i18n";

// Translation parity (plan step C6).
//
// `ar` is typed as `Dictionary`, so the type checker already refuses a missing
// or extra key — but only while nobody casts. These tests check what a type
// cannot: that every value is a real, non-empty string, that Arabic actually
// differs from English, and that interpolation placeholders survive the
// translation (a renamed `{{amount}}` renders the raw braces on screen).

type Tree = { readonly [key: string]: string | Tree };

/** Flattens a nested dictionary to dotted keys: `{ a: { b: "x" } }` → `{ "a.b": "x" }`. */
function flatten(tree: Tree, prefix = ""): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === "object") {
      for (const [k, v] of flatten(value, path)) out.set(k, v);
    } else {
      out.set(path, value);
    }
  }
  return out;
}

/** The sorted `{{name}}` placeholders in a translation string. */
function placeholders(text: string): string[] {
  return [...text.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)].map((m) => m[1] ?? "").sort();
}

/**
 * Keys whose Arabic value is intentionally identical to the English one.
 * Adding a key here is a decision: the text must read correctly in both
 * languages as-is (brand names, language names shown in their own script,
 * file-format names, layouts made only of placeholders).
 */
const IDENTICAL_ALLOWED = new Set([
  "common.appName", // brand name, never translated
  "reports.exportCsv", // file-format name
  "dashboard.activityLine", // only placeholders, no words
  "settings.arabic", // each language is named in its own script
  "settings.english",
]);

const enFlat = flatten(en);
const arFlat = flatten(ar);

describe("translation parity (en ↔ ar)", () => {
  it("has the same keys in both languages", () => {
    const missingInArabic = [...enFlat.keys()].filter((k) => !arFlat.has(k));
    const missingInEnglish = [...arFlat.keys()].filter((k) => !enFlat.has(k));
    expect({ missingInArabic, missingInEnglish }).toEqual({
      missingInArabic: [],
      missingInEnglish: [],
    });
    expect(enFlat.size).toBeGreaterThan(0);
  });

  it("has a non-empty string for every value", () => {
    const bad = [...enFlat, ...arFlat]
      .filter(([, value]) => typeof value !== "string" || value.trim() === "")
      .map(([key]) => key);
    expect(bad).toEqual([]);
  });

  it("translates every value except the allowlisted ones", () => {
    const untranslated = [...enFlat.keys()].filter(
      (k) => arFlat.get(k) === enFlat.get(k) && !IDENTICAL_ALLOWED.has(k),
    );
    expect(untranslated).toEqual([]);
  });

  it("keeps the allowlist free of stale entries", () => {
    // An entry that no longer exists, or is now translated, must be removed
    // so the allowlist cannot quietly excuse a future untranslated value.
    const stale = [...IDENTICAL_ALLOWED].filter(
      (k) => !enFlat.has(k) || arFlat.get(k) !== enFlat.get(k),
    );
    expect(stale).toEqual([]);
  });

  it("uses the same interpolation placeholders in both languages", () => {
    const mismatched = [...enFlat.keys()]
      .filter((k) => arFlat.has(k))
      .filter((k) => {
        const english = placeholders(String(enFlat.get(k)));
        const arabic = placeholders(String(arFlat.get(k)));
        return english.join("\u0000") !== arabic.join("\u0000");
      });
    expect(mismatched).toEqual([]);
  });

  it("only uses double-brace placeholders", () => {
    // i18next interpolates `{{x}}`; a single `{x}` is printed literally.
    const singleBrace = [...enFlat, ...arFlat]
      .filter(([, value]) => /(^|[^{])\{[^{}]+\}(?!\})/.test(String(value)))
      .map(([key]) => key);
    expect(singleBrace).toEqual([]);
  });
});
