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
  for (const label of ["Company profile", "Document numbering", "Backup & restore", "Audit Log"]) {
    const links = page.getByRole("link", { name: label, exact: true });
    if (await links.count()) expect(await links.count(), label).toBe(1);
  }
});

test("groups the sections and highlights the active one", async ({ page }) => {
  await page.goto("/#/settings/numbering");
  const nav = page.getByRole("navigation", { name: SETTINGS_NAV });

  // Group headings are plain text, so match the heading elements.
  for (const group of ["Workspace", "Financial rules", "Data", "System"]) {
    await expect(nav.locator("p", { hasText: new RegExp(`^${group}$`) }), group).toHaveCount(1);
  }

  // The active section is marked for assistive technology, not colour alone.
  await expect(nav.locator("[aria-current='page']")).toHaveCount(1);
  await expect(nav.locator("[aria-current='page']")).toHaveText("Document numbering");
});

test("keeps every settings URL addressable and shows one section at a time", async ({ page }) => {
  const sections: [string, string][] = [
    ["general", "Appearance & language"],
    ["company", "Company profile"],
    ["finance", "Currency & FX"],
    ["numbering", "Document numbering"],
    ["categories", "Expense categories"],
    ["backup", "Backup & restore"],
    ["sync", "Cloud sync"],
    ["security", "Security"],
    ["data-tools", "Import & utilities"],
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
  for (const group of ["مساحة العمل", "القواعد المالية", "البيانات", "النظام"]) {
    await expect(nav.locator("p", { hasText: new RegExp(`^${group}$`) }), group).toHaveCount(1);
  }
});

test("settings layout at 1366x768", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-1366", "baseline is for the 1366 viewport");
  await page.goto("/#/settings/general");
  await settle(page);
  await expect(page).toHaveScreenshot("settings-navigation-1366.png", { fullPage: true });
});

test("no settings group heading repeats one of its own section names", async ({ page }) => {
  // The old menu read "General > General", "Finance > Finance" and
  // "Data > Data & Backup", which put the same word in the breadcrumb, the
  // group heading, the link and the page title at once.
  //
  // Both sides are read from the page rather than listed here. An earlier
  // version hardcoded the group names and so kept passing when a group was
  // renamed back to "General" — it was comparing against a stale list.
  //
  // The unit suite asserts the label KEYS differ; this asserts the rendered
  // STRINGS do, which two different keys could still collide on.
  await resetWorkspace("en");
  await completeOnboarding();
  await page.goto("/#/settings/general");

  const nav = page.getByRole("navigation", { name: SETTINGS_NAV });
  await expect(nav).toBeVisible();
  const normalise = (value: string) => value.trim().toLowerCase();
  // Group headings are plain <p> elements; sections are links.
  const headings = (await nav.locator("p").allInnerTexts()).map(normalise).filter(Boolean);
  const links = (await nav.getByRole("link").allInnerTexts()).map(normalise).filter(Boolean);

  // Guard against a vacuous pass: with either side empty the check below
  // proves nothing.
  expect(headings.length, "settings navigation rendered no group headings").toBeGreaterThan(2);
  expect(links.length, "settings navigation rendered no section links").toBeGreaterThan(5);

  for (const heading of headings) {
    expect(links, `group "${heading}" must not also name a section`).not.toContain(heading);
  }
});
