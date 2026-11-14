import { test, expect, completeOnboarding, execute, queryOne } from "../fixtures";

/**
 * Reporting currency, through the real interface.
 *
 * Reported from a live workspace: a SAR 325,000 contract read SAR 317,031.19
 * on the dashboard while its own page said 325,000, and its SAR 81,250
 * receivable read SAR 79,257.80. The consolidated figures had gone SAR -> EGP
 * at the rate stored on the project and back EGP -> SAR at the rate in the
 * currencies table — and those drift apart the day after a project is created.
 *
 * The unit suites pin the valuation rule. This spec exists because the defect
 * was once fixed and then reappeared in the WIRING between the workspace and
 * the screen, which only a run through the screen can see.
 */

const SAR_AT_SIGNING = 12_681_248;
const SAR_TODAY = 13_000_000;

async function chooseFirst(select: import("@playwright/test").Locator) {
  const value = await select.locator("option").nth(1).getAttribute("value");
  await select.selectOption(value!);
}

test.beforeEach(async () => {
  await completeOnboarding();
});

test("a SAR contract reads at face value on a SAR dashboard, whatever today's rate is", async ({ page }) => {
  // Client and project through the interface.
  await page.goto("/#/projects/clients");
  await page.getByRole("button", { name: "New client" }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name").fill("RGU");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();

  await page.goto("/#/projects");
  await page.getByRole("button", { name: "New project" }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name", { exact: true }).fill("CASA");
  await chooseFirst(dialog.getByLabel(/^Client/));
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();

  // The project is in SAR at the rate of the day it was created. Set before the
  // contract exists, so the contract's first revision snapshots these terms.
  await execute("UPDATE projects SET currency='SAR', fx_rate_micro=$1", [SAR_AT_SIGNING]);

  await page.goto("/#/projects");
  await page.getByText("CASA").first().click();
  await page.getByRole("button", { name: "New contract" }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Contract value").fill("325000");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  // The form's default commercial terms: 14% VAT, 5% retention.
  expect(await queryOne<{ value_minor: number; vat_bp: number; retention_bp: number }>(
    "SELECT value_minor, vat_bp, retention_bp FROM contracts",
  )).toEqual({ value_minor: 325000_00, vat_bp: 1400, retention_bp: 500 });

  // A 25% certificate, approved. The dashboard shows its figures only once the
  // workspace has financial activity, and this gives it a receivable to report.
  await page.goto("/#/finance/certificates");
  await page.getByRole("button", { name: "New certificate" }).click();
  dialog = page.getByRole("dialog");
  await chooseFirst(dialog.getByLabel(/^Project/));
  await chooseFirst(dialog.getByLabel(/^Contract/));
  await dialog.getByLabel(/^Gross amount/).fill("81250");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole("button", { name: "Mark submitted" }).click();
  await page.getByRole("button", { name: "Mark approved" }).click();
  await expect(page.getByRole("button", { name: "Mark paid" })).toBeVisible();
  const certificate = await queryOne<{ status: string; currency_snapshot: string; fx_rate_micro_snapshot: number }>(
    "SELECT status, currency_snapshot, fx_rate_micro_snapshot FROM payment_certificates",
  );
  expect(certificate).toMatchObject({
    status: "APPROVED",
    currency_snapshot: "SAR",
    fx_rate_micro_snapshot: SAR_AT_SIGNING,
  });

  // Time passes: the central-bank rate moves, and the office reports in SAR.
  await execute("UPDATE currencies SET fx_rate_micro=$1 WHERE code='SAR'", [SAR_TODAY]);
  await execute(
    "INSERT INTO settings(key,value) VALUES('base_currency','SAR') ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  );

  // Net payable on SAR 81,250 under those terms: +14% VAT, -5% retention.
  const RECEIVABLE = "SAR 88,562.50";
  const card = (label: string) =>
    page.locator("div", { has: page.getByText(label, { exact: true }) }).last();

  await page.goto("/#/overview");
  await page.reload();
  await expect(card("Contract Value")).toContainText("SAR 325,000");
  await expect(card("Outstanding receivables")).toContainText(RECEIVABLE);
  // What the round trip produced on these rates (317,031.20 and 86,391.00),
  // and anything like them.
  await expect(page.getByText(/SAR\s*317,03\d/)).toHaveCount(0);
  await expect(page.getByText(/SAR\s*86,39\d/)).toHaveCount(0);

  // The same contract on the projects list, which consolidates too.
  await page.goto("/#/projects");
  await expect(page.getByText("SAR 325,000").first()).toBeVisible();
  await expect(page.getByText(/SAR\s*317,03\d/)).toHaveCount(0);

  // Moving the rate again must not move a SAR figure on a SAR report.
  await execute("UPDATE currencies SET fx_rate_micro=$1 WHERE code='SAR'", [15_500_000]);
  await page.goto("/#/overview");
  await page.reload();
  await expect(card("Contract Value")).toContainText("SAR 325,000");
  await expect(card("Outstanding receivables")).toContainText(RECEIVABLE);
});
