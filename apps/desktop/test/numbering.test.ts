import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/lib/db", async () => await import("./db-harness"));
import { raw, rawExec, resetDb } from "./db-harness";
import { reserveNextNumber } from "../src/repositories/numbering";

beforeEach(() => resetDb());

describe("Milestone 14 transactional numbering", () => {
  it("reserves unique numbers atomically and resets by year", async () => {
    const numbers = await Promise.all(Array.from({ length: 20 }, () => reserveNextNumber("PROJECT", "PRJ", new Date("2026-01-01T00:00:00Z"))));
    expect(new Set(numbers).size).toBe(20);
    expect(numbers).toContain("PRJ-2026-001");
    expect(await reserveNextNumber("PROJECT", "PRJ", new Date("2027-01-01T00:00:00Z"))).toBe("PRJ-2027-001");
  });

  it("keeps prefix histories independent and rejects invalid prefixes", async () => {
    expect(await reserveNextNumber("PAYMENT", "PAY", new Date("2026-01-01T00:00:00Z"))).toBe("PAY-2026-0001");
    expect(await reserveNextNumber("PAYMENT", "RCPT", new Date("2026-01-01T00:00:00Z"))).toBe("RCPT-2026-0001");
    expect(await reserveNextNumber("PAYMENT", "PAY", new Date("2026-01-01T00:00:00Z"))).toBe("PAY-2026-0002");
    await expect(reserveNextNumber("PAYMENT", "bad prefix!", new Date("2026-01-01T00:00:00Z"))).rejects.toThrow("INVALID_NUMBER_PREFIX");
  });

  it("starts after existing imported numbers instead of colliding", async () => {
    rawExec("INSERT INTO clients(name) VALUES('Imported')");
    rawExec("INSERT INTO projects(code,name,client_id,currency,fx_rate_micro) VALUES('PRJ-2026-087','Imported',1,'EGP',1000000)");
    expect(await reserveNextNumber("PROJECT", "PRJ", new Date("2026-06-01T00:00:00Z"))).toBe("PRJ-2026-088");
  });

  it("enforces scoped human-number uniqueness without changing legacy rows", () => {
    rawExec("INSERT INTO clients(name) VALUES('N')");
    rawExec("INSERT INTO projects(code,name,client_id,currency,fx_rate_micro) VALUES('PRJ-2026-001','P',1,'EGP',1000000)");
    rawExec("INSERT INTO contracts(project_id,number,value_minor) VALUES(1,'CON-2026-0001',1000)");
    expect(() => rawExec("INSERT INTO contracts(project_id,number,value_minor) VALUES(1,'CON-2026-0001',2000)")).toThrow(/DUPLICATE_CONTRACT_NUMBER/);
    rawExec("INSERT INTO expense_categories(name_en,name_ar) VALUES('X','X')");
    rawExec("INSERT INTO expenses(date,category_id,description,amount_minor) VALUES('2026-01-01',1,'fallback',100)");
    expect((raw("SELECT number FROM expenses")[0] as { number: string }).number).toMatch(/^EXP-2026-/);
    expect(() => rawExec("UPDATE expenses SET number=NULL WHERE id=1")).toThrow(/EXPENSE_NUMBER_REQUIRED/);
  });
});
