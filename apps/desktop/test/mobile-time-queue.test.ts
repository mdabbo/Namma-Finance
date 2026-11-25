import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  applyFlush,
  classifyError,
  discard,
  EMPTY_QUEUE,
  enqueue,
  flush,
  KEEP_SENT_MS,
  parseQueue,
  pendingCount,
  prune,
  retry,
  serverMsFromDateHeader,
  stampFor,
  type FlushDeps,
  type QueueState,
  type SendOutcome,
  type TimeEntryRow,
} from "../../mobile/src/lib/timeQueue";
import {
  addDays,
  isDateOpen,
  openDates,
  parseHours,
  rowFromDraft,
  sqliteUtc,
  validateDraft,
  withdrawn,
  type TimeEntryDraft,
} from "../../mobile/src/lib/timeEntryForm";
import { fetchServerNow, mergeWithQueue, sendTimeEntry } from "../../mobile/src/lib/timeEntriesCloud";

/**
 * Time entries from the phone (plan steps F4 and F5): the outbox that keeps an
 * entry through a dropped signal and delivers it exactly once, and the form
 * rules the phone must apply itself because an office login is not bound by
 * the cloud's 14-day guard.
 */

const T0 = Date.parse("2026-11-19T10:00:00.000Z");

function row(overrides: Partial<TimeEntryRow> = {}): TimeEntryRow {
  return {
    uuid: "11111111-1111-4111-8111-111111111111",
    person_id: "pe-1",
    project_id: "pr-1",
    stage_id: null,
    date: "2026-11-19",
    minutes: 90,
    billable: 1,
    note: null,
    created_at: "2026-11-19 10:00:00",
    deleted_at: null,
    ...overrides,
  };
}

/** A cloud table keyed by uuid, with the last-writer-wins guard. */
function fakeCloud() {
  const table = new Map<string, TimeEntryRow & { updated_at: string }>();
  const sent: (TimeEntryRow & { updated_at: string })[] = [];
  return {
    table,
    sent,
    apply(next: TimeEntryRow & { updated_at: string }): boolean {
      sent.push(next);
      const current = table.get(next.uuid);
      if (current && Date.parse(next.updated_at) <= Date.parse(current.updated_at)) return false;
      table.set(next.uuid, next);
      return true;
    },
  };
}

function deps(cloud: ReturnType<typeof fakeCloud>, options: { serverMs?: number; deviceMs?: number; send?: FlushDeps["send"] } = {}): FlushDeps {
  return {
    serverNow: async () => options.serverMs ?? T0,
    deviceNow: () => options.deviceMs ?? T0,
    send:
      options.send ??
      (async (next) => (cloud.apply(next) ? { kind: "ok" } : { kind: "rejected", message: "STALE" })),
  };
}

async function run(state: QueueState, d: FlushDeps): Promise<QueueState> {
  return applyFlush(state, await flush(state, d), new Date(T0).toISOString());
}

