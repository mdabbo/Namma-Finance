import { Component, useState, type ErrorInfo, type ReactNode } from "react";
import { useRouteError } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Copy, RefreshCw } from "lucide-react";
import { describeError, logError } from "../lib/logger";
import { Button } from "./ui";

/** Replaces ids in a hash route so the route can be shown/copied: `/projects/:id`. */
export function routePattern(hashOrPath: string): string {
  const path = hashOrPath.replace(/^#/, "").split("?")[0] || "/";
  return path
    .split("/")
    .map((seg) => (/^[0-9a-f]{8}-[0-9a-f-]{20,}$/i.test(seg) || /^\d+$/.test(seg) ? ":id" : seg))
    .join("/");
}

/**
 * The text behind "Copy details". Error type, scrubbed message, a route
 * pattern and the component names — never record values.
 */
export function buildErrorDetails(error: unknown, route: string, componentStack?: string | null): string {
  const components = (componentStack ?? "")
    .split("\n")
    .map((line) => line.trim().match(/^at ([A-Za-z0-9_$]+)/)?.[1])
    .filter((name): name is string => Boolean(name))
    .slice(0, 8);
  return [
    `time: ${new Date().toISOString()}`,
    `route: ${routePattern(route)}`,
    `error: ${describeError(error)}`,
    components.length ? `components: ${components.join(" > ")}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

interface FallbackProps {
  error: unknown;
  componentStack?: string | null;
  /** "app" fills the window; "page" sits inside the layout so navigation survives. */
  variant?: "app" | "page";
}

export function ErrorFallback({ error, componentStack, variant = "page" }: FallbackProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const route = typeof window !== "undefined" ? window.location.hash : "/";
  const details = buildErrorDetails(error, route, componentStack);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(details);
      setCopied(true);
    } catch (err) {
      logError("copy error details failed", err);
    }
  };

  return (
    <div
      role="alert"
      data-testid="error-fallback"
      className={variant === "app" ? "flex min-h-screen items-center justify-center bg-slate-50 p-6 dark:bg-slate-950" : "p-6"}
    >
      <section className="w-full max-w-xl rounded-2xl border border-red-200 bg-white p-6 shadow-sm dark:border-red-900 dark:bg-slate-900">
        <h1 className="flex items-center gap-2 text-lg font-semibold text-red-700 dark:text-red-300">
          <AlertTriangle size={18} aria-hidden />
          {t("errorBoundary.title")}
        </h1>
        <p className="mt-3 text-sm text-slate-600 dark:text-slate-300">{t("errorBoundary.hint")}</p>
        <p className="mt-4 text-xs font-medium text-slate-500">
          {t("errorBoundary.details")} — {t("errorBoundary.detailsNote")}
        </p>
        <pre
          dir="ltr"
          className="mt-1 whitespace-pre-wrap break-words rounded-lg bg-red-50 p-3 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-300"
        >
          {details}
        </pre>
        <div className="mt-4 flex gap-2">
          <Button variant="primary" onClick={() => window.location.reload()}>
            <RefreshCw size={14} />
            {t("errorBoundary.reload")}
          </Button>
          <Button onClick={() => void copy()}>
            <Copy size={14} />
            {copied ? t("errorBoundary.copied") : t("errorBoundary.copyDetails")}
          </Button>
        </div>
      </section>
    </div>
  );
}

interface BoundaryState {
  error: unknown;
  hasError: boolean;
  componentStack: string | null;
}

/** Catches render errors below it. Wrap the whole app in one. */
export class ErrorBoundary extends Component<{ children: ReactNode }, BoundaryState> {
  state: BoundaryState = { error: null, hasError: false, componentStack: null };

  static getDerivedStateFromError(error: unknown): Partial<BoundaryState> {
    return { error, hasError: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    this.setState({ componentStack: info.componentStack ?? null });
    logError("render error", error);
  }

  render() {
    if (this.state.hasError) {
      return <ErrorFallback error={this.state.error} componentStack={this.state.componentStack} variant="app" />;
    }
    return this.props.children;
  }
}

/** React Router `errorElement`: renders inside the layout, so the sidebar keeps working. */
export function RouteErrorElement({ variant = "page" }: { variant?: "app" | "page" }) {
  const error = useRouteError();
  logRouteErrorOnce(error);
  return <ErrorFallback error={error} variant={variant} />;
}

const seen = new WeakSet<object>();
function logRouteErrorOnce(error: unknown) {
  if (typeof error === "object" && error !== null) {
    if (seen.has(error)) return;
    seen.add(error);
  }
  logError("route error", error);
}
