import { test, expect, countRows, queryOne } from "../fixtures";

/**
 * Milestone 6 acceptance: the guided first-use flow, its skip/resume state,
 * and the demo workspace — all against a genuinely empty workspace.
 */

test("guides a new workspace through the six setup steps", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /Set up your office workspace/i })).toBeVisible();

  for (const step of [
    "Company profile",
    "Default currency",
    "Numbering format",
    "Create your first client",
    "Create your first project",
    "Create your first contract",
  ]) {
    await expect(page.getByText(step, { exact: true })).toBeVisible();
  }
  await expect(page.getByText("0 of 6")).toBeVisible();
});

test("skips and resumes setup without losing progress", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Skip setup" }).click();

  await expect(page.getByText("Setup is paused")).toBeVisible();
  expect((await queryOne<{ value: string }>(
    "SELECT value FROM settings WHERE key='onboarding_skipped'",
  ))?.value).toBe("true");

  await page.getByRole("button", { name: "Resume setup" }).click();
  await expect(page.getByRole("heading", { name: /Set up your office workspace/i })).toBeVisible();
});

test("loads and removes the demo workspace, leaving no financial records", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Load demo workspace" }).click();

  // Real records created through the real repositories. The setup panel
  // disappearing is the signal the workspace now has financial activity —
  // the "Dashboard" title is present in the empty state too.
  await expect(page.getByRole("heading", { name: /Set up your office workspace/i }))
    .toBeHidden({ timeout: 30_000 });
  expect(await countRows("projects")).toBe(2);
  expect(await countRows("payment_certificates")).toBe(3);
  expect(await countRows("payments")).toBe(1);
  const paid = await queryOne<{ n: number }>(
    "SELECT COUNT(*) AS n FROM payment_certificates WHERE status='PAID'",
  );
  expect(paid?.n).toBe(1);

  // Removal lives in Settings because the dashboard leaves its empty state
  // once demo data exists — the onboarding panel is gone by then.
  await page.goto("/#/settings");
  await page.getByRole("button", { name: "Remove demo data" }).click();
  await expect(page.getByRole("button", { name: "Remove demo data" }))
    .toBeHidden({ timeout: 30_000 });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: /Set up your office workspace/i }))
    .toBeVisible({ timeout: 20_000 });

  const live = await queryOne<{ n: number }>(
    "SELECT (SELECT COUNT(*) FROM projects WHERE archived_at IS NULL) AS n",
  );
  expect(live?.n).toBe(0);
});
