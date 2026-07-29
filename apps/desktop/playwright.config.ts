import { defineConfig, devices } from "@playwright/test";

/**
 * Milestone 8 UI testing.
 *
 * The app ships inside a Tauri WebView2 window, so the suite runs in Microsoft
 * Edge — the same engine family — rather than bundled Chromium. Vite serves the
 * real app in `e2e` mode, where the database module is swapped for a bridge
 * onto a real SQLite instance running the real migrations (see
 * e2e/db-server.mjs), so specs drive genuine repository code end to end.
 *
 * One worker, no parallelism: every spec shares that single database, exactly
 * as the desktop app owns one file.
 */
const DB_PORT = 1425;
const APP_PORT = 1420;

export default defineConfig({
  testDir: "./e2e/specs",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  timeout: 60_000,
  expect: {
    timeout: 10_000,
    toHaveScreenshot: {
      // Font hinting and GPU compositing differ between machines; the
      // regression signal is layout and colour, not per-pixel identity.
      maxDiffPixelRatio: 0.02,
      animations: "disabled",
    },
  },
  use: {
    baseURL: `http://localhost:${APP_PORT}`,
    channel: "msedge",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [
    {
      name: "desktop-1366",
      use: { ...devices["Desktop Edge"], viewport: { width: 1366, height: 768 } },
    },
    {
      name: "desktop-1440",
      use: { ...devices["Desktop Edge"], viewport: { width: 1440, height: 900 } },
    },
    {
      name: "desktop-1920",
      use: { ...devices["Desktop Edge"], viewport: { width: 1920, height: 1080 } },
    },
  ],
  webServer: [
    {
      command: "node e2e/db-server.mjs",
      url: `http://127.0.0.1:${DB_PORT}/health`,
      reuseExistingServer: !process.env.CI,
      stdout: "ignore",
      stderr: "pipe",
    },
    {
      command: "pnpm vite --mode e2e",
      url: `http://localhost:${APP_PORT}`,
      reuseExistingServer: !process.env.CI,
      stdout: "ignore",
      stderr: "pipe",
      timeout: 120_000,
    },
  ],
});
