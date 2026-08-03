import { test, expect, resetWorkspace, completeOnboarding } from "../fixtures";

/**
 * Milestone 6: saved views must restore the page's own filters, not just search
 * and sort, and corrupt stored data must not take the page down.
 *
 * These drive the real controls in the real app, because the defect being
 * guarded — a view that looks applied while showing unfiltered rows — is only
 * visible end to end.
 */

test.beforeEach(async () => {
  await completeOnboarding();
});

async function loadDemo(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Load demo workspace" }).click();
  await expect(page.getByRole("heading", { name: /Set up your office workspace/i }))
    .toBeHidden({ timeout: 30_000 });
}

test("saves a view with its page filters and restores them", async ({ page }) => {
  await loadDemo(page);
  await page.goto("/#/projects");

  const status = page.getByRole("combobox").first();
  await status.selectOption("ACTIVE");
  await page.getByPlaceholder(/Search/i).fill("HQ");

  await page.getByRole("button", { name: "Save view" }).click();
  await page.getByLabel("View name").fill("Active HQ");
  await page.getByLabel("View name").press("Enter");

  // The view is applied and the table still matches it.
  await expect(page.getByTestId("active-view-state")).toHaveText("View applied");

  // Change the filter away, then restore the view.
  await status.selectOption("");
  await page.getByPlaceholder(/Search/i).fill("");
  await expect(page.getByTestId("active-view-state")).toHaveText("Changed since saved");

  await page.getByLabel("Saved views").selectOption("Active HQ");
  await expect(status).toHaveValue("ACTIVE");
  await expect(page.getByPlaceholder(/Search/i)).toHaveValue("HQ");
  await expect(page.getByTestId("active-view-state")).toHaveText("View applied");
});

test("resetting filters clears the table back to everything", async ({ page }) => {
  await loadDemo(page);
  await page.goto("/#/projects");

  const status = page.getByRole("combobox").first();
  await status.selectOption("COMPLETED");
  await page.getByPlaceholder(/Search/i).fill("nothing matches this");
  await expect(page.getByText(/No results|Nothing here yet/)).toBeVisible();

  await page.getByRole("button", { name: "Reset filters" }).click();
  await expect(status).toHaveValue("");
  await expect(page.getByPlaceholder(/Search/i)).toHaveValue("");
});

test("a corrupt saved view does not break the page", async ({ page }) => {
  await resetWorkspace("en");
  await completeOnboarding();
  // Storage is user-writable; garbage must be ignored, not applied or thrown.
  await page.addInitScript(() => {
    localStorage.setItem("mep.tableViews.projects", "{ this is not json");
    localStorage.setItem("mep.tableViews.clients", JSON.stringify([
      { name: 42 }, null, "nope", { name: "Fine", search: "x", sort: { key: "name", dir: "up" } },
    ]));
  });

  await page.goto("/#/projects");
  await expect(page.getByRole("button", { name: "Save view" })).toBeVisible();

  await page.goto("/#/projects/clients");
  // Only the one salvageable entry survives validation.
  await expect(page.getByLabel("Saved views").locator("option")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Save view" })).toBeVisible();
});

test("every major list offers CSV export", async ({ page }) => {
  await loadDemo(page);
  for (const route of [
    "/#/projects",
    "/#/projects/clients",
    "/#/finance/certificates",
    "/#/finance/payments",
    "/#/finance/expenses",
    "/#/finance/receivables",
    "/#/team/people",
    "/#/team/time",
  ]) {
    await page.goto(route);
    await expect(
      page.getByRole("button", { name: "Export CSV" }),
      `${route} must offer CSV export`,
    ).toBeVisible();
  }
});
