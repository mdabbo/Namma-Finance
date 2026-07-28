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
  Search,
  Trash2,
} from "lucide-react";
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
  /** Storage key enabling named saved views (search + sort presets). */
  viewKey?: string;
}

export interface SavedTableView {
  name: string;
  search: string;
  sort: { key: string; dir: "asc" | "desc" } | null;
}

const VIEW_STORAGE_PREFIX = "mep.tableViews.";

function loadTableViews(viewKey: string): SavedTableView[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(`${VIEW_STORAGE_PREFIX}${viewKey}`) ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter((view): view is SavedTableView =>
          typeof (view as SavedTableView).name === "string" && typeof (view as SavedTableView).search === "string")
      : [];
  } catch {
    return [];
  }
}

function persistTableViews(viewKey: string, views: SavedTableView[]): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(`${VIEW_STORAGE_PREFIX}${viewKey}`, JSON.stringify(views));
}

const NUMERIC_CELL = /^-?\d+(\.\d+)?$/;

/**
 * Build a spreadsheet-safe CSV of every column with a plain value. Cells that
 * a spreadsheet would evaluate as a formula are prefixed with an apostrophe
 * (plain negative numbers stay untouched so amounts import correctly).
 */
export function buildCsv<T>(columns: Column<T>[], rows: T[]): string {
  const exportable = columns.filter((column) => column.value);
  const escape = (value: string | number | null | undefined) => {
    const raw = value === null || value === undefined ? "" : String(value);
    const guarded = /^[=+@\t\r]/.test(raw) || (raw.startsWith("-") && !NUMERIC_CELL.test(raw))
      ? `'${raw}`
      : raw;
    return /[",\n\r]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
  };
  const lines = [
    exportable.map((column) => escape(column.header)).join(","),
    ...rows.map((row) => exportable.map((column) => escape(column.value!(row))).join(",")),
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
}: DataTableProps<T>) {
  const { t, i18n } = useTranslation();
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<{ key: string; dir: "asc" | "desc" } | null>(initialSort ?? null);
  const [page, setPage] = useState(0);
  const [views, setViews] = useState<SavedTableView[]>(() => (viewKey ? loadTableViews(viewKey) : []));
  const [activeViewName, setActiveViewName] = useState("");
  const [namingView, setNamingView] = useState(false);
  const [viewName, setViewName] = useState("");

  function applyView(name: string) {
    setActiveViewName(name);
    const view = views.find((candidate) => candidate.name === name);
    if (!view) return;
    setSearch(view.search);
    setSort(view.sort);
    setPage(0);
  }

  function saveCurrentView() {
    const name = viewName.trim();
    if (!viewKey || !name) return;
    const next = [...views.filter((view) => view.name !== name), { name, search, sort }]
      .sort((left, right) => left.name.localeCompare(right.name));
    setViews(next);
    persistTableViews(viewKey, next);
    setActiveViewName(name);
    setNamingView(false);
    setViewName("");
  }

  function deleteActiveView() {
    if (!viewKey || !activeViewName) return;
    const next = views.filter((view) => view.name !== activeViewName);
    setViews(next);
    persistTableViews(viewKey, next);
    setActiveViewName("");
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
                  {namingView ? (
                    <Input
                      autoFocus
                      className="!w-36"
                      value={viewName}
                      placeholder={t("common.viewName")}
                      aria-label={t("common.viewName")}
                      onChange={(event) => setViewName(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") saveCurrentView();
                        if (event.key === "Escape") {
                          setNamingView(false);
                          setViewName("");
                        }
                      }}
                      onBlur={() => setNamingView(false)}
                    />
                  ) : (
                    <IconButton
                      label={t("common.saveView")}
                      icon={BookmarkPlus}
                      size="sm"
                      onClick={() => setNamingView(true)}
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
                </>
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
