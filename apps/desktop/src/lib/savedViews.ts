/**
 * Saved table views: a named snapshot of how someone was looking at a list.
 *
 * A view is only useful if it restores what the user actually set, which
 * includes the page's own filter controls — a "Overdue certificates" view that
 * silently drops the overdue filter is worse than no view at all, because it
 * looks applied while showing everything.
 *
 * The state is typed and every value read back from localStorage is validated
 * before it is applied. Storage is user-writable and survives upgrades, so it
 * is treated as untrusted input: anything malformed is dropped rather than
 * being handed to the page.
 */

export type SortDirection = "asc" | "desc";

export interface SavedViewSort {
  key: string;
  dir: SortDirection;
}

/** Page filter state, kept as flat strings so it round-trips through storage. */
export type SavedViewFilters = Record<string, string>;

export interface SavedTableView {
  name: string;
  search: string;
  sort: SavedViewSort | null;
  filters: SavedViewFilters;
}

export const VIEW_STORAGE_PREFIX = "mep.tableViews.";

/** Bounds what a single list can accumulate in storage. */
export const MAX_SAVED_VIEWS = 50;
const MAX_NAME_LENGTH = 60;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSort(raw: unknown): SavedViewSort | null {
  if (!isRecord(raw)) return null;
  const { key, dir } = raw;
  if (typeof key !== "string" || key === "") return null;
  if (dir !== "asc" && dir !== "desc") return null;
  return { key, dir };
}

/** Only string→string pairs survive; anything else is not page filter state. */
function parseFilters(raw: unknown): SavedViewFilters {
  if (!isRecord(raw)) return {};
  const filters: SavedViewFilters = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") filters[key] = value;
  }
  return filters;
}

export function parseSavedViews(raw: unknown): SavedTableView[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const views: SavedTableView[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    if (!name || name.length > MAX_NAME_LENGTH || seen.has(name)) continue;
    seen.add(name);
    views.push({
      name,
      search: typeof entry.search === "string" ? entry.search : "",
      sort: parseSort(entry.sort),
      // Views saved before filters existed simply carry none.
      filters: parseFilters(entry.filters),
    });
    if (views.length >= MAX_SAVED_VIEWS) break;
  }
  return views.sort((left, right) => left.name.localeCompare(right.name));
}

export function readSavedViews(viewKey: string): SavedTableView[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const stored = localStorage.getItem(`${VIEW_STORAGE_PREFIX}${viewKey}`);
    if (stored === null) return [];
    return parseSavedViews(JSON.parse(stored));
  } catch {
    // Corrupt JSON, or storage blocked entirely: show no views rather than
    // taking the page down with it.
    return [];
  }
}

export function writeSavedViews(viewKey: string, views: SavedTableView[]): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(
      `${VIEW_STORAGE_PREFIX}${viewKey}`,
      JSON.stringify(views.slice(0, MAX_SAVED_VIEWS)),
    );
  } catch {
    // Quota exhausted or storage denied. A saved view is a convenience; losing
    // one must never interrupt the work in progress.
  }
}

export function upsertSavedView(
  views: readonly SavedTableView[],
  view: SavedTableView,
): SavedTableView[] {
  return [...views.filter((candidate) => candidate.name !== view.name), view]
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function removeSavedView(
  views: readonly SavedTableView[],
  name: string,
): SavedTableView[] {
  return views.filter((view) => view.name !== name);
}

/**
 * Rename in place. Returns the list unchanged when the new name is empty or
 * already taken, so a rename can never silently overwrite another view.
 */
export function renameSavedView(
  views: readonly SavedTableView[],
  from: string,
  to: string,
): SavedTableView[] {
  const name = to.trim();
  if (!name || name.length > MAX_NAME_LENGTH) return [...views];
  if (name !== from && views.some((view) => view.name === name)) return [...views];
  const target = views.find((view) => view.name === from);
  if (!target) return [...views];
  return upsertSavedView(removeSavedView(views, from), { ...target, name });
}

/** Whether the live table state still matches the view that is selected. */
export function viewMatchesState(
  view: SavedTableView,
  state: { search: string; sort: SavedViewSort | null; filters: SavedViewFilters },
): boolean {
  if (view.search !== state.search) return false;
  if (JSON.stringify(view.sort ?? null) !== JSON.stringify(state.sort ?? null)) return false;
  const viewKeys = Object.keys(view.filters).sort();
  const stateKeys = Object.keys(state.filters).sort();
  if (viewKeys.length !== stateKeys.length) return false;
  return viewKeys.every((key, index) =>
    key === stateKeys[index] && view.filters[key] === state.filters[key]);
}
