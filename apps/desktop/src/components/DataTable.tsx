import { useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight, Search } from "lucide-react";
import {
  EmptyState,
  IconButton,
  Input,
  LoadingState,
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
}: DataTableProps<T>) {
  const { t, i18n } = useTranslation();
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState(initialSort ?? null);
  const [page, setPage] = useState(0);

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

  return (
    <div>
      {(searchable || toolbar) && (
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
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                onKeyDown={
                  onRowClick
                    ? (event) => {
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
