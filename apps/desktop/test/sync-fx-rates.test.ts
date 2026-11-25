import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/db", async () => await import("./sync-harness"));
vi.mock("../src/lib/sync/client", async () => {
  const rig = await import("./sync-harness");
  return {
    getSyncClient: async () => rig.makeFakeClient(),
    resetSyncClient: () => undefined,
    SyncNotConfiguredError: class extends Error {},
  };
});

import { runSync } from "../src/lib/sync/engine";
import { execute, failTable, newDevice, rawOn, remoteRows, resetRig, useDevice } from "./sync-harness";

/**
 * The desktop publishes its exchange rates to the cloud for the phone
 * (publishFxRates in lib/sync/engine.ts). It must publish the right rows, keep
 * the moment each rate was changed, and never let a failure stop the sync.
 */

beforeEach(() => resetRig());
afterEach(() => resetRig());

const rates = () => Object.fromEntries(remoteRows("fx_rates").map((row) => [row.code as string, row]));

describe("publishing the desktop's rates", () => {
  it("publishes every foreign currency and never EGP", async () => {
    newDevice("A");
    const report = await runSync();
    expect(report.ok).toBe(true);
    const published = rates();
    expect(Object.keys(published).sort()).toEqual(
      rawOn<{ code: string }>("A", "SELECT code FROM currencies WHERE code <> 'EGP'").map((row) => row.code).sort(),
    );
    expect(published.EGP).toBeUndefined();
    expect(published.SAR!.fx_rate_micro).toBe(12_900_000);
    expect(report.ratesPublished).toBe(Object.keys(published).length);
    expect(report.ratesError).toBeUndefined();
  });

  it("sends a changed rate with the moment it was changed, in UTC", async () => {
    newDevice("A");
    await execute("UPDATE currencies SET fx_rate_micro=$1, updated_at=$2 WHERE code='USD'", [50_250_000, "2026-11-20 08:30:00"]);
    await runSync();
    expect(rates().USD).toMatchObject({ fx_rate_micro: 50_250_000, updated_at: "2026-11-20T08:30:00.000Z" });
  });

  it("moves a rate forward on the next sync", async () => {
    newDevice("A");
    await execute("UPDATE currencies SET fx_rate_micro=$1, updated_at=$2 WHERE code='SAR'", [13_000_000, "2026-11-01 00:00:00"]);
    await runSync();
    await execute("UPDATE currencies SET fx_rate_micro=$1, updated_at=$2 WHERE code='SAR'", [13_100_000, "2026-11-22 00:00:00"]);
    await runSync();
    expect(rates().SAR!.fx_rate_micro).toBe(13_100_000);
  });

  it("does not let an older rate from another PC replace a newer one", async () => {
    newDevice("A");
    newDevice("B");
    useDevice("A");
    await execute("UPDATE currencies SET fx_rate_micro=$1, updated_at=$2 WHERE code='SAR'", [13_100_000, "2026-11-22 00:00:00"]);
    await runSync();
    useDevice("B");
    await execute("UPDATE currencies SET fx_rate_micro=$1, updated_at=$2 WHERE code='SAR'", [12_000_000, "2026-11-10 00:00:00"]);
    await runSync();
    expect(rates().SAR!.fx_rate_micro).toBe(13_100_000);
  });

  it("publishes nothing it should not: a zero rate cannot exist locally, and EGP is skipped", async () => {
    newDevice("A");
    const [{ n }] = rawOn<{ n: number }>("A", "SELECT COUNT(*) AS n FROM currencies WHERE code='EGP'");
    expect(n).toBe(1);
    await runSync();
    expect(remoteRows("fx_rates").every((row) => Number(row.fx_rate_micro) > 0 && row.code !== "EGP")).toBe(true);
  });
});

describe("when publishing fails", () => {
  it("never fails the sync, and says why on the report", async () => {
    newDevice("A");
    failTable("fx_rates", "Could not find the table 'public.fx_rates' in the schema cache");
    const report = await runSync();
    expect(report.ok).toBe(true);
    expect(report.error).toBeUndefined();
    expect(report.ratesError).toContain("fx_rates");
    expect(report.ratesPublished).toBeUndefined();
  });

  it("still exchanges the rest of the data", async () => {
    newDevice("A");
    await execute("INSERT INTO clients (name) VALUES ('Acme')");
    failTable("fx_rates", "boom");
    const report = await runSync();
    expect(report.ok).toBe(true);
    expect(remoteRows("clients")).toHaveLength(1);
  });

  it("publishes on the next sync once the table exists", async () => {
    newDevice("A");
    failTable("fx_rates", "missing");
    await runSync();
    failTable("fx_rates", null);
    const report = await runSync();
    expect(report.ratesError).toBeUndefined();
    expect(Object.keys(rates()).length).toBeGreaterThan(0);
  });

  it("survives the rates table itself being unreadable locally", async () => {
    newDevice("A");
    await execute("ALTER TABLE currencies RENAME TO currencies_gone");
    const report = await runSync();
    expect(report.ok).toBe(true);
    expect(report.ratesError).toBeTruthy();
  });
});
