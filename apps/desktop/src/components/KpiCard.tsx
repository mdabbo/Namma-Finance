import type { LucideIcon } from "lucide-react";
import { Card, cx } from "./ui";

interface KpiCardProps {
  label: string;
  value: string;
  icon: LucideIcon;
  tone?: "default" | "positive" | "negative" | "warning";
  hint?: string;
}

const TONES = {
  default: "text-brand-600 bg-brand-50 dark:bg-brand-900/40 dark:text-brand-200",
  positive: "text-emerald-600 bg-emerald-50 dark:bg-emerald-900/40 dark:text-emerald-300",
  negative: "text-red-600 bg-red-50 dark:bg-red-900/40 dark:text-red-300",
  warning: "text-amber-600 bg-amber-50 dark:bg-amber-900/40 dark:text-amber-300",
};

export function KpiCard({ label, value, icon: Icon, tone = "default", hint }: KpiCardProps) {
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-xs font-medium text-slate-500 dark:text-slate-400">{label}</p>
          <p className="mt-1 truncate text-xl font-semibold tnum" title={value}>
            {value}
          </p>
          {hint && <p className="mt-0.5 text-xs text-slate-400">{hint}</p>}
        </div>
        <div className={cx("shrink-0 rounded-lg p-2", TONES[tone])}>
          <Icon size={18} />
        </div>
      </div>
    </Card>
  );
}
