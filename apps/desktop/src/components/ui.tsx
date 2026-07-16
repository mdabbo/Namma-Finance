import { forwardRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { X } from "lucide-react";

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }>(
  function Button({ className, variant = "secondary", ...props }, ref) {
    const styles: Record<ButtonVariant, string> = {
      primary: "bg-brand-600 text-white hover:bg-brand-700 disabled:bg-brand-300 shadow-sm",
      secondary:
        "bg-white text-slate-700 border border-slate-300 hover:bg-slate-50 dark:bg-slate-800 dark:text-slate-200 dark:border-slate-600 dark:hover:bg-slate-700",
      ghost: "text-slate-600 hover:bg-slate-200/60 dark:text-slate-300 dark:hover:bg-slate-700/60",
      danger: "bg-red-600 text-white hover:bg-red-700 shadow-sm",
    };
    return (
      <button
        ref={ref}
        className={cx(
          "inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-60 disabled:cursor-not-allowed",
          styles[variant],
          className,
        )}
        {...props}
      />
    );
  },
);

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      className={cx(
        "w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm outline-none transition-colors",
        "focus:border-brand-500 focus:ring-2 focus:ring-brand-100",
        "dark:border-slate-600 dark:bg-slate-800 dark:focus:ring-brand-900",
        className,
      )}
      {...props}
    />
  );
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className, ...props },
  ref,
) {
  return (
    <select
      ref={ref}
      className={cx(
        "w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm outline-none",
        "focus:border-brand-500 focus:ring-2 focus:ring-brand-100",
        "dark:border-slate-600 dark:bg-slate-800 dark:focus:ring-brand-900",
        className,
      )}
      {...props}
    />
  );
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea(
  { className, ...props },
  ref,
) {
  return (
    <textarea
      ref={ref}
      rows={3}
      className={cx(
        "w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm outline-none",
        "focus:border-brand-500 focus:ring-2 focus:ring-brand-100",
        "dark:border-slate-600 dark:bg-slate-800 dark:focus:ring-brand-900",
        className,
      )}
      {...props}
    />
  );
});

export function Field({ label, error, children, className }: { label: string; error?: string | undefined; children: ReactNode; className?: string }) {
  return (
    <label className={cx("block", className)}>
      <span className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400">{label}</span>
      {children}
      {error && <span className="mt-1 block text-xs text-red-600">{error}</span>}
    </label>
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cx("rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900", className)}>
      {children}
    </div>
  );
}

const BADGE_STYLES: Record<string, string> = {
  ACTIVE: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300",
  COMPLETED: "bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300",
  ON_HOLD: "bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300",
  CANCELLED: "bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300",
  DRAFT: "bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300",
  SUBMITTED: "bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300",
  APPROVED: "bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300",
  PAID: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300",
  OVERDUE: "bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300",
};

export function Badge({ value, label }: { value: string; label: string }) {
  return (
    <span className={cx("inline-flex rounded-full px-2 py-0.5 text-xs font-medium", BADGE_STYLES[value] ?? BADGE_STYLES.DRAFT)}>
      {label}
    </span>
  );
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-6 backdrop-blur-sm" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={cx("mt-4 w-full rounded-2xl bg-white p-6 shadow-2xl dark:bg-slate-900", wide ? "max-w-4xl" : "max-w-xl")}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{title}</h2>
          <Button variant="ghost" onClick={onClose} aria-label="close" className="!p-1.5">
            <X size={18} />
          </Button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function EmptyState({ message }: { message: string }) {
  return <div className="py-12 text-center text-sm text-slate-400">{message}</div>;
}

/** Progress bar used for collection %, certified %, etc. */
export function RatioBar({ ratioBp, secondaryBp, className }: { ratioBp: number; secondaryBp?: number; className?: string }) {
  const pct = Math.min(100, Math.max(0, ratioBp / 100));
  const pct2 = secondaryBp === undefined ? null : Math.min(100, Math.max(0, secondaryBp / 100));
  return (
    <div className={cx("relative h-2 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700", className)}>
      {pct2 !== null && <div className="absolute inset-y-0 start-0 rounded-full bg-brand-200 dark:bg-brand-900" style={{ width: `${pct2}%` }} />}
      <div className="absolute inset-y-0 start-0 rounded-full bg-brand-600" style={{ width: `${pct}%` }} />
    </div>
  );
}
