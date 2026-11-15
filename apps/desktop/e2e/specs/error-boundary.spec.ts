import { test, expect, resetWorkspace } from "../fixtures";

/**
 * B1: a render error shows a fallback inside the layout, so the sidebar still
 * works, and the details never carry record values. Both languages.
 */
for (const language of ["en", "ar"] as const) {
  test(`forced render error shows the fallback and navigation still works (${language})`, async ({ page }) => {
    await resetWorkspace(language);
    await page.goto("/#/__crash");
    const fallback = page.getByTestId("error-fallback");
    await expect(fallback).toBeVisible();
    await expect(fallback.getByRole("button")).toHaveCount(2);
    await expect(fallback).toContainText("route: /__crash");
    await expect(fallback).toContainText("E2E forced render error");

    // The sidebar is still alive: leave the broken page.
    const sidebar = page.locator("aside").first();
    await sidebar.getByRole("link").nth(1).click();
    await expect(page.getByTestId("error-fallback")).toHaveCount(0);
  });
}