describe("the time-entry outbox", () => {
  it("keeps one item per entry: a change replaces the waiting copy", () => {
    let state = enqueue(EMPTY_QUEUE, row({ minutes: 60 }), "2026-11-19T10:00:00Z");
    state = enqueue(state, row({ minutes: 120 }), "2026-11-19T10:01:00Z");
    expect(state.items).toHaveLength(1);
    expect(state.items[0]!.row.minutes).toBe(120);
    expect(state.items[0]!.rev).toBe(2);
    expect(pendingCount(state)).toBe(1);
  });

  it("sends a waiting entry and marks it sent", async () => {
    const cloud = fakeCloud();
    const state = await run(enqueue(EMPTY_QUEUE, row(), "2026-11-19T10:00:00Z"), deps(cloud));
    expect(state.items[0]!.status).toBe("sent");
    expect(cloud.table.size).toBe(1);
  });

  it("stamps updated_at with the cloud's time when the phone's clock is behind", async () => {
    const cloud = fakeCloud();
    const anHourSlow = T0 - 3_600_000;
    await run(enqueue(EMPTY_QUEUE, row(), "x"), deps(cloud, { serverMs: T0, deviceMs: anHourSlow }));
    expect(Date.parse(cloud.sent[0]!.updated_at)).toBeGreaterThanOrEqual(T0);
  });

  it("never stamps two writes with the same time, even within one cloud second", async () => {
    const cloud = fakeCloud();
    let state = await run(enqueue(EMPTY_QUEUE, row({ minutes: 60 }), "a"), deps(cloud));
    state = await run(enqueue(state, row({ minutes: 75 }), "b"), deps(cloud));
    expect(state.items[0]!.status).toBe("sent");
    // The second change won in the cloud, not dropped as "not newer".
    expect(cloud.table.get(row().uuid)!.minutes).toBe(75);
    expect(Date.parse(cloud.sent[1]!.updated_at)).toBeGreaterThan(Date.parse(cloud.sent[0]!.updated_at));
  });

  it("delivers exactly once when the answer to a send is lost", async () => {
    const cloud = fakeCloud();
    let lose = true;
    const lossy: FlushDeps["send"] = async (next) => {
      cloud.apply(next);
      if (lose) {
        lose = false;
        throw new TypeError("Network request failed");
      }
      return { kind: "ok" };
    };
    let state = await run(enqueue(EMPTY_QUEUE, row(), "a"), deps(cloud, { send: lossy }));
    expect(state.items[0]!.status).toBe("pending");
    state = await run(state, deps(cloud, { send: lossy }));
    expect(state.items[0]!.status).toBe("sent");
    expect(cloud.sent).toHaveLength(2);
    expect(cloud.table.size).toBe(1);
  });

  it("keeps entries waiting while offline and stops trying the rest", async () => {
    const cloud = fakeCloud();
    let calls = 0;
    const offline: FlushDeps["send"] = async () => {
      calls += 1;
      return { kind: "transient", message: "Network request failed" };
    };
    let state = enqueue(EMPTY_QUEUE, row(), "a");
    state = enqueue(state, row({ uuid: "22222222-2222-4222-8222-222222222222" }), "b");
    state = await run(state, deps(cloud, { send: offline }));
    expect(calls).toBe(1);
    expect(state.items.every((item) => item.status === "pending" && item.attempts === 1)).toBe(true);
  });

  it("sends nothing when the cloud's clock cannot be read", async () => {
    const cloud = fakeCloud();
    const state = await run(enqueue(EMPTY_QUEUE, row(), "a"), {
      ...deps(cloud),
      serverNow: async () => {
        throw new Error("NO_SERVER_TIME");
      },
    });
    expect(cloud.sent).toHaveLength(0);
    expect(state.items[0]!.status).toBe("pending");
    expect(state.items[0]!.lastError).toBe("NO_SERVER_TIME");
  });

  it("marks a refusal rejected, keeps its reason, and does not retry it by itself", async () => {
    const cloud = fakeCloud();
    let calls = 0;
    const refuse: FlushDeps["send"] = async () => {
      calls += 1;
      return { kind: "rejected", message: "TIME_ENTRY_LOCKED" };
    };
    let state = await run(enqueue(EMPTY_QUEUE, row(), "a"), deps(cloud, { send: refuse }));
    expect(state.items[0]).toMatchObject({ status: "rejected", lastError: "TIME_ENTRY_LOCKED" });
    state = await run(state, deps(cloud, { send: refuse }));
    expect(calls).toBe(1);
    state = await run(retry(state, row().uuid), deps(cloud));
    expect(state.items[0]!.status).toBe("sent");
    // "Try again" is for refusals only: a sent entry is not sent a second time.
    expect(retry(state, row().uuid)).toEqual(state);
  });

  it("refuses a change the cloud kept a newer version of", async () => {
    const cloud = fakeCloud();
    cloud.table.set(row().uuid, { ...row({ minutes: 30 }), updated_at: new Date(T0 + 60_000).toISOString() });
    const state = await run(enqueue(EMPTY_QUEUE, row(), "a"), deps(cloud));
    expect(state.items[0]).toMatchObject({ status: "rejected", lastError: "STALE" });
    expect(cloud.table.get(row().uuid)!.minutes).toBe(30);
  });

  it("ignores the answer for a version the user changed while it was being sent", async () => {
    const cloud = fakeCloud();
    const before = enqueue(EMPTY_QUEUE, row({ minutes: 60 }), "a");
    const result = await flush(before, deps(cloud));
    const changed = enqueue(before, row({ minutes: 240 }), "b");
    const after = applyFlush(changed, result, "now");
    expect(after.items[0]).toMatchObject({ status: "pending" });
    expect(after.items[0]!.row.minutes).toBe(240);
  });

  it("lets a waiting or refused item be discarded, but not a sent one", async () => {
    const cloud = fakeCloud();
    const waiting = enqueue(EMPTY_QUEUE, row(), "a");
    expect(discard(waiting, row().uuid).items).toHaveLength(0);
    const sent = await run(waiting, deps(cloud));
    expect(discard(sent, row().uuid).items).toHaveLength(1);
  });

  it("forgets sent items after a few days, never waiting ones", async () => {
    const cloud = fakeCloud();
    let state = await run(enqueue(EMPTY_QUEUE, row(), "a"), deps(cloud));
    state = enqueue(state, row({ uuid: "22222222-2222-4222-8222-222222222222" }), "b");
    const later = prune(state, T0 + KEEP_SENT_MS + 1);
    expect(later.items.map((item) => item.status)).toEqual(["pending"]);
  });

  it("survives a damaged stored queue", () => {
    expect(parseQueue(null)).toEqual(EMPTY_QUEUE);
    expect(parseQueue("{not json")).toEqual(EMPTY_QUEUE);
    expect(parseQueue(JSON.stringify({ items: [null, { row: {} }], lastStamp: 5 }))).toEqual({ items: [], lastStamp: 5 });
  });
});

