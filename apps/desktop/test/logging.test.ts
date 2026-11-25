import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * B1: logs must never carry amounts, client/person names or credentials.
 * This scans every logging call site in src/ and fails if a call passes
 * anything other than a constant message and the caught error.
 */
const SRC = join(import.meta.dirname, "..", "src");

const LOG_CALL = /\b(?:logError|logWarn|logInfo|console\.(?:error|warn|log|info|debug))\s*\(/g;
// Identifiers that suggest business data. `error`, `err`, `e` and `reason` are the only values a call may pass.
const SENSITIVE = /(amount|egp|reporting|total|balance|price|fee|cost|salary|rate|paid|due|net|gross|vat|retention|name|client|person|email|password|token|secret|key|note|phone|address|iban|contract|payment|certificate|invoice)/i;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return files(full);
    return /\.(ts|tsx)$/.test(entry) ? [full] : [];
  });
}

/** Returns the argument text of each logging call in `source`. */
export function logCallArguments(source: string): string[] {
  const calls: string[] = [];
  for (const match of source.matchAll(LOG_CALL)) {
    let depth = 1;
    let i = (match.index ?? 0) + match[0].length;
    const start = i;
    while (i < source.length && depth > 0) {
      const ch = source[i];
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      i++;
    }
    calls.push(source.slice(start, i - 1));
  }
  return calls;
}

/** Violations: interpolation in a template string, or a sensitive-looking identifier outside string literals. */
export function violations(args: string): string[] {
  const found: string[] = [];
  if (/`[^`]*\$\{/.test(args)) {
    // Interpolation is allowed only for a command name, as in invokeLogged.
    const interpolations = [...args.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1].trim());
    for (const expr of interpolations) if (expr !== "command") found.push(`interpolates \${${expr}}`);
  }
  const withoutStrings = args.replace(/`[^`]*`|"[^"]*"|'[^']*'/g, "");
  const ids = withoutStrings.match(/[A-Za-z_$][\w$.]*/g) ?? [];
  for (const id of ids) if (SENSITIVE.test(id)) found.push(`passes ${id}`);
  return found;
}

describe("B1 logging call sites", () => {
  it("finds the call sites it is meant to check", () => {
    const total = files(SRC).flatMap((f) => logCallArguments(readFileSync(f, "utf8"))).length;
    expect(total).toBeGreaterThanOrEqual(8);
  });

  it("no call site logs money, names or credentials", () => {
    const bad: string[] = [];
    for (const file of files(SRC)) {
      if (file.endsWith("logger.ts")) continue; // the sink itself
      for (const args of logCallArguments(readFileSync(file, "utf8"))) {
        for (const v of violations(args)) bad.push(`${file.slice(SRC.length)}: ${v} in (${args.trim().slice(0, 80)})`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("the scanner catches what it is meant to catch", () => {
    /* eslint-disable no-template-curly-in-string */
    expect(violations('"pay failed", error')).toEqual([]);
    expect(violations("`paid ${payment.amountReporting}`")).not.toEqual([]);
    expect(violations('"failed", client.name')).not.toEqual([]);
    expect(violations('"x " + totalReporting')).not.toEqual([]);
    // C2 renamed the `…Egp` figures to `…Reporting`; a stem that names no
    // money word (profit, revenue) must still be caught by its suffix.
    expect(violations('"done", fin.profitReporting')).not.toEqual([]);
    expect(violations("`kpi ${kpis.revenueReporting}`")).not.toEqual([]);
    expect(violations("`command ${command} failed`, error")).toEqual([]);
    /* eslint-enable no-template-curly-in-string */
  });
});
