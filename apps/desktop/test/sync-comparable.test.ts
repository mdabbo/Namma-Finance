import { describe, expect, it } from "vitest";
import { canonicalTimestamp, comparableJson, comparableText, sameRecord } from "../src/lib/sync/comparable";

describe("canonicalTimestamp", () => {
  it("writes one moment the same way however it was spelled", () => {
    const moment = "2026-11-07T11:53:11.000Z";
    expect(canonicalTimestamp("2026-11-07 11:53:11")).toBe(moment); // SQLite datetime('now'), UTC
    expect(canonicalTimestamp("2026-11-07T11:53:11+00:00")).toBe(moment); // PostgREST timestamptz
    expect(canonicalTimestamp("2026-11-07T11:53:11Z")).toBe(moment);
    expect(canonicalTimestamp("2026-11-07T11:53:11.000Z")).toBe(moment);
    expect(canonicalTimestamp("2026-11-07T11:53:11+00")).toBe(moment);
    expect(canonicalTimestamp("2026-11-07T14:53:11+03:00")).toBe(moment);
    expect(canonicalTimestamp("2026-11-07 11:53")).toBe("2026-11-07T11:53:00.000Z");
  });

  it("keeps different moments different", () => {
    expect(canonicalTimestamp("2026-11-07 11:53:11")).not.toBe(canonicalTimestamp("2026-11-07 11:53:12"));
    expect(canonicalTimestamp("2026-11-07T11:53:11+00:00")).not.toBe(canonicalTimestamp("2026-11-07T11:53:11+03:00"));
    expect(canonicalTimestamp("2026-11-07T11:53:11.123Z")).not.toBe(canonicalTimestamp("2026-11-07T11:53:11.124Z"));
  });

  it("truncates microseconds to the millisecond the desktop can store", () => {
    expect(canonicalTimestamp("2026-11-07T11:53:11.123456+00:00")).toBe("2026-11-07T11:53:11.123Z");
  });

  it("leaves business dates, other text and impossible dates alone", () => {
    expect(canonicalTimestamp("2026-07-20")).toBe("2026-07-20");
    expect(canonicalTimestamp("PROPORTIONAL")).toBe("PROPORTIONAL");
    expect(canonicalTimestamp("Invoice 2026-11-07 11:53:11")).toBe("Invoice 2026-11-07 11:53:11");
    expect(canonicalTimestamp("2026-13-45 99:99:99")).toBe("2026-13-45 99:99:99");
    expect(canonicalTimestamp("")).toBe("");
  });
});

describe("comparing records", () => {
  const local = { approved_at: "2026-11-07 11:53:11", vat_bp: 1400, reason: null, effective_date: "2026-07-20" };
  const cloud = { approved_at: "2026-11-07T11:53:11+00:00", vat_bp: 1400, reason: null, effective_date: "2026-07-20" };

  it("treats a re-spelled moment as the same record", () => {
    expect(comparableJson(local)).toBe(comparableJson(cloud));
    expect(sameRecord(JSON.stringify(local), JSON.stringify(cloud))).toBe(true);
  });

  it("is independent of key order", () => {
    expect(comparableJson({ b: 1, a: 2 })).toBe(comparableJson({ a: 2, b: 1 }));
  });

  it("still sees a changed value, a different moment, a null and a business date", () => {
    expect(sameRecord(JSON.stringify(local), JSON.stringify({ ...cloud, vat_bp: 1500 }))).toBe(false);
    expect(sameRecord(JSON.stringify(local), JSON.stringify({ ...cloud, approved_at: "2026-11-07T11:53:12+00:00" }))).toBe(false);
    expect(sameRecord(JSON.stringify(local), JSON.stringify({ ...cloud, approved_at: null }))).toBe(false);
    expect(sameRecord(JSON.stringify(local), JSON.stringify({ ...cloud, effective_date: "2026-07-21" }))).toBe(false);
    expect(sameRecord(JSON.stringify(local), JSON.stringify({ ...cloud, extra: 1 }))).toBe(false);
  });

  it("does not turn a number into text or text into a number", () => {
    expect(sameRecord(JSON.stringify({ v: 1 }), JSON.stringify({ v: "1" }))).toBe(false);
  });

  it("compares text that is not a JSON object exactly as written", () => {
    expect(comparableText("not json")).toBe("not json");
    expect(comparableText("[1,2]")).toBe("[1,2]");
    expect(sameRecord("not json", "not json")).toBe(true);
    expect(sameRecord("not json", "other")).toBe(false);
  });
});
