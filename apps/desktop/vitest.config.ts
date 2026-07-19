import { defineConfig } from "vitest/config";

/**
 * Headless simulation harness. Runs the app's REAL repository code against a
 * real SQLite database (Node's built-in node:sqlite, needs the experimental
 * flag) created by the REAL migrations — see test/db-harness.ts.
 */
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    pool: "forks",
    poolOptions: {
      forks: { execArgv: ["--experimental-sqlite", "--no-warnings"] },
    },
  },
});
