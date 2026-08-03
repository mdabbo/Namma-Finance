import { useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  BookmarkPlus,
  ChevronLeft,
  ChevronRight,
  FileDown,
  FilterX,
  Pencil,
  Search,
  Trash2,
} from "lucide-react";
import {
  readSavedViews,
  removeSavedView,
  renameSavedView,
  upsertSavedView,
  viewMatchesState,
  writeSavedViews,
  type SavedTableView,
  type SavedViewFilters,
} from "../lib/savedViews";
import {
  EmptyState,
  IconButton,
  Input,
  LoadingState,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  cx,
} from "./ui";

export interface Column<T> {
  key: string;
  header: string;
  /** Value used for sorting and text filtering. */
  value?: (row: T) => string | number | null;
  /**
   * Value written to CSV, defaulting to `value`. Money columns MUST set this:
   * `value` carries integer minor units for exact sorting, which a spreadsheet
   * would otherwise sum as if it were a major-unit amount.
   */
  exportValue?: (row: T) => string | number | null;
  render?: (row: T) => ReactNode;
  sortable?: boolean;
  align?: "start" | "end";
  width?: string;
}

interface DataTableProps<T> {
  rows: T[];
  columns: Column<T>[];
  rowKey: (row: T) => string | number;
  onRowClick?: (row: T) => void;
  searchable?: boolean;
  /** Extra filter controls rendered beside the search box. */
  toolbar?: ReactNode;
  emptyMessage?: string;
  initialSort?: { key: string; dir: "asc" | "desc" };
  pageSize?: number;
  density?: "comfortable" | "compact";
  loading?: boolean;
  /** File name (without extension) enabling CSV export of the filtered rows. */
  exportName?: string;
  /** Storage key enabling named saved views (search + sort + page filters). */
  viewKey?: string;
  /**
   * The page's own filter state, saved and restored with a view. Without it a
   * view would silently drop the filters the user set, which looks applied
   * while showing the wrong rows.
   */
  filters?: SavedViewFilters;
  /** Applies a restored view's filters back onto the page. */
  onApplyFilters?: (filters: SavedViewFilters) => void;
  /** Clears the page's filters for "reset filters". */
  onResetFilters?: () => void;
}

const NUMERIC_CELL = /^-?\d+(\.\d+)?$/;

/**
 * Build a spreadsheet-safe CSV of every column with a plain value. Cells that
 * a spreadsheet would evaluate as a formula are prefixed with an apostrophe
 * (plain negative numbers stay untouched so amounts import correctly).
 */
