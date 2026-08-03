import { test, expect } from "../fixtures";

/**
 * Milestone 1 acceptance, driven through the real interface: six top-level
 * sections, working breadcrumbs, and a reachable command palette — in both
 * writing directions and both themes.
 */

const SECTIONS = [
  { name: "Overview", path: "/#/overview" },
  { name: "Projects", path: "/#/projects" },
  { name: "Finance", path: "/#/finance" },
  { name: "Team", path: "/#/team/people" },
  { name: "Reports", path: "/#/reports/profitability" },
  { name: "Settings", path: "/#/settings/general" },
];

test("shows exactly six top-level sections and navigates all of them", async ({ page }) => {
  await page.goto("/");
  const sidebar = page.getByRole("complementary").or(page.locator("aside")).first();
  const links = sidebar.getByRole("link");
  await expect(links).toHaveCount(SECTIONS.length);

  for (const section of SECTIONS) {
    await sidebar.getByRole("link", { name: section.name, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(section.path.replace("/#/", "#/")));
    // Every section marks its active item for orientation.
    await expect(
      sidebar.getByRole("link", { name: section.name, exact: true }),
    ).toHaveAttribute("aria-current", "page");
  }
});

test("breadcrumbs track the active location", async ({ page }) => {
  await page.goto("/#/finance/receivables");
  const breadcrumbs = page.getByRole("navigation", { name: "Breadcrumbs" });
  await expect(breadcrumbs).toContainText("Finance");
  await expect(breadcrumbs).toContainText("Receivables");

  // The section's own secondary navigation marks the active view.
  await expect(
    page.getByRole("navigation", { name: "Section navigation" })
      .getByRole("link", { name: "Receivables" }),
  ).toHaveAttribute("aria-current", "page");
});

test("opens the command palette from the header", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /^Search/ }).click();
  await expect(page.getByPlaceholder(/search/i)).toBeVisible();
});

test("switches between English and Arabic with the correct writing direction", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");

  await page.getByTitle("Language").click();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.locator("aside").first()).toContainText("المشاريع");

  await page.getByTitle("اللغة").click();
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
});

test("switches between light and dark themes", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await page.getByTitle("Theme").click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.getByTitle("Theme").click();
  await expect(page.locator("html")).not.toHaveClass(/dark/);
});

/**
 * Milestone 7: Settings became one section per route, so a section can be
 * bookmarked and returned to, and the technical tools that used to be Reports
 * tabs now live under Data Tools.
 */
test("deep-links a settings section and keeps reports free of technical tools", async ({ page }) => {
  await page.goto("/#/settings/numbering");
  await expect(page.getByRole("heading", { name: "Numbering" })).toBeVisible();

  // Bare /settings resolves to the first section rather than a dead route.
  await page.goto("/#/settings");
  await expect(page).toHaveURL(/#\/settings\/general/);

  await page.goto("/#/settings/data-tools");
  await expect(page.getByRole("heading", { name: "Data Tools" })).toBeVisible();

  // Reports carries reporting only.
  await page.goto("/#/reports");
  await expect(page).toHaveURL(/#\/reports\/profitability/);
  const reportsNav = page.getByRole("navigation", { name: "Section navigation" });
  await expect(reportsNav.getByRole("link", { name: /Import/i })).toHaveCount(0);
  await expect(reportsNav.getByRole("link", { name: /Payment integrity/i })).toHaveCount(0);
});
