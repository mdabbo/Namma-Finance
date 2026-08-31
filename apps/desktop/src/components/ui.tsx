import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TableHTMLAttributes,
  type TdHTMLAttributes,
  type TextareaHTMLAttributes,
  type ThHTMLAttributes,
} from "react";
import { AlertCircle, Inbox, LoaderCircle, X, type LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface";
const controlBase =
  "w-full rounded-[var(--radius-control)] border border-border-strong bg-surface px-3 text-sm text-foreground shadow-none outline-none transition-[border-color,box-shadow,background-color] placeholder:text-slate-400 disabled:cursor-not-allowed disabled:bg-surface-subtle disabled:text-muted disabled:opacity-70";
const controlState =
  "hover:border-slate-400 focus:border-brand-500 focus:ring-2 focus:ring-brand-100 aria-[invalid=true]:border-red-500 aria-[invalid=true]:ring-red-100 dark:hover:border-slate-500 dark:focus:ring-brand-900 dark:aria-[invalid=true]:ring-red-950";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md" | "lg";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-brand-600 text-white shadow-sm hover:bg-brand-700 active:bg-brand-800 disabled:bg-brand-300",
  secondary:
    "border border-border-strong bg-surface text-slate-700 hover:bg-surface-subtle active:bg-slate-100 dark:text-slate-200 dark:active:bg-slate-700",
  ghost: "text-slate-600 hover:bg-slate-200/60 active:bg-slate-200 dark:text-slate-300 dark:hover:bg-slate-700/60",
  danger: "bg-red-600 text-white shadow-sm hover:bg-red-700 active:bg-red-800 disabled:bg-red-300",
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: "min-h-8 px-2.5 py-1 text-xs",
  md: "min-h-9 px-3 py-1.5 text-sm",
  lg: "min-h-10 px-4 py-2 text-sm",
};

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize }
>(function Button({ className, variant = "secondary", size = "md", type = "button", ...props }, ref) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx(
        "inline-flex items-center justify-center gap-1.5 rounded-[var(--radius-control)] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60",
        focusRing,
        BUTTON_VARIANTS[variant],
        BUTTON_SIZES[size],
        className,
      )}
      {...props}
    />
  );
});

export const IconButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & {
    label: string;
    icon: LucideIcon;
    variant?: ButtonVariant;
    size?: ButtonSize;
  }
>(function IconButton({ label, icon: Icon, variant = "ghost", size = "md", className, ...props }, ref) {
  return (
    <Button
      ref={ref}
      variant={variant}
      size={size}
      aria-label={label}
      title={props.title ?? label}
      className={cx("aspect-square !px-0", className)}
      {...props}
    >
      <Icon size={size === "sm" ? 15 : 17} aria-hidden="true" />
    </Button>
  );
});

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, "aria-invalid": ariaInvalid, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      aria-invalid={ariaInvalid}
      className={cx(controlBase, controlState, "min-h-9 py-1.5", className)}
      {...props}
    />
  );
});

export const DateInput = forwardRef<HTMLInputElement, Omit<InputHTMLAttributes<HTMLInputElement>, "type">>(
  function DateInput({ className, ...props }, ref) {
    return <Input ref={ref} type="date" className={cx("tnum", className)} {...props} />;
  },
);

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className, "aria-invalid": ariaInvalid, ...props },
  ref,
) {
  return (
    <select
      ref={ref}
      aria-invalid={ariaInvalid}
      className={cx(controlBase, controlState, "min-h-9 py-1.5", className)}
      {...props}
    />
  );
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, rows = 3, "aria-invalid": ariaInvalid, ...props }, ref) {
    return (
      <textarea
        ref={ref}
        rows={rows}
        aria-invalid={ariaInvalid}
        className={cx(controlBase, controlState, "min-h-20 resize-y py-2", className)}
        {...props}
      />
    );
  },
);

export function Field({
  label,
  error,
  hint,
  children,
  className,
}: {
  label: string;
  error?: string | undefined;
  hint?: string | undefined;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cx("block", className)}>
      <span className="mb-1.5 block text-xs font-medium text-slate-600 dark:text-slate-300">{label}</span>
      {children}
      {hint && !error && <span className="mt-1.5 block text-xs text-muted">{hint}</span>}
      {error && (
        <span className="mt-1.5 block text-xs font-medium text-red-600 dark:text-red-400" role="alert">
          {error}
        </span>
      )}
    </label>
  );
}

