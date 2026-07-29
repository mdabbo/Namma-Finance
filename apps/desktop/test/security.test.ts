import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sanitizeExportCell } from "../src/lib/export";
import { assertRestrictedSql } from "../src/lib/db";
import { SYNC_TABLES } from "../src/lib/sync/registry";
import { sha256Hex } from "../src/repositories/documents";

const root=resolve(import.meta.dirname,"..");

describe("Milestone 10 security boundaries",()=>{
  it("enables CSP and removes wildcard filesystem scopes",()=>{
    const config=JSON.parse(readFileSync(resolve(root,"src-tauri/tauri.conf.json"),"utf8"));
    expect(config.app.security.csp).toContain("default-src 'self'");
    expect(config.app.security.csp).toContain("object-src 'none'");
    const capability=readFileSync(resolve(root,"src-tauri/capabilities/default.json"),"utf8");
    expect(capability).not.toContain('"path": "**"');
    expect(capability).not.toContain("fs:allow-copy-file");
    expect(capability).not.toContain('"sql:default"');
  });

  it("keeps Supabase sessions out of persistent browser storage",()=>{
    const client=readFileSync(resolve(root,"src/lib/sync/client.ts"),"utf8");
    expect(client).toContain("persistSession: false");
    expect(client).not.toMatch(/localStorage\.(setItem|set)/);
  });

  it("fails closed when lock-state loading errors",()=>{
    const main=readFileSync(resolve(root,"src/main.tsx"),"utf8");
    expect(main).toContain("catch(() => setLocked(true))");
  });

  it("neutralizes spreadsheet formula injection without changing money",()=>{
    expect(sanitizeExportCell("=HYPERLINK(\"https://evil\")")).toBe("'=HYPERLINK(\"https://evil\")");
    expect(sanitizeExportCell("+cmd|' /C calc'!A0")).toBe("'+cmd|' /C calc'!A0");
    expect(sanitizeExportCell("\t=1+1")).toBe("'\t=1+1");
    expect(sanitizeExportCell("  @SUM(A1:A2)")).toBe("'  @SUM(A1:A2)");
    expect(sanitizeExportCell(12500)).toBe(12500);
    expect(sanitizeExportCell("NAMAA")).toBe("NAMAA");
  });

  it("rejects administrative, stacked and incompletely bound frontend SQL",()=>{
    expect(()=>assertRestrictedSql("ATTACH DATABASE $1 AS stolen",["x.db"])).toThrow("SQL_ADMIN_COMMAND_DENIED");
    expect(()=>assertRestrictedSql("UPDATE payments SET amount_minor=$1; DROP TABLE payments",[1])).toThrow("SQL_STACKED_OR_COMMENTED");
    expect(()=>assertRestrictedSql("UPDATE payments SET amount_minor=$2",[1])).toThrow("SQL_PARAMETER_MISSING");
    expect(()=>assertRestrictedSql("UPDATE payments SET amount_minor=$1 WHERE id=$2",[100,7])).not.toThrow();
  });

  it("makes RLS remediation repeatable and keeps financial writes role-gated",()=>{
    const rls=readFileSync(resolve(root,"../..","docs/supabase-security-hardening.sql"),"utf8");
    expect(rls).toContain("drop policy if exists namaa_member_write");
    expect(rls).toContain("drop policy if exists namaa_finance_write");
    expect(rls).toContain("role in ('ADMIN','ACCOUNTANT')");
    expect(rls).toContain("'contracts','payment_certificates','payments'");
  });

  it("never syncs machine-specific document or attachment paths",()=>{
    const documents=SYNC_TABLES.find((table)=>table.name==="documents")!;
    const contracts=SYNC_TABLES.find((table)=>table.name==="contracts")!;
    const expenses=SYNC_TABLES.find((table)=>table.name==="expenses")!;
    expect(documents.columns).not.toEqual(expect.arrayContaining(["path","local_cache_path","is_available_offline"]));
    expect(contracts.columns).not.toContain("attachments");
    expect(expenses.columns).not.toContain("attachment_path");
  });

  it("computes the canonical SHA-256 used before cloud document upload",async()=>{
    expect(await sha256Hex(new TextEncoder().encode("NAMAA"))).toBe("4c1ab3d390329c05f760dbed02bbcb99b3280705fed9aabee2c2fc3acd10e853");
  });
});

/**
 * Milestone 8 independent-audit regression.
 *
 * The end-to-end suite swaps the database and app-lock modules for bridges: a
 * plain HTTP endpoint and a lock that never consults Rust. Those must be
 * unreachable from anything shippable. `mode` is a user-supplied flag, so
 * gating on it alone let `vite build --mode e2e` emit a production bundle
 * carrying both bridges — verified by grepping the emitted assets before this
 * was fixed.
 */
describe("Milestone 8 end-to-end bridge containment", () => {
  async function pluginNames(command: "serve" | "build", mode: string): Promise<string[]> {
    const configModule = await import("../vite.config");
    const factory = configModule.default as unknown as (
      env: { command: "serve" | "build"; mode: string },
    ) => Promise<{ plugins: unknown[] }>;
    const config = await factory({ command, mode });
    return config.plugins
      .flat(Infinity as number)
      .filter((plugin): plugin is { name: string } =>
        !!plugin && typeof (plugin as { name?: unknown }).name === "string")
      .map((plugin) => plugin.name);
  }

  it("never installs the bridge in a build, whatever mode it is given", async () => {
    for (const mode of ["e2e", "production", "development"]) {
      expect(await pluginNames("build", mode), `build --mode ${mode}`)
        .not.toContain("mep-e2e-bridge");
    }
  });

  it("installs the bridge only for the e2e dev server", async () => {
    expect(await pluginNames("serve", "e2e")).toContain("mep-e2e-bridge");
    expect(await pluginNames("serve", "development")).not.toContain("mep-e2e-bridge");
  });

  it("keeps the shipped database and lock modules free of bridge fallbacks", () => {
    const db = readFileSync(resolve(root, "src/lib/db.ts"), "utf8");
    const lock = readFileSync(resolve(root, "src/lib/lock.ts"), "utf8");
    // The production modules must reach Rust, never an HTTP endpoint.
    for (const source of [db, lock]) {
      expect(source).not.toMatch(/127\.0\.0\.1|localhost|fetch\(/);
    }
    expect(db).toContain('from "@tauri-apps/plugin-sql"');
    expect(lock).toContain('invoke<boolean>("app_lock_enabled")');
  });
});
