import { describe, expect, it } from "vitest";
import {
  MAX_SAVED_VIEWS,
  parseSavedViews,
  removeSavedView,
  renameSavedView,
  upsertSavedView,
  viewMatchesState,
  type SavedTableView,
} from "../src/lib/savedViews";

/**
 * Milestone 6: saved views carry page filter state, and everything read back
 * from localStorage is validated first. Storage is user-writable and survives
 * upgrades, so it is untrusted input — a corrupt entry must be dropped, never
 * applied to the page and never allowed to throw.
 */

const view = (over: Partial<SavedTableView> = {}): SavedTableView => ({
  name: "Overdue",
  search: "tower",
  sort: { key: "dueDate", dir: "asc" },
  filters: { status: "APPROVED", view: "overdue" },
  ...over,
});

describe("saved view validation", () => {
  it("round-trips a complete view including its filters", () => {
    expect(parseSavedViews([view()])).toEqual([view()]);
  });

  it("keeps views saved before filters existed, with no filters", () => {
    const legacy = { name: "Old", search: "x", sort: null };
    expect(parseSavedViews([legacy])).toEqual([
      { name: "Old", search: "x", sort: null, filters: {} },
    ]);
  });

  it("drops anything that is not a well-formed view instead of throwing", () => {
    const parsed = parseSavedViews([
      null,
      "a string",
      42,
      {},                                   // no name
      { name: "   " },                      // blank name
      { name: "x".repeat(200) },            // absurd name
      { name: "Good", search: 5 },          // wrong search type
      view(),
    ]);
    expect(parsed.map((entry) => entry.name)).toEqual(["Good", "Overdue"]);
    // A bad search type falls back rather than poisoning the field.
    expect(parsed.find((entry) => entry.name === "Good")?.search).toBe("");
  });

  it("rejects malformed sort and non-string filter values", () => {
    const [parsed] = parseSavedViews([
      {
        name: "Odd",
        search: "",
        sort: { key: "amount", dir: "sideways" },
        filters: { good: "yes", bad: 5, worse: { nested: true }, missing: null },
      },
    ]);
    expect(parsed?.sort).toBeNull();
    expect(parsed?.filters).toEqual({ good: "yes" });
  });

  it("is not a JSON parser and never throws on garbage", () => {
    expect(parseSavedViews("not an array")).toEqual([]);
    expect(parseSavedViews(null)).toEqual([]);
    expect(parseSavedViews({ name: "object not array" })).toEqual([]);
  });

  it("drops duplicate names and bounds how much storage one list can hold", () => {
    const many = Array.from({ length: MAX_SAVED_VIEWS + 25 }, (_, index) =>
      view({ name: `View ${String(index).padStart(3, "0")}` }));
    expect(parseSavedViews([...many, view({ name: "View 000" })]))
      .toHaveLength(MAX_SAVED_VIEWS);
  });
});

describe("saved view editing", () => {
  it("replaces a view of the same name rather than duplicating it", () => {
    const next = upsertSavedView([view()], view({ search: "changed" }));
    expect(next).toHaveLength(1);
    expect(next[0]?.search).toBe("changed");
  });

  it("removes by name", () => {
    expect(removeSavedView([view(), view({ name: "Other" })], "Overdue"))
      .toEqual([view({ name: "Other" })]);
  });

  it("renames while keeping the view's state", () => {
    const [renamed] = renameSavedView([view()], "Overdue", "Late invoices");
    expect(renamed?.name).toBe("Late invoices");
    expect(renamed?.filters).toEqual(view().filters);
  });

  it("refuses a rename that would silently overwrite another view", () => {
    const views = [view(), view({ name: "Other", search: "keep me" })];
    const next = renameSavedView(views, "Overdue", "Other");
    expect(next.map((entry) => entry.name).sort()).toEqual(["Other", "Overdue"]);
    expect(next.find((entry) => entry.name === "Other")?.search).toBe("keep me");
  });

  it("refuses an empty rename", () => {
    expect(renameSavedView([view()], "Overdue", "   ")).toEqual([view()]);
  });
});

describe("active view indication", () => {
  it("matches only while the table still reflects the saved view", () => {
    const saved = view();
    expect(viewMatchesState(saved, {
      search: saved.search, sort: saved.sort, filters: saved.filters,
    })).toBe(true);
  });

  it("reports a changed filter, search or sort as no longer matching", () => {
    const saved = view();
    expect(viewMatchesState(saved, {
      search: saved.search, sort: saved.sort, filters: { ...saved.filters, status: "PAID" },
    })).toBe(false);
    expect(viewMatchesState(saved, {
      search: "different", sort: saved.sort, filters: saved.filters,
    })).toBe(false);
    expect(viewMatchesState(saved, {
      search: saved.search, sort: null, filters: saved.filters,
    })).toBe(false);
    // A dropped filter counts as a change even though the rest still matches.
    expect(viewMatchesState(saved, {
      search: saved.search, sort: saved.sort, filters: { status: "APPROVED" },
    })).toBe(false);
  });
});
