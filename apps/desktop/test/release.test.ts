import { describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const database = vi.hoisted(() => ({ appVersion: "0.6.0", schemaVersion: 23 }));
vi.mock("../src/lib/db", () => ({
  getRuntimeReleaseInfo: async () => ({ ...database }),
}));

import { loadReleaseInfo } from "../src/lib/release";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const release = JSON.parse(readFileSync(join(root, "release/release.json"), "utf8")) as {
  version: string;
  channel: string;
  schemaVersion: number;
};

describe("Milestone 16 release integrity", () => {
  it("keeps every application and installer version synchronized with the release manifest", () => {
    for (const relative of ["package.json", "apps/desktop/package.json", "apps/mobile/package.json", "packages/core/package.json"]) {
      expect(JSON.parse(readFileSync(join(root, relative), "utf8")).version, relative).toBe(release.version);
    }
    expect(JSON.parse(readFileSync(join(root, "apps/desktop/src-tauri/tauri.conf.json"), "utf8")).version).toBe(release.version);
    expect(JSON.parse(readFileSync(join(root, "apps/mobile/app.json"), "utf8")).expo.version).toBe(release.version);
    expect(readFileSync(join(root, "apps/desktop/src-tauri/Cargo.toml"), "utf8")).toMatch(
      new RegExp(`\\[package\\][\\s\\S]*?version = "${release.version.replaceAll(".", "\\.")}"`),
    );
    expect(readFileSync(join(root, "apps/desktop/src-tauri/Cargo.lock"), "utf8")).toMatch(
      new RegExp(`name = "mep-finance-desktop"\\r?\\nversion = "${release.version.replaceAll(".", "\\.")}"`),
    );
    expect(readFileSync(join(root, "apps/desktop/src-tauri/src/lib.rs"), "utf8")).toContain(
      'const CURRENT_APP_VERSION: &str = env!("CARGO_PKG_VERSION");',
    );
    expect(readFileSync(join(root, "apps/desktop/src-tauri/src/lib.rs"), "utf8")).toContain(
      `const CURRENT_SCHEMA_VERSION: i64 = ${release.schemaVersion};`,
    );
    const syncConflictSource = readFileSync(join(root, "apps/desktop/src/repositories/syncConflicts.ts"), "utf8");
    expect(syncConflictSource).toContain('import { APP_VERSION } from "../generated/release"');
    expect(syncConflictSource).not.toMatch(/application_version[^\n]+['"]0\.6\.\d+['"]/);
  });

  it("ties generated UI metadata and the latest forward migration to the release manifest", () => {
    const generated = readFileSync(join(root, "apps/desktop/src/generated/release.ts"), "utf8");
    expect(generated).toContain(`APP_VERSION = ${JSON.stringify(release.version)}`);
    expect(generated).toContain(`RELEASE_CHANNEL = ${JSON.stringify(release.channel)}`);
    expect(generated).toContain(`EXPECTED_SCHEMA_VERSION = ${release.schemaVersion}`);
    expect(readFileSync(join(root, "apps/mobile/src/generated/release.ts"), "utf8")).toBe(generated);

    const migrationNames = readdirSync(join(root, "apps/desktop/src-tauri/migrations"))
      .filter((name) => /^\d{4}_.+\.sql$/.test(name))
      .sort();
    const latest = migrationNames.at(-1);
    expect(latest).toBeTruthy();
    expect(Number(latest!.slice(0, 4))).toBe(release.schemaVersion);
    expect(readFileSync(join(root, "apps/desktop/src-tauri/migrations", latest!), "utf8")).toMatch(
      new RegExp(`PRAGMA\\s+user_version\\s*=\\s*${release.schemaVersion}`, "i"),
    );
  });

  it("returns fail-visible runtime release and database schema information", async () => {
    database.appVersion = release.version;
    database.schemaVersion = release.schemaVersion;
    await expect(loadReleaseInfo()).resolves.toEqual({
      appVersion: release.version,
      channel: release.channel,
      schemaVersion: release.schemaVersion,
      expectedSchemaVersion: release.schemaVersion,
    });
    database.schemaVersion = Number.NaN;
    await expect(loadReleaseInfo()).rejects.toThrow("SCHEMA_VERSION_UNAVAILABLE");
    database.schemaVersion = release.schemaVersion;
    database.appVersion = "9.9.9";
    await expect(loadReleaseInfo()).rejects.toThrow("APPLICATION_VERSION_MISMATCH");
  });

  it("ships the complete 0.6.0 release evidence set", () => {
    expect(readFileSync(join(root, "CHANGELOG.md"), "utf8")).toContain(`## [${release.version}]`);
    for (const name of [
      "RELEASE-CHECKLIST.md", "MIGRATION-NOTES.md", "ROLLBACK.md", "KNOWN-LIMITATIONS.md",
      "TEST-SUMMARY.md", "WINDOWS-CODE-SIGNING.md",
    ]) {
      expect(readFileSync(join(root, `docs/releases/${release.version}/${name}`), "utf8").trim().length, name)
        .toBeGreaterThan(100);
    }
  });
});