export function Card({
  children,
  className,
  variant = "default",
}: {
  children: ReactNode;
  className?: string;
  variant?: "default" | "summary" | "subtle";
}) {
  return (
    <div
      className={cx(
        "rounded-[var(--radius-panel)] bg-surface",
        variant === "default" && "border border-border-subtle shadow-[var(--shadow-panel)]",
        variant === "summary" && "border border-border-subtle shadow-[var(--shadow-panel)]",
        variant === "subtle" && "bg-surface-subtle",
        className,
      )}
    >
      {children}
    </div>
  );
}

type BadgeTone = "neutral" | "info" | "success" | "warning" | "danger";

const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: "bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-200",
  info: "bg-blue-50 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300",
  success: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
  warning: "bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300",
  danger: "bg-red-50 text-red-700 dark:bg-red-950/60 dark:text-red-300",
};

const STATUS_TONES: Record<string, BadgeTone> = {
  ACTIVE: "success",
  COMPLETED: "info",
  ON_HOLD: "warning",
  CANCELLED: "neutral",
  DRAFT: "neutral",
  SUBMITTED: "warning",
  APPROVED: "info",
  PAID: "success",
  OVERDUE: "danger",
};

export function Badge({ value, label, tone }: { value?: string; label: string; tone?: BadgeTone }) {
  const resolvedTone = tone ?? STATUS_TONES[value ?? ""] ?? "neutral";
  return (
    <span className={cx("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium", BADGE_TONES[resolvedTone])}>
      {label}
    </span>
  );
}

export function Alert({
  title,
  children,
  tone = "info",
  className,
}: {
  title?: string;
  children: ReactNode;
  tone?: Exclude<BadgeTone, "neutral">;
  className?: string;
}) {
  const styles = {
    info: "border-blue-200 bg-blue-50 text-blue-900 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-200",
    success:
      "border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200",
    warning:
      "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200",
    danger: "border-red-200 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200",
  };
  return (
    <div className={cx("rounded-[var(--radius-control)] border px-3 py-2.5 text-sm", styles[tone], className)} role={tone === "danger" ? "alert" : "status"}>
      {title && <p className="mb-0.5 font-semibold">{title}</p>}
      <div className="text-xs leading-5 opacity-90">{children}</div>
    </div>
  );
}

function useOverlay(onClose: () => void) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const panel = panelRef.current;
    const firstFocusable = panel?.querySelector<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
    );
    (firstFocusable ?? panel)?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !panel) return;
      const focusable = Array.from(
        panel.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (focusable.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      previousFocusRef.current?.focus();
    };
  }, []);

  return panelRef;
}

export function Modal({
  title,
  onClose,
  children,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const { t } = useTranslation();
  const titleId = useId();
  const panelRef = useOverlay(onClose);
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-950/45 p-6 backdrop-blur-[2px]"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cx(
          "mt-4 w-full rounded-[var(--radius-overlay)] border border-border-subtle bg-surface p-6 shadow-[var(--shadow-overlay)] outline-none",
          wide ? "max-w-4xl" : "max-w-xl",
        )}
      >
        <div className="mb-5 flex items-center justify-between gap-4">
          <h2 id={titleId} className="text-lg font-semibold tracking-tight">
            {title}
          </h2>
          <IconButton label={t("common.close")} icon={X} size="sm" onClick={onClose} />
        </div>
        {children}
      </div>
    </div>
  );
}

