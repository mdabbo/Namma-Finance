import { useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ArrowDown, ArrowUp, ArrowUpDown, Search } from "lucide-react";
import { EmptyState, Input, cx } from "./ui";

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
}: DataTableProps<T>) {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState(initialSort ?? null);
  const [page, setPage] = useState(0);

  const filtered = useMemo(() => {
    let result = rows;
    const q = search.trim().toLowerCase();
    if (q) {
      result = rows.filter((row) =>
        columns.some((col) => {
          const v = col.value?.(row);
          return v !== null && v !== undefined && String(v).toLowerCase().includes(q);
        }),
      );
    }
    if (sort) {
      const col = columns.find((c) => c.key === sort.key);
      if (col?.value) {
        const dir = sort.dir === "asc" ? 1 : -1;
        result = [...result].sort((a, b) => {
          const va = col.value!(a);
          const vb = col.value!(b);
          if (va === null || va === undefined) return 1;
          if (vb === null || vb === undefined) return -1;
          if (typeof va === "number" && typeof vb === "number") return (va - vb) * dir;
          return String(va).localeCompare(String(vb)) * dir;
        });
      }
    }
    return result;
  }, [rows, columns, search, sort]);

  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, pages - 1);
  const visible = filtered.slice(currentPage * pageSize, (currentPage + 1) * pageSize);

  function toggleSort(key: string) {
    setSort((s) => (s?.key === key ? (s.dir === "asc" ? { key, dir: "desc" } : null) : { key, dir: "asc" }));
  }

  return (
    <div>
      {(searchable || toolbar) && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {searchable && (
            <div className="relative w-64">
              <Search size={15} className="pointer-events-none absolute start-2.5 top-2 text-slate-400" />
              <Input
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
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
      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800 dark:bg-slate-800/60 dark:text-slate-400">
              {columns.map((col) => (
                <th
                  key={col.key}
                  style={col.width ? { width: col.width } : undefined}
                  className={cx("px-3 py-2.5 font-medium", col.align === "end" ? "text-end" : "text-start")}
                >
                  {col.sortable !== false && col.value ? (
                    <button className="inline-flex items-center gap-1 hover:text-slate-800 dark:hover:text-slate-200" onClick={() => toggleSort(col.key)}>
                      {col.header}
                      {sort?.key === col.key ? (sort.dir === "asc" ? <ArrowUp size={12} /> : <ArrowDown size={12} />) : <ArrowUpDown size={12} className="opacity-40" />}
                    </button>
                  ) : (
                    col.header
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => (
              <tr
                key={rowKey(row)}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                className={cx(
                  "border-b border-slate-100 last:border-0 dark:border-slate-800",
                  onRowClick && "cursor-pointer hover:bg-brand-50/60 dark:hover:bg-slate-800/60",
                )}
              >
                {columns.map((col) => (
                  <td key={col.key} className={cx("px-3 py-2.5", col.align === "end" ? "text-end" : "text-start")}>
                    {col.render ? col.render(row) : (col.value?.(row) ?? "")}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {visible.length === 0 && <EmptyState message={emptyMessage ?? t("common.noResults")} />}
      </div>
      {pages > 1 && (
        <div className="mt-2 flex items-center justify-between text-xs text-slate-500">
          <span>
            {filtered.length} {t("common.rows")}
          </span>
          <div className="flex items-center gap-2">
            <button className="rounded px-2 py-1 hover:bg-slate-200 disabled:opacity-40 dark:hover:bg-slate-700" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>
              ‹
            </button>
            <span>
              {t("common.page")} {currentPage + 1} {t("common.of")} {pages}
            </span>
            <button className="rounded px-2 py-1 hover:bg-slate-200 disabled:opacity-40 dark:hover:bg-slate-700" disabled={currentPage >= pages - 1} onClick={() => setPage(currentPage + 1)}>
              ›
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
