import { test as base, expect, type Page } from "@playwright/test";

const DB = process.env.E2E_DB ?? "http://127.0.0.1:1425";

async function sql(route: "select" | "execute", statement: string, params: unknown[] = []) {
  const response = await fetch(`${DB}/${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sql: statement, params }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error ?? "e2e sql failed");
  return payload;
}

/**
 * A clean workspace for every spec: the bridge rebuilds the database from the
 * real migrations, then the interface language is pinned so selectors are
 * stable. Arabic specs opt in explicitly.
 */
export async function resetWorkspace(language: "en" | "ar" = "en"): Promise<void> {
  await fetch(`${DB}/reset`, { method: "POST" });
  await sql("execute", "UPDATE settings SET value=$1 WHERE key='language'", [language]);
  await sql("execute", "UPDATE settings SET value='light' WHERE key='theme'", []);
}

/** Mark onboarding complete so specs can reach the populated dashboard. */
export async function completeOnboarding(): Promise<void> {
  await sql("execute", "UPDATE settings SET value='NAMAA Engineering' WHERE key='company_name'", []);
  for (const key of ["onboarding_currency_done", "onboarding_numbering_done"]) {
    await sql("execute", "INSERT INTO settings(key,value) VALUES($1,'true')", [key]);
  }
}

export async function countRows(table: string): Promise<number> {
  const { rows } = await sql("select", `SELECT COUNT(*) AS n FROM ${table}`);
  return rows[0].n as number;
}

export async function queryOne<T = Record<string, unknown>>(
  statement: string,
  params: unknown[] = [],
): Promise<T | undefined> {
  const { rows } = await sql("select", statement, params);
  return rows[0] as T | undefined;
}

/** Wait for the workspace to finish its first data load. */
export async function ready(page: Page): Promise<void> {
  await expect(page.getByRole("navigation", { name: /breadcrumb|مسار/i })).toBeVisible();
}

export const test = base.extend<{ workspace: void }>({
  workspace: [
    async ({}, use) => {
      await resetWorkspace("en");
      await use();
    },
    { auto: true },
  ],
});

export { expect };
