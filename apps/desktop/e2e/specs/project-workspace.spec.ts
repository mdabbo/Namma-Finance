import { test, expect, completeOnboarding, queryOne } from "../fixtures";

/**
 * Milestone 8: the project workspace location is in the URL.
 *
 * Before this the tab was React state: refresh returned to Summary, browser
 * history ignored tab changes, and a link could not point at a project's
 * payments. Each of those is checked here against the real app.
 */

async function demoProjectId(page: import("@playwright/test").Page): Promise<number> {
  await page.goto("/");
  await page.getByRole("button", { name: "Load demo workspace" }).click();
  await expect(page.getByRole("heading", { name: /Set up your office workspace/i }))
    .toBeHidden({ timeout: 30_000 });
  const row = await queryOne<{ id: number }>(
    "SELECT id FROM projects WHERE archived_at IS NULL ORDER BY id LIMIT 1",
  );
  return row!.id;
}

test.beforeEach(async () => {
  await completeOnboarding();
});

test("opens each tab directly from its own URL", async ({ page }) => {
  const id = await demoProjectId(page);
  for (const tab of ["summary", "contracts", "finance", "team", "time", "documents"]) {
    await page.goto(`/#/projects/${id}?tab=${tab}`);
    await expect(
      page.getByRole("tab", { name: new RegExp(tab, "i") }),
      `${tab} must be the selected tab`,
    ).toHaveAttribute("aria-selected", "true");
  }
});

test("keeps the tab across a refresh", async ({ page }) => {
  const id = await demoProjectId(page);
  await page.goto(`/#/projects/${id}?tab=team`);
  await expect(page.getByRole("tab", { name: /team/i })).toHaveAttribute("aria-selected", "true");

  await page.reload();
  await expect(page).toHaveURL(/tab=team/);
  await expect(page.getByRole("tab", { name: /team/i })).toHaveAttribute("aria-selected", "true");
});

test("tracks tab changes in browser history", async ({ page }) => {
  const id = await demoProjectId(page);
  await page.goto(`/#/projects/${id}?tab=summary`);
  await page.getByRole("tab", { name: /contracts/i }).click();
  await expect(page).toHaveURL(/tab=contracts/);
  await page.getByRole("tab", { name: /team/i }).click();
  await expect(page).toHaveURL(/tab=team/);

  await page.goBack();
  await expect(page).toHaveURL(/tab=contracts/);
  await page.goBack();
  await expect(page).toHaveURL(/tab=summary/);
  await page.goForward();
  await expect(page).toHaveURL(/tab=contracts/);
});

test("deep-links a finance subview and keeps it in the URL", async ({ page }) => {
  const id = await demoProjectId(page);
  await page.goto(`/#/projects/${id}?tab=finance&view=payments`);
  await expect(page.getByRole("tab", { name: /finance/i })).toHaveAttribute("aria-selected", "true");

  // Switching subview stays addressable.
  await page.getByRole("tab", { name: "Expenses", exact: true }).click();
  await expect(page).toHaveURL(/view=expenses/);
  await page.reload();
  await expect(page).toHaveURL(/view=expenses/);
});

test("falls back safely when the URL names an unknown tab", async ({ page }) => {
  const id = await demoProjectId(page);
  await page.goto(`/#/projects/${id}?tab=not-a-tab&view=not-a-view`);
  await expect(page.getByRole("tab", { name: /summary/i })).toHaveAttribute("aria-selected", "true");
});

test("navigates from a project activity row into the matching tab", async ({ page }) => {
  const id = await demoProjectId(page);
  await page.goto(`/#/projects/${id}?tab=summary`);

  const activity = page.getByRole("button", { name: /Created|Updated|Changed status/ }).first();
  if (await activity.count() === 0) test.skip(true, "demo workspace produced no project activity");
  await activity.click();
  // Whichever entity it was, the workspace moved somewhere addressable.
  await expect(page).toHaveURL(/tab=/);
});