describe("cloud clock and errors", () => {
  it("never puts the stamp behind the cloud, the phone, or the previous stamp", () => {
    expect(stampFor(1000, 500, 0)).toBe(1000);
    expect(stampFor(1000, 2000, 0)).toBe(2000);
    expect(stampFor(1000, 500, 1000)).toBe(1001);
  });

  it("reads the cloud's time from the Date header, rounded up a second", () => {
    expect(serverMsFromDateHeader("Thu, 19 Nov 2026 10:00:00 GMT")).toBe(T0 + 1000);
    expect(serverMsFromDateHeader("garbage")).toBeNull();
    expect(serverMsFromDateHeader(null)).toBeNull();
  });

  it("asks the cloud's health check for the time", async () => {
    let asked = "";
    const fetchStub = (async (url: string, init?: RequestInit) => {
      asked = `${url} ${(init?.headers as Record<string, string>).apikey}`;
      return { headers: new Headers({ date: "Thu, 19 Nov 2026 10:00:00 GMT" }) } as Response;
    }) as unknown as typeof fetch;
    await expect(fetchServerNow("https://x.supabase.co/", "anon", fetchStub)).resolves.toBe(T0 + 1000);
    expect(asked).toBe("https://x.supabase.co/auth/v1/health anon");
    const noDate = (async () => ({ headers: new Headers() }) as Response) as unknown as typeof fetch;
    await expect(fetchServerNow("https://x.supabase.co", "anon", noDate)).rejects.toThrow("NO_SERVER_TIME");
  });

  it("tells a dropped connection from a refusal", () => {
    const kind = (error: Parameters<typeof classifyError>[0]) => classifyError(error).kind;
    expect(kind({ code: "", message: "TypeError: Network request failed" })).toBe("transient");
    expect(kind({ code: "PGRST301", message: "JWT expired" })).toBe("transient");
    expect(kind({ code: "08006", message: "connection failure" })).toBe("transient");
    expect(kind({ code: "57014", message: "statement timeout" })).toBe("transient");
    expect(kind({ code: "42501", message: "new row violates row-level security policy" })).toBe("rejected");
    expect(kind({ code: "23503", message: "foreign key violation" })).toBe("rejected");
    expect(classifyError({ code: "P0001", message: "TIME_ENTRY_LOCKED" })).toEqual({ kind: "rejected", message: "TIME_ENTRY_LOCKED" });
    expect(classifyError({ code: "42501", message: "TIME_ENTRY_NOT_OWN" })).toEqual({ kind: "rejected", message: "TIME_ENTRY_NOT_OWN" });
  });
});

describe("sending one entry", () => {
  function stubClient(answer: { data: unknown; error: unknown; status?: number }) {
    const calls: { table: string; row: unknown; options: unknown }[] = [];
    const client = {
      from: (table: string) => ({
        upsert: (value: unknown, options: unknown) => {
          calls.push({ table, row: value, options });
          return { select: async () => answer };
        },
      }),
    } as unknown as SupabaseClient;
    return { client, calls };
  }

  it("upserts on the uuid into time_entries", async () => {
    const { client, calls } = stubClient({ data: [{ uuid: "u" }], error: null, status: 201 });
    await expect(sendTimeEntry(client, { ...row(), updated_at: "2026-11-19T10:00:01.000Z" })).resolves.toEqual({ kind: "ok" });
    expect(calls).toEqual([{ table: "time_entries", row: expect.objectContaining({ uuid: row().uuid }), options: { onConflict: "uuid" } }]);
  });

  it("reports an answer with no row as a newer cloud version", async () => {
    const { client } = stubClient({ data: [], error: null, status: 201 });
    await expect(sendTimeEntry(client, { ...row(), updated_at: "x" })).resolves.toEqual({ kind: "rejected", message: "STALE" });
  });

  it("passes the cloud's refusal on", async () => {
    const { client } = stubClient({ data: null, error: { code: "P0001", message: "TIME_ENTRY_STAGE_MISMATCH" }, status: 400 });
    const outcome: SendOutcome = await sendTimeEntry(client, { ...row(), updated_at: "x" });
    expect(outcome).toEqual({ kind: "rejected", message: "TIME_ENTRY_STAGE_MISMATCH" });
  });
});

