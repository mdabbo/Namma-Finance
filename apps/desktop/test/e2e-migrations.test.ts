import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
// @ts-expect-error -- plain ESM helper shared with the Node-run E2E bridge
import { migrationFiles, migrationsDir } from "../e2e/migrations.mjs";

/**
 * The E2E bridge (e2e/db-server.mjs) builds the database the browser suite runs
 * against. Its hand-written migration list once stopped at 0005 while the app
 * reached 0008, so Playwright tested schema 27 while the app shipped 30. These
 * assertions keep the bridge on the same chain as the app.
 */

const root = join(import.meta.dirname, "..", "..", "..");
const release = JSON.parse(readFileSync(join(root, "release", "release.json"), "utf8")) as {
  schemaVersion: number;
};

describe("E2E bridge migration chain", () => {
  it("applies every migration file in the folder, in order", () => {
    const onDisk = readdirSync(join(import.meta.dirname, "..", "src-tauri", "migrations"))
      .filter((name) => /^\d{4}_.+\.sql$/.test(name))
      .sort();
    expect(onDisk.length).toBeGreaterThanOrEqual(8);
    expect(migrationFiles()).toEqual(onDisk);
  });

  it("builds the schema version the release manifest claims", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("PRAGMA foreign_keys = ON;");
      for (const file of migrationFiles() as string[]) {
        db.exec(readFileSync(join(migrationsDir as string, file), "utf8"));
      }
      expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: release.schemaVersion });
    } finally {
      db.close();
    }
  });

  it("is what the bridge server actually uses", () => {
    const server = readFileSync(join(import.meta.dirname, "..", "e2e", "db-server.mjs"), "utf8");
    expect(server).toMatch(/import \{[^}]*migrationFiles[^}]*\} from "\.\/migrations\.mjs"/);
    expect(server).toMatch(/const MIGRATIONS = migrationFiles\(\);/);
    // no hand-maintained list may creep back in
    expect(server).not.toMatch(/"0001_baseline\.sql"/);
  });
});
