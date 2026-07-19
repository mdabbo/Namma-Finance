import { beforeAll, expect, it, vi } from "vitest";

vi.mock("../src/lib/db", async () => await import("./db-harness"));

import { resetDb, raw } from "./db-harness";
import { createClient } from "../src/repositories/clients";

beforeAll(() => resetDb());

it("runs all migrations and the real clients repo against node:sqlite", async () => {
  const id = await createClient({ name: "Acme", company: null, address: null, phone: null, email: null, taxNumber: null, contacts: null, notes: null });
  expect(id).toBeGreaterThan(0);
  const rows = raw("SELECT name, sync_uuid FROM clients");
  expect(rows).toHaveLength(1);
  expect((rows[0] as { name: string }).name).toBe("Acme");
  // migration 0006 trigger should have stamped a sync uuid
  expect((rows[0] as { sync_uuid: string | null }).sync_uuid).toBeTruthy();
});
