import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * The migration chain the end-to-end bridge applies.
 *
 * Read from the migrations folder rather than listed by hand: the hand-written
 * list stopped at 0005 while the app moved on to 0008, so the browser suite ran
 * against schema 27 for three schema versions without anything noticing.
 * test/e2e-migrations.test.ts pins this to the folder and to the release
 * manifest's schema version.
 */
export const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri", "migrations");

export function migrationFiles() {
  return readdirSync(migrationsDir)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
}