export function Drawer({
  title,
  onClose,
  children,
  footer,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const { t } = useTranslation();
  const titleId = useId();
  const panelRef = useOverlay(onClose);
  return (
    <div
      className="fixed inset-0 z-50 bg-slate-950/45 backdrop-blur-[2px]"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="absolute inset-y-0 end-0 flex w-full max-w-lg flex-col border-s border-border-subtle bg-surface shadow-[var(--shadow-overlay)] outline-none"
      >
        <div className="flex min-h-16 items-center justify-between gap-4 border-b border-border-subtle px-5">
          <h2 id={titleId} className="text-lg font-semibold tracking-tight">
            {title}
          </h2>
          <IconButton label={t("common.close")} icon={X} size="sm" onClick={onClose} />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-5">{children}</div>
        {footer && <div className="border-t border-border-subtle p-4">{footer}</div>}
      </div>
    </div>
  );
}

export function EmptyState({
  message,
  title,
  description,
  icon: Icon = Inbox,
  action,
  className,
}: {
  message?: string;
  title?: string;
  description?: string;
  icon?: LucideIcon;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("flex flex-col items-center justify-center px-6 py-12 text-center", className)}>
      <div className="mb-3 rounded-full bg-surface-subtle p-3 text-slate-400">
        <Icon size={20} aria-hidden="true" />
      </div>
      <p className="text-sm font-medium text-slate-700 dark:text-slate-200">{title ?? message}</p>
      {description && <p className="mt-1 max-w-md text-xs leading-5 text-muted">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function LoadingState({ label, className }: { label: string; className?: string }) {
  return (
    <div className={cx("flex min-h-32 items-center justify-center gap-2 text-sm text-muted", className)} role="status" aria-live="polite">
      <LoaderCircle size={17} className="motion-safe:animate-spin" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function ErrorState({
  title,
  description,
  action,
  className,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("flex min-h-32 flex-col items-center justify-center px-6 text-center", className)} role="alert">
      <AlertCircle size={22} className="mb-2 text-red-500" aria-hidden="true" />
      <p className="text-sm font-semibold text-red-700 dark:text-red-300">{title}</p>
      {description && <p className="mt-1 max-w-md text-xs leading-5 text-muted">{description}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
  meta,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  meta?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cx("mb-5 flex min-h-10 flex-wrap items-start justify-between gap-3", className)}>
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h1 className="heading-page truncate">{title}</h1>
          {meta}
        </div>
        {description && <div className="mt-1 text-supporting">{description}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

export function SectionHeader({
  title,
  description,
  actions,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("mb-3 flex flex-wrap items-start justify-between gap-2", className)}>
      <div>
        <h2 className="heading-section">{title}</h2>
        {description && <div className="mt-0.5 text-xs text-muted">{description}</div>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export const Table = forwardRef<HTMLTableElement, TableHTMLAttributes<HTMLTableElement>>(function Table(
  { className, ...props },
  ref,
) {
  return <table ref={ref} className={cx("w-full border-separate border-spacing-0 text-sm", className)} {...props} />;
});

export function TableHead({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className={cx("bg-surface-subtle text-xs font-medium text-muted", className)} {...props} />;
}

export function TableBody({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={cx("divide-y divide-border-subtle", className)} {...props} />;
}

export function TableRow({ className, ...props }: HTMLAttributes<HTMLTableRowElement>) {
  return <tr className={cx("transition-colors", className)} {...props} />;
}

export function TableHeaderCell({ className, ...props }: ThHTMLAttributes<HTMLTableCellElement>) {
  return <th className={cx("border-b border-border-subtle px-3 py-2.5 text-start font-medium", className)} {...props} />;
}

export function TableCell({ className, ...props }: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cx("px-3 py-2.5 align-middle", className)} {...props} />;
}

/** Progress bar used for collection %, certified %, etc. */
export function RatioBar({
  ratioBp,
  secondaryBp,
  className,
}: {
  ratioBp: number;
  secondaryBp?: number;
  className?: string;
}) {
  const pct = Math.min(100, Math.max(0, ratioBp / 100));
  const pct2 = secondaryBp === undefined ? null : Math.min(100, Math.max(0, secondaryBp / 100));
  return (
    <div
      className={cx("relative h-2 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700", className)}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct)}
    >
      {pct2 !== null && (
        <div
          className="absolute inset-y-0 start-0 rounded-full bg-brand-200 dark:bg-brand-900"
          style={{ width: `${pct2}%` }}
        />
      )}
      <div className="absolute inset-y-0 start-0 rounded-full bg-brand-600" style={{ width: `${pct}%` }} />
    </div>
  );
}
