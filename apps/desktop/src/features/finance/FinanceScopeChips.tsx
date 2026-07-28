import { X } from "lucide-react";

export interface FinanceScopeChip {
  key: string;
  label: string;
  onClear: () => void;
}

/** Active URL-driven filters (attention view, project scope) as clearable chips. */
export function FinanceScopeChips({
  chips,
  clearLabel,
}: {
  chips: FinanceScopeChip[];
  clearLabel: string;
}) {
  if (chips.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {chips.map((chip) => (
        <span
          key={chip.key}
          className="inline-flex items-center gap-1 rounded-full bg-brand-50 px-2.5 py-1 text-xs font-medium text-brand-700 dark:bg-brand-900/40 dark:text-brand-200"
        >
          {chip.label}
          <button
            type="button"
            aria-label={`${clearLabel}: ${chip.label}`}
            className="rounded-full p-0.5 hover:bg-brand-100 dark:hover:bg-brand-800/60"
            onClick={chip.onClear}
          >
            <X size={12} aria-hidden="true" />
          </button>
        </span>
      ))}
    </div>
  );
}
