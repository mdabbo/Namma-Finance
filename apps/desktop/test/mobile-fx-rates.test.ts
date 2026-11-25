import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { chooseRate, loadDesktopRates, parseDesktopRates, rateAgeDays, STALE_RATE_DAYS } from "../../mobile/src/lib/fxRates";

/**
 * The phone uses the exchange rates the desktop publishes (fx_rates), so both
 * apps report the same figures; a rate typed on the phone is only a fallback.
 */

const SAR = { code: "SAR", fx_rate_micro: 12_850_000, updated_at: "2026-11-20T08:00:00.000Z" };

describe("reading the desktop's rates", () => {
  it("keeps SAR and USD with sane values", () => {
    expect(parseDesktopRates([SAR, { code: "USD", fx_rate_micro: 48_650_000, updated_at: "2026-11-01T00:00:00Z" }])).toEqual({
      SAR: { fxRateMicro: 12_850_000, updatedAt: "2026-11-20T08:00:00.000Z" },
      USD: { fxRateMicro: 48_650_000, updatedAt: "2026-11-01T00:00:00Z" },
    });
  });

  it("drops currencies the phone does not report in, EGP, and bad values", () => {
    expect(parseDesktopRates([
      { code: "EUR", fx_rate_micro: 52_000_000, updated_at: "x" },
      { code: "EGP", fx_rate_micro: 1_000_000, updated_at: "x" },
      { code: "SAR", fx_rate_micro: 0, updated_at: "x" },
      { code: "USD", fx_rate_micro: -1, updated_at: "x" },
      { code: "USD", fx_rate_micro: 1.5, updated_at: "x" },
      { code: "USD", fx_rate_micro: "abc", updated_at: "x" },
      null,
    ])).toEqual({});
    expect(parseDesktopRates(null)).toEqual({});
  });

  it("keeps the newest if a currency appears twice", () => {
    const older = { ...SAR, fx_rate_micro: 11_000_000, updated_at: "2026-10-01T00:00:00Z" };
    expect(parseDesktopRates([SAR, older]).SAR!.fxRateMicro).toBe(12_850_000);
    expect(parseDesktopRates([older, SAR]).SAR!.fxRateMicro).toBe(12_850_000);
  });

  it("answers with no rates when the cloud table is missing, instead of failing", async () => {
    const missing = { from: () => ({ select: async () => ({ data: null, error: { message: "relation fx_rates does not exist" } }) }) } as unknown as SupabaseClient;
    await expect(loadDesktopRates(missing)).resolves.toEqual({});
    let asked = "";
    const present = { from: (table: string) => ({ select: async (cols: string) => { asked = `${table}:${cols}`; return { data: [SAR], error: null }; } }) } as unknown as SupabaseClient;
    await expect(loadDesktopRates(present)).resolves.toEqual({ SAR: { fxRateMicro: 12_850_000, updatedAt: SAR.updated_at } });
    expect(asked).toBe("fx_rates:code,fx_rate_micro,updated_at");
  });
});

describe("which rate the phone uses", () => {
  const desktop = parseDesktopRates([SAR]);

  it("uses the desktop's rate over a typed one", () => {
    expect(chooseRate("SAR", desktop, 13_000_000)).toEqual({ fxRateMicro: 12_850_000, source: "desktop", updatedAt: SAR.updated_at });
  });

  it("falls back to the typed rate when the desktop has none for that currency", () => {
    expect(chooseRate("USD", desktop, 48_000_000)).toEqual({ fxRateMicro: 48_000_000, source: "typed", updatedAt: null });
  });

  it("has no rate rather than guessing one", () => {
    expect(chooseRate("USD", desktop, null)).toEqual({ fxRateMicro: null, source: null, updatedAt: null });
    expect(chooseRate("USD", {}, 0).fxRateMicro).toBeNull();
  });

  it("always uses 1 for EGP", () => {
    expect(chooseRate("EGP", desktop, 5).fxRateMicro).toBe(1_000_000);
  });
});

describe("how old a rate is", () => {
  const now = Date.parse("2026-11-25T12:00:00Z");
  it("counts whole days since the desktop changed it", () => {
    expect(rateAgeDays("2026-11-25T08:00:00Z", now)).toBe(0);
    expect(rateAgeDays("2026-11-11T12:00:00Z", now)).toBe(14);
    expect(rateAgeDays("2026-11-11T12:00:01Z", now)).toBe(13);
    expect(rateAgeDays(null, now)).toBeNull();
    expect(rateAgeDays("garbage", now)).toBeNull();
    expect(rateAgeDays("2026-12-01T00:00:00Z", now)).toBe(0); // a desktop clock ahead never shows negative
    expect(STALE_RATE_DAYS).toBe(14);
  });
});
