import { test, expect } from "../fixtures";

test("the workspace boots against the e2e database bridge", async ({ page }) => {
  const failures: string[] = [];
  page.on("pageerror", (error) => failures.push(error.message));

  await page.goto("/");
  await expect(page.getByRole("heading", { name: /Set up your office workspace/i })).toBeVisible();
  expect(failures).toEqual([]);
});