describe("the time-entry form", () => {
  const today = "2026-11-19";
  const draft = (overrides: Partial<TimeEntryDraft> = {}): TimeEntryDraft => ({
    personId: "pe-1",
    projectId: "pr-1",
    stageId: null,
    date: today,
    hours: "1.5",
    billable: true,
    note: "",
    ...overrides,
  });

  it("reads hours however they are typed", () => {
    expect(parseHours("1.5")).toBe(90);
    expect(parseHours("1,5")).toBe(90);
    expect(parseHours("١٫٥")).toBe(90);
    expect(parseHours("1:30")).toBe(90);
    expect(parseHours(" 8 ")).toBe(480);
    expect(parseHours(".25")).toBe(15);
    for (const bad of ["", "0", "-1", "abc", "1:75", "1.2.3", "0:00"]) expect(parseHours(bad)).toBeNull();
  });

  it("offers today and the 14 days before it, and nothing else", () => {
    const dates = openDates(today);
    expect(dates).toHaveLength(15);
    expect(dates[0]).toBe(today);
    expect(dates[14]).toBe("2026-11-05");
    expect(isDateOpen("2026-11-05", today)).toBe(true);
    expect(isDateOpen("2026-11-04", today)).toBe(false);
    expect(isDateOpen("2026-11-20", today)).toBe(false);
    expect(isDateOpen("garbage", today)).toBe(false);
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("accepts a complete draft and names each missing field", () => {
    expect(validateDraft(draft(), today)).toEqual([]);
    expect(validateDraft(draft({ personId: null, projectId: null }), today)).toEqual(["person", "project"]);
    expect(validateDraft(draft({ hours: "0" }), today)).toEqual(["hours"]);
    expect(validateDraft(draft({ hours: "1001" }), today)).toEqual(["hours"]); // over the core's 1000 h limit
    expect(validateDraft(draft({ date: "2026-11-01" }), today)).toEqual(["date"]);
  });

  it("builds the cloud row, keeping an edited entry's uuid and created_at", () => {
    const built = rowFromDraft(draft({ billable: false, note: "  site visit " }), { uuid: "keep-me", createdAt: "2026-11-18 07:00:00" });
    expect(built).toEqual({
      uuid: "keep-me",
      person_id: "pe-1",
      project_id: "pr-1",
      stage_id: null,
      date: today,
      minutes: 90,
      billable: 0,
      note: "site visit",
      created_at: "2026-11-18 07:00:00",
      deleted_at: null,
    });
    expect(sqliteUtc(new Date(T0))).toBe("2026-11-19 10:00:00");
    expect(withdrawn(built, new Date(T0)).deleted_at).toBe("2026-11-19T10:00:00.000Z");
  });

  it("shows queued changes over the cloud's copy and hides queued deletions", () => {
    const a = row({ uuid: "a", minutes: 60 });
    const b = row({ uuid: "b", minutes: 60, date: "2026-11-18" });
    const merged = mergeWithQueue([a, b], [
      { row: { ...a, minutes: 120 }, status: "pending" },
      { row: withdrawn(b, new Date(T0)), status: "pending" },
      { row: row({ uuid: "c" }), status: "rejected" },
    ]);
    expect(merged.map((entry) => [entry.row.uuid, entry.row.minutes, entry.queued])).toEqual([
      ["a", 120, true],
      ["c", 90, true],
    ]);
  });
});

describe("the phone writes nothing but time entries", () => {
  const mobile = fileURLToPath(new URL("../../mobile", import.meta.url));
  const files: string[] = [];
  const collect = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "dist" || name === "generated" || name === "preview") continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) collect(path);
      else if (/\.tsx?$/.test(name)) files.push(path);
    }
  };
  collect(join(mobile, "src"));
  files.push(join(mobile, "App.tsx"));

  it("keeps every cloud write in lib/timeEntriesCloud.ts, aimed at time_entries", () => {
    const writers = files.filter((path) => /\.(insert|upsert|update|delete)\s*\(/.test(readFileSync(path, "utf8")));
    expect(writers.map((path) => relative(mobile, path).replace(/\\/g, "/"))).toEqual(["src/lib/timeEntriesCloud.ts"]);
    const source = readFileSync(join(mobile, "src/lib/timeEntriesCloud.ts"), "utf8");
    const writes = source.match(/\.from\([^)]*\)\s*\.(insert|upsert|update|delete)\(/g) ?? [];
    expect(writes).toEqual([".from(TIME_ENTRIES).upsert("]);
    expect(source).toContain('export const TIME_ENTRIES = "time_entries";');
  });
});
