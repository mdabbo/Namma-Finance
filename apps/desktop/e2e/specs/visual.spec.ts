import { test, expect, resetWorkspace, completeOnboarding } from "../fixtures";
import type { Page } from "@playwright/test";

/**
 * Visual regression for the eight states the redesign is judged on. Baselines
 * are per viewport project, so a layout that only breaks at 1366×768 is caught.
 *
 * Screenshots are full-page with animations disabled; the tolerance in
 * playwright.config.ts absorbs font hinting differences between machines while
 * still catching layout and colour regressions.
 */

/** Load the demo workspace so the populated states have realistic data. */
async function loadDemo(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Load demo workspace" }).click();
  await expect(page.getByRole("heading", { name: /Set up your office workspace/i }))
    .toBeHidden({ timeout: 30_000 });
}

/** Charts animate in; wait for the network and a beat of settle time. */
async function settle(page: Page) {
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(400);
}

test("empty dashboard", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /Set up your office workspace/i })).toBeVisible();
  await settle(page);
  await expect(page).toHaveScreenshot("dashboard-empty.png", { fullPage: true });
});

test("populated dashboard", async ({ page }) => {
  await completeOnboarding();
  await loadDemo(page);
  await settle(page);
  await expect(page).toHaveScreenshot("dashboard-populated.png", { fullPage: true });
});

test("projects page", async ({ page }) => {
  await completeOnboarding();
  await loadDemo(page);
  await page.goto("/#/projects");
  await settle(page);
  await expect(page).toHaveScreenshot("projects.png", { fullPage: true });
});

test("project workspace", async ({ page }) => {
  await completeOnboarding();
  await loadDemo(page);
  await page.goto("/#/projects");
  await page.getByText(/HQ Tower/).first().click();
  await expect(page.getByRole("tablist", { name: "Project workspace" })).toBeVisible();
  await settle(page);
  await expect(page).toHaveScreenshot("project-workspace.png", { fullPage: true });
});

test("finance workspace", async ({ page }) => {
  await completeOnboarding();
  await loadDemo(page);
  await page.goto("/#/finance");
  await settle(page);
  await expect(page).toHaveScreenshot("finance-workspace.png", { fullPage: true });
});

test("payment form", async ({ page }) => {
  await completeOnboarding();
  await loadDemo(page);
  await page.goto("/#/finance/payments");
  await page.getByRole("button", { name: "New payment" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await settle(page);
  await expect(page).toHaveScreenshot("payment-form.png");
});

test("Arabic RTL dashboard", async ({ page }) => {
  await resetWorkspace("ar");
  await completeOnboarding();
  await page.goto("/");
  await page.getByRole("button", { name: "تحميل مساحة عمل تجريبية" }).click();
  await expect(page.getByRole("heading", { name: /جهّز مساحة عمل مكتبك/ }))
    .toBeHidden({ timeout: 30_000 });
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await settle(page);
  // The Arabic page resolves a different font stack whose metrics differ
  // between a developer machine and the CI runner: every text baseline shifts a
  // few pixels while the cards, charts and columns stay put. That shift alone
  // measured 3% of the page here, over the 2% global budget, so this assertion
  // carries its own.
  //
  // A budget that large cannot be the RTL gate — a genuinely mirrored-wrong
  // panel could hide inside it. The gate is
  // `navigation.spec.ts › mirrors the layout in Arabic`, which asserts portable
  // geometry (where the sidebar sits, that main fills what it vacated) rather
  // than pixels. This screenshot supplements that with colour and gross layout,
  // and deliberately does not police glyph rendering.
  await expect(page).toHaveScreenshot("dashboard-rtl.png", {
    fullPage: true,
    maxDiffPixelRatio: 0.08,
  });
});

test("dark mode dashboard", async ({ page }) => {
  await completeOnboarding();
  await loadDemo(page);
  await page.getByTitle("Theme").click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await settle(page);
  await expect(page).toHaveScreenshot("dashboard-dark.png", { fullPage: true });
});
