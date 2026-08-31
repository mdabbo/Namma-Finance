import { test, expect, completeOnboarding, countRows, queryOne } from "../fixtures";

/**
 * The office's end-to-end financial cycle, driven through the real interface
 * against the real schema: client → project → contract → certificate →
 * payment, plus expenses, team assignment and time.
 *
 * Assertions check the DATABASE as well as the screen. A green screen with no
 * row written would be a false pass, and money that only exists in the view is
 * exactly what this project's design forbids.
 */

async function createClient(page: import("@playwright/test").Page, name: string) {
  await page.goto("/#/projects/clients");
  await page.getByRole("button", { name: "New client" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name").fill(name);
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
}

/** Choose the first real option of a required select. */
async function chooseFirst(select: import("@playwright/test").Locator) {
  const value = await select.locator("option").nth(1).getAttribute("value");
  await select.selectOption(value!);
}

async function createProject(page: import("@playwright/test").Page, name: string) {
  await page.goto("/#/projects");
  await page.getByRole("button", { name: "New project" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name", { exact: true }).fill(name);
  await chooseFirst(dialog.getByLabel(/^Client/));
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
}

test.beforeEach(async () => {
  await completeOnboarding();
});

test("creates a client and stores it", async ({ page }) => {
  await createClient(page, "Nile Developments");
  await expect(page.getByRole("cell", { name: "Nile Developments" })).toBeVisible();
  expect(await countRows("clients")).toBe(1);
});

test("creates a project under a client", async ({ page }) => {
  await createClient(page, "Nile Developments");
  await createProject(page, "Riverside Tower");

  await expect(page.getByText("Riverside Tower")).toBeVisible();
  const project = await queryOne<{ name: string; code: string; client_id: number }>(
    "SELECT name, code, client_id FROM projects",
  );
  expect(project?.name).toBe("Riverside Tower");
  // The code comes from the real numbering sequence, not the form.
  expect(project?.code).toMatch(/^PRJ-\d{4}-\d{3}$/);
});

test("runs the full contract to payment cycle and lands the money in the ledger", async ({ page }) => {
  await createClient(page, "Nile Developments");
  await createProject(page, "Riverside Tower");

  // Contract, from inside the project workspace.
  await page.getByText("Riverside Tower").first().click();
  await page.getByRole("button", { name: "New contract" }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("Contract value").fill("500000");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();

  const contract = await queryOne<{ id: number; value_minor: number; number: string }>(
    "SELECT id, value_minor, number FROM contracts",
  );
  expect(contract?.value_minor).toBe(500000_00);
  expect(contract?.number).toMatch(/^CON-\d{4}-\d{4}$/);

  // Certificate.
  await page.goto("/#/finance/certificates");
  await page.getByRole("button", { name: "New certificate" }).click();
  dialog = page.getByRole("dialog");
  await chooseFirst(dialog.getByLabel(/^Project/));
  await chooseFirst(dialog.getByLabel(/^Contract/));
  await dialog.getByLabel(/^Gross amount/).fill("100000");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();

  const certificate = await queryOne<{ id: number; gross_minor: number; status: string }>(
    "SELECT id, gross_minor, status FROM payment_certificates",
  );
  expect(certificate?.gross_minor).toBe(100000_00);

  // Approve, then record the payment that settles it.
  await page.getByRole("button", { name: "Mark submitted" }).click();
  await page.getByRole("button", { name: "Mark approved" }).click();
  await expect(page.getByRole("button", { name: "Mark paid" })).toBeVisible();
  expect((await queryOne<{ status: string }>("SELECT status FROM payment_certificates"))?.status)
    .toBe("APPROVED");

  await page.getByRole("button", { name: "Mark paid" }).click();
  dialog = page.getByRole("dialog");
  // Opened from a certificate, the date and method start deliberately empty:
  // the office must state when the money actually arrived rather than inherit
  // today. The number is only reserved from the real sequence once a date
  // exists, so the form drives the numbering rather than the test.
  await expect(dialog.getByLabel(/^Payment no/)).toHaveValue("");
  await dialog.getByLabel(/^Date/).fill("2026-07-29");
  await expect(dialog.getByLabel(/^Payment no/)).toHaveValue(/^PAY-\d{4}-\d{4}$/);
  await dialog.getByLabel(/^Method/).selectOption("BANK_TRANSFER");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();

  // Payment evidence — not a view flag — must have driven the status.
  const payment = await queryOne<{ amount_minor: number }>("SELECT amount_minor FROM payments");
  expect(payment?.amount_minor).toBeGreaterThan(0);
  expect(await countRows("payment_certificate_allocations")).toBe(1);
  const settled = await queryOne<{ status: string }>("SELECT status FROM payment_certificates");
  expect(settled?.status).toBe("PAID");
});

test("records an office expense", async ({ page }) => {
  await page.goto("/#/finance/expenses");
  await page.getByRole("button", { name: "New expense" }).click();
  const dialog = page.getByRole("dialog");
  await chooseFirst(dialog.getByLabel(/^Category/));
  await dialog.getByLabel("Description").fill("Site survey");
  await dialog.getByLabel(/^Amount/).fill("2500");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();

  const expense = await queryOne<{ description: string; amount_minor: number }>(
    "SELECT description, amount_minor FROM expenses",
  );
  expect(expense).toMatchObject({ description: "Site survey", amount_minor: 2500_00 });
});

test("adds a team member and logs time against a project", async ({ page }) => {
  await createClient(page, "Nile Developments");
  await createProject(page, "Riverside Tower");

  await page.goto("/#/team/people");
  await page.getByRole("button", { name: "New person" }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name", { exact: true }).fill("Ahmed Hassan");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  expect(await countRows("people")).toBe(1);

  await page.goto("/#/team/time");
  await page.getByRole("button", { name: "Log time" }).click();
  dialog = page.getByRole("dialog");
  await chooseFirst(dialog.getByLabel(/^Person/));
  await chooseFirst(dialog.getByLabel(/^Project/));
  await dialog.getByLabel(/^Hours/).fill("6");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();

  const entry = await queryOne<{ minutes: number }>("SELECT minutes FROM time_entries");
  expect(entry?.minutes).toBe(360);
});
