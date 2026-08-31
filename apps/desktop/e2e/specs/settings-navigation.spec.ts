import { test, expect, resetWorkspace, completeOnboarding } from "../fixtures";
import type { Page } from "@playwright/test";

/**
 * Milestone 5: one Settings navigator.
 *
 * Settings sections were rendered twice — by the global secondary navigation in
 * Layout and again inside SettingsPage — so two consecutive rows offered the
 * same eleven destinations. Only an end-to-end run can see that both rows
 * reached the screen, so the single-landmark assertions live here.
 */

const SETTINGS_NAV = "Settings sections";
const SETTINGS_NAV_AR = "أقسام الإعدادات";

async function settle(page: Page) {
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(300);
}

/** Every navigation landmark on screen, by accessible name. */
async function navLandmarkNames(page: Page): Promise<string[]> {
  return page.getByRole("navigation").evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("aria-label") ?? ""),
  );
}

test.beforeEach(async () => {
  await completeOnboarding();
});

test("shows exactly one Settings navigation", async ({ page }) => {
  await page.goto("/#/settings/general");
  await expect(page.getByRole("navigation", { name: SETTINGS_NAV })).toBeVisible();

  // Exactly one Settings navigator, and no second row repeating its sections.
  await expect(page.getByRole("navigation", { name: SETTINGS_NAV })).toHaveCount(1);
  const landmarks = await navLandmarkNames(page);
  expect(landmarks.filter((name) => name === SETTINGS_NAV)).toHaveLength(1);
  expect(landmarks.filter((name) => name === "Section navigation")).toHaveLength(0);

  // Each section appears once in the whole page, not twice.
  for (const label of ["Company profile", "Numbering", "Data & Backup", "Audit Log"]) {
    const links = page.getByRole("link", { name: label, exact: true });
    if (await links.count()) expect(await links.count(), label).toBe(1);
  }
});

test("groups the sections and highlights the active one", async ({ page }) => {
  await page.goto("/#/settings/numbering");
  const nav = page.getByRole("navigation", { name: SETTINGS_NAV });

  // Group headings are plain text; the same words also name links (General,
  // Finance), so match the heading elements rather than any text node.
  for (const group of ["General", "Finance", "Data", "System"]) {
    await expect(nav.locator("p", { hasText: new RegExp(`^${group}$`) }), group).toHaveCount(1);
  }

  // The active section is marked for assistive technology, not colour alone.
  await expect(nav.locator("[aria-current='page']")).toHaveCount(1);
  await expect(nav.locator("[aria-current='page']")).toHaveText("Numbering");
});

test("keeps every settings URL addressable and shows one section at a time", async ({ page }) => {
  const sections: [string, string][] = [
    ["general", "General"],
    ["company", "Company profile"],
    ["finance", "Finance"],
    ["numbering", "Numbering"],
    ["categories", "Expense categories"],
    ["backup", "Data & Backup"],
    ["sync", "Cloud sync"],
    ["security", "Security"],
    ["data-tools", "Data Tools"],
    ["advanced", "Advanced"],
    ["audit", "Audit Log"],
  ];
  for (const [id, label] of sections) {
    await page.goto(`/#/settings/${id}`);
    await expect(page.getByRole("navigation", { name: SETTINGS_NAV }), id).toBeVisible();
    // The heading names the open section, so only one is on screen.
    await expect(page.getByRole("heading", { name: label, exact: true }).first(), id).toBeVisible();
    await expect(page.getByRole("navigation", { name: SETTINGS_NAV }).locator("[aria-current='page']"), id)
      .toHaveText(label);
  }
});

test("bare /settings resolves to a real section", async ({ page }) => {
  await page.goto("/#/settings");
  await expect(page).toHaveURL(/#\/settings\/general/);
  await expect(page.getByRole("navigation", { name: SETTINGS_NAV })).toBeVisible();
});

test("Data tools still hosts the import wizard and payment integrity", async ({ page }) => {
  await page.goto("/#/settings/data-tools");
  await expect(page.getByText("Import from Excel", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Payment integrity", { exact: true }).first()).toBeVisible();
});

test("breadcrumbs stay meaningful inside settings", async ({ page }) => {
  await page.goto("/#/settings/audit");
  const crumbs = page.getByRole("navigation", { name: /breadcrumb/i });
  await expect(crumbs).toContainText("Settings");
  await expect(crumbs).toContainText("Audit Log");
});

test("settings navigation is keyboard reachable and shows focus", async ({ page }) => {
  await page.goto("/#/settings/general");
  const nav = page.getByRole("navigation", { name: SETTINGS_NAV });
  const company = nav.getByRole("link", { name: "Company profile", exact: true });

  await company.focus();
  await expect(company).toBeFocused();
  // Focus is visible, not suppressed by the styling.
  const outline = await company.evaluate((node) => {
    const style = getComputedStyle(node, ":focus-visible");
    return `${style.outlineStyle}|${style.outlineWidth}|${style.boxShadow}`;
  });
  expect(outline).not.toBe("none|0px|none");

  await company.press("Enter");
  await expect(page).toHaveURL(/#\/settings\/company/);
  await expect(nav.locator("[aria-current='page']")).toHaveText("Company profile");
});

test("Arabic mirrors the settings navigation", async ({ page }) => {
  await resetWorkspace("ar");
  await completeOnboarding();
  await page.goto("/#/settings/general");

  const nav = page.getByRole("navigation", { name: SETTINGS_NAV_AR });
  await expect(nav).toBeVisible();
  await expect(nav).toHaveCount(1);
  // The document mirrors, so the sidebar sits on the right.
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  for (const group of ["عام", "الشؤون المالية", "البيانات", "النظام"]) {
    await expect(nav.locator("p", { hasText: new RegExp(`^${group}$`) }), group).toHaveCount(1);
  }
});

test("settings layout at 1366x768", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-1366", "baseline is for the 1366 viewport");
  await page.goto("/#/settings/general");
  await settle(page);
  await expect(page).toHaveScreenshot("settings-navigation-1366.png", { fullPage: true });
});