export function buildCsv<T>(columns: Column<T>[], rows: T[]): string {
  const exportable = columns
    .filter((column) => column.exportValue ?? column.value)
    .map((column) => ({ header: column.header, cell: (column.exportValue ?? column.value)! }));
  const escape = (value: string | number | null | undefined) => {
    const raw = value === null || value === undefined ? "" : String(value);
    const guarded = /^[=+@\t\r]/.test(raw) || (raw.startsWith("-") && !NUMERIC_CELL.test(raw))
      ? `'${raw}`
      : raw;
    return /[",\n\r]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
  };
  const lines = [
    exportable.map((column) => escape(column.header)).join(","),
    ...rows.map((row) => exportable.map((column) => escape(column.cell(row))).join(",")),
  ];
  // UTF-8 BOM so Excel opens Arabic text correctly.
  return "﻿" + lines.join("\r\n") + "\r\n";
}

const INTERACTIVE_TARGET_SELECTOR =
  'button, a, input, select, textarea, [role="button"], [role="link"], [contenteditable="true"]';

export function isInteractiveTableTarget(target: unknown): boolean {
  if (!target || typeof (target as { closest?: unknown }).closest !== "function") return false;
  return Boolean((target as { closest: (selector: string) => unknown }).closest(INTERACTIVE_TARGET_SELECTOR));
}

export function DataTable<T>({
  rows,
  columns,
  rowKey,
  onRowClick,
  searchable = true,
  toolbar,
  emptyMessage,
  initialSort,
  pageSize = 25,
  density = "comfortable",
  loading = false,
  exportName,
  viewKey,
  filters,
  onApplyFilters,
  onResetFilters,
}: DataTableProps<T>) {
  const { t, i18n } = useTranslation();
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<{ key: string; dir: "asc" | "desc" } | null>(initialSort ?? null);
  const [page, setPage] = useState(0);
  const [views, setViews] = useState<SavedTableView[]>(() => (viewKey ? readSavedViews(viewKey) : []));
  const [activeViewName, setActiveViewName] = useState("");
  const [namingView, setNamingView] = useState(false);
  const [renamingView, setRenamingView] = useState(false);
  const [viewName, setViewName] = useState("");

  const currentFilters = filters ?? {};
  const activeView = views.find((view) => view.name === activeViewName) ?? null;
  // A view stays "active" only while the table still matches it; touching a
  // filter afterwards must not leave a stale name claiming to describe the rows.
  const viewIsCurrent = activeView
    ? viewMatchesState(activeView, { search, sort, filters: currentFilters })
    : false;

  function commitViews(next: SavedTableView[]) {
    setViews(next);
    if (viewKey) writeSavedViews(viewKey, next);
  }

  function applyView(name: string) {
    setActiveViewName(name);
    const view = views.find((candidate) => candidate.name === name);
    if (!view) return;
    setSearch(view.search);
    setSort(view.sort);
    setPage(0);
    onApplyFilters?.(view.filters);
  }

  function saveCurrentView() {
    const name = viewName.trim();
    if (!viewKey || !name) return;
    commitViews(upsertSavedView(views, { name, search, sort, filters: currentFilters }));
    setActiveViewName(name);
    setNamingView(false);
    setViewName("");
  }

  function renameActiveView() {
    const name = viewName.trim();
    if (!viewKey || !activeViewName || !name) return;
    commitViews(renameSavedView(views, activeViewName, name));
    setActiveViewName(name);
    setRenamingView(false);
    setViewName("");
  }

  function deleteActiveView() {
    if (!viewKey || !activeViewName) return;
    commitViews(removeSavedView(views, activeViewName));
    setActiveViewName("");
  }

  function resetFilters() {
    setSearch("");
    setSort(initialSort ?? null);
    setPage(0);
    setActiveViewName("");
    onResetFilters?.();
  }

  const filtered = useMemo(() => {
    let result = rows;
    const q = search.trim().toLowerCase();
    if (q) {
      result = rows.filter((row) =>
        columns.some((col) => {
          const value = col.value?.(row);
          return value !== null && value !== undefined && String(value).toLowerCase().includes(q);
        }),
      );
    }
    if (sort) {
      const column = columns.find((candidate) => candidate.key === sort.key);
      if (column?.value) {
        const direction = sort.dir === "asc" ? 1 : -1;
        result = [...result].sort((a, b) => {
          const valueA = column.value!(a);
          const valueB = column.value!(b);
          if (valueA === null || valueA === undefined) return 1;
          if (valueB === null || valueB === undefined) return -1;
          if (typeof valueA === "number" && typeof valueB === "number") return (valueA - valueB) * direction;
          return String(valueA).localeCompare(String(valueB)) * direction;
        });
      }
    }
    return result;
  }, [rows, columns, search, sort]);

  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, pages - 1);
  const visible = filtered.slice(currentPage * pageSize, (currentPage + 1) * pageSize);

  function toggleSort(key: string) {
    setSort((current) =>
      current?.key === key
        ? current.dir === "asc"
          ? { key, dir: "desc" }
          : null
        : { key, dir: "asc" },
    );
  }

  const PreviousIcon = i18n.dir() === "rtl" ? ChevronRight : ChevronLeft;
  const NextIcon = i18n.dir() === "rtl" ? ChevronLeft : ChevronRight;
  const cellPadding = density === "compact" ? "py-1.5" : "py-2.5";

  async function exportCsv() {
    if (!exportName) return;
    try {
      const [{ save }, { writeTextFile }] = await Promise.all([
        import("@tauri-apps/plugin-dialog"),
        import("@tauri-apps/plugin-fs"),
      ]);
      const path = await save({
        defaultPath: `${exportName}.csv`,
        filters: [{ name: "CSV", extensions: ["csv"] }],
      });
      if (path) await writeTextFile(path, buildCsv(columns, filtered));
    } catch (error) {
      console.error("CSV export failed", error);
    }
  }

  return (
    <div>
      {(searchable || toolbar || exportName || viewKey) && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          {searchable && (
            <div className="relative w-64">
              <Search
                size={15}
                className="pointer-events-none absolute start-2.5 top-2.5 text-slate-400"
                aria-hidden="true"
              />
              <Input
                value={search}
                aria-label={t("common.search")}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setPage(0);
                }}
                placeholder={t("common.search")}
                className="ps-8"
              />
            </div>
          )}
          {toolbar}
          {(exportName || viewKey) && (
            <div className="ms-auto flex items-center gap-1.5">
              {viewKey && (
                <>
                  <Select
                    className="!w-40"
                    aria-label={t("common.savedViews")}
                    value={activeViewName}
                    onChange={(event) => applyView(event.target.value)}
                  >
                    <option value="">{t("common.savedViews")}</option>
                    {views.map((view) => (
                      <option key={view.name} value={view.name}>{view.name}</option>
                    ))}
                  </Select>
                  {namingView || renamingView ? (
                    <Input
                      autoFocus
                      className="!w-36"
                      value={viewName}
                      placeholder={t("common.viewName")}
                      aria-label={t("common.viewName")}
                      onChange={(event) => setViewName(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          if (renamingView) renameActiveView();
                          else saveCurrentView();
                        }
                        if (event.key === "Escape") {
                          setNamingView(false);
                          setRenamingView(false);
                          setViewName("");
                        }
                      }}
                      onBlur={() => {
                        setNamingView(false);
                        setRenamingView(false);
                      }}
                    />
                  ) : (
                    <IconButton
                      label={t("common.saveView")}
                      icon={BookmarkPlus}
                      size="sm"
                      onClick={() => setNamingView(true)}
                    />
                  )}
                  {activeViewName && !namingView && !renamingView && (
                    <IconButton
                      label={t("common.renameView")}
                      icon={Pencil}
                      size="sm"
                      onClick={() => {
                        setViewName(activeViewName);
                        setRenamingView(true);
                      }}
                    />
                  )}
                  {activeViewName && (
                    <IconButton
                      label={t("common.deleteView")}
                      icon={Trash2}
                      size="sm"
                      onClick={deleteActiveView}
                    />
                  )}
                  {/*
                    Says plainly whether the rows on screen are still the saved
                    view or have been changed since it was applied.
                  */}
                  {activeViewName && (
                    <span
                      className="text-xs text-muted"
                      data-testid="active-view-state"
                    >
                      {viewIsCurrent ? t("common.viewActive") : t("common.viewModified")}
                    </span>
                  )}
                </>
              )}
              {(viewKey || onResetFilters) && (
                <IconButton
                  label={t("common.resetFilters")}
                  icon={FilterX}
                  size="sm"
                  onClick={resetFilters}
                />
              )}
              {exportName && (
                <IconButton
                  label={t("common.exportCsv")}
                  icon={FileDown}
                  size="sm"
                  onClick={() => void exportCsv()}
                />
              )}
            </div>
          )}
        </div>
      )}
      <div className="overflow-x-auto rounded-[var(--radius-panel)] border border-border-subtle bg-surface shadow-[var(--shadow-panel)]">
        <Table>
          <TableHead>
            <TableRow>
              {columns.map((column) => (
                <TableHeaderCell
                  key={column.key}
                  style={column.width ? { width: column.width } : undefined}
                  className={column.align === "end" ? "text-end" : "text-start"}
                  aria-sort={
                    sort?.key === column.key ? (sort.dir === "asc" ? "ascending" : "descending") : undefined
                  }
                >
                  {column.sortable !== false && column.value ? (
                    <button
                      className="inline-flex items-center gap-1 rounded-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                      onClick={() => toggleSort(column.key)}
                    >
                      {column.header}
                      {sort?.key === column.key ? (
                        sort.dir === "asc" ? (
                          <ArrowUp size={12} aria-hidden="true" />
                        ) : (
                          <ArrowDown size={12} aria-hidden="true" />
                        )
                      ) : (
                        <ArrowUpDown size={12} className="opacity-40" aria-hidden="true" />
                      )}
                    </button>
                  ) : (
                    column.header
                  )}
                </TableHeaderCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {visible.map((row) => (
              <TableRow
                key={rowKey(row)}
                onClick={
                  onRowClick
                    ? (event) => {
                        if (!isInteractiveTableTarget(event.target)) onRowClick(row);
                      }
                    : undefined
                }
                onKeyDown={
                  onRowClick
                    ? (event) => {
                        if (isInteractiveTableTarget(event.target)) return;
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          onRowClick(row);
                        }
                      }
                    : undefined
                }
                tabIndex={onRowClick ? 0 : undefined}
                className={cx(
                  onRowClick &&
                    "cursor-pointer hover:bg-brand-50/60 focus-visible:bg-brand-50/60 focus-visible:outline-none dark:hover:bg-slate-800/60 dark:focus-visible:bg-slate-800/60",
                )}
              >
                {columns.map((column) => (
                  <TableCell
                    key={column.key}
                    className={cx(
                      cellPadding,
                      column.align === "end" ? "text-end tnum" : "text-start",
                    )}
                  >
                    {column.render ? column.render(row) : (column.value?.(row) ?? "")}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {loading ? (
          <LoadingState label={t("common.loading")} />
        ) : (
          visible.length === 0 && <EmptyState message={emptyMessage ?? t("common.noResults")} />
        )}
      </div>
      {pages > 1 && (
        <div className="mt-2 flex items-center justify-between text-xs text-muted">
          <span>
            {filtered.length} {t("common.rows")}
          </span>
          <div className="flex items-center gap-2">
            <IconButton
              label={t("common.previousPage")}
              icon={PreviousIcon}
              size="sm"
              disabled={currentPage === 0}
              onClick={() => setPage(currentPage - 1)}
            />
            <span aria-live="polite">
              {t("common.page")} {currentPage + 1} {t("common.of")} {pages}
            </span>
            <IconButton
              label={t("common.nextPage")}
              icon={NextIcon}
              size="sm"
              disabled={currentPage >= pages - 1}
              onClick={() => setPage(currentPage + 1)}
            />
          </div>
        </div>
      )}
    </div>
  );
}
