import React, { useEffect, useState, type ComponentType } from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createHashRouter, Navigate, RouterProvider, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import "./fonts";
import "./styles.css";
import { initI18n } from "./lib/i18n";
import { applyTheme, loadSettings } from "./lib/settings";
import { isLockEnabled } from "./lib/lock";
import { LockScreen } from "./components/LockScreen";
import { finalizePendingBackupMetadata, runDailyBackupIfDue } from "./repositories/backups";
import { Layout } from "./app/Layout";
import { finalizePendingRestoreAudit } from "./repositories/audit";
import { getRuntimeReleaseInfo } from "./lib/db";
import { ErrorBoundary, RouteErrorElement } from "./components/ErrorBoundary";
import { installGlobalErrorLogging, logError } from "./lib/logger";

/**
 * Route pages load on demand (plan step C4), so the first paint ships the shell
 * — layout, lock screen, error screens — instead of every feature. React Router
 * resolves `lazy` BEFORE it commits the navigation: the previous page stays
 * on screen until the next chunk has arrived, so there is no loading flash.
 *
 * The lock screen, the layout, the error boundary and the startup-compatibility
 * screen are deliberately NOT lazy: they must render when nothing else can load.
 */
function page<K extends string>(load: () => Promise<Record<K, ComponentType>>, name: K) {
  return async () => ({ Component: (await load())[name] });
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 5_000, retry: 1 } },
});

const router = createHashRouter([
  {
    path: "/",
    element: <Layout />,
    // Errors in the layout itself (sidebar, header) fall back to a full-window screen.
    errorElement: <RouteErrorElement variant="app" />,
    // Shown only while the first page chunk loads; blank rather than a flash of unstyled UI.
    HydrateFallback: () => null,
    children: [
      {
        // Pathless wrapper: a page that throws renders the fallback inside the
        // layout's <Outlet />, so the sidebar and navigation keep working.
        errorElement: <RouteErrorElement />,
        children: [
      { index: true, element: <Navigate to="/overview" replace /> },
      { path: "overview", lazy: page(() => import("./features/dashboard/DashboardPage"), "DashboardPage") },

      { path: "projects", lazy: page(() => import("./features/projects/ProjectsPage"), "ProjectsPage") },
      { path: "projects/clients", lazy: page(() => import("./features/clients/ClientsPage"), "ClientsPage") },
      { path: "projects/clients/:id", lazy: page(() => import("./features/clients/ClientDetailPage"), "ClientDetailPage") },
      { path: "projects/:id", lazy: page(() => import("./features/projects/ProjectDetailPage"), "ProjectDetailPage") },

      { path: "finance", lazy: page(() => import("./features/finance/FinanceOverviewPage"), "FinanceOverviewPage") },
      { path: "finance/certificates", lazy: page(() => import("./features/certificates/CertificatesPage"), "CertificatesPage") },
      { path: "finance/payments", lazy: page(() => import("./features/payments/PaymentsPage"), "PaymentsPage") },
      { path: "finance/expenses", lazy: page(() => import("./features/expenses/ExpensesPage"), "ExpensesPage") },
      { path: "finance/claims", lazy: page(() => import("./features/expenses/ExpenseClaimsPage"), "ExpenseClaimsPage") },
      { path: "finance/receivables", lazy: page(() => import("./features/finance/ReceivablesPage"), "ReceivablesPage") },
      { path: "finance/cash-flow", lazy: page(() => import("./features/reports/CashflowView"), "CashflowView") },

      { path: "team", element: <Navigate to="/team/people" replace /> },
      { path: "team/people", lazy: page(() => import("./features/people/PeoplePage"), "PeoplePage") },
      { path: "team/people/:id", lazy: page(() => import("./features/people/PersonDetailPage"), "PersonDetailPage") },
      { path: "team/time", lazy: page(() => import("./features/time/TimePage"), "TimePage") },

      { path: "reports", element: <Navigate to="/reports/profitability" replace /> },
      { path: "reports/:view", lazy: page(() => import("./features/reports/ReportsPage"), "ReportsPage") },
      { path: "settings", element: <Navigate to="/settings/general" replace /> },
      // Audit is a settings section like any other, so it renders inside
      // SettingsPage and keeps the single Settings navigator on screen.
      { path: "settings/:section", lazy: page(() => import("./features/settings/SettingsPage"), "SettingsPage") },

      // Milestone 1 compatibility: preserve every pre-redesign route.
      { path: "clients", element: <Navigate to="/projects/clients" replace /> },
      { path: "clients/:id", element: <LegacyDetailRedirect base="/projects/clients" /> },
      { path: "certificates", element: <Navigate to="/finance/certificates" replace /> },
      { path: "payments", element: <Navigate to="/finance/payments" replace /> },
      { path: "expenses", element: <Navigate to="/finance/expenses" replace /> },
      { path: "people", element: <Navigate to="/team/people" replace /> },
      { path: "people/:id", element: <LegacyDetailRedirect base="/team/people" /> },
      { path: "time", element: <Navigate to="/team/time" replace /> },
      { path: "audit", element: <Navigate to="/settings/audit" replace /> },

      // E2E only (vite serve --mode e2e): a page that throws on render, to prove
      // the error fallback keeps the sidebar alive. Absent from production builds.
      ...(import.meta.env.MODE === "e2e" ? [{ path: "__crash", element: <CrashForTest /> }] : []),
        ],
      },
    ],
  },
]);

function CrashForTest(): never {
  throw new Error("E2E forced render error");
}

function LegacyDetailRedirect({ base }: { base: string }) {
  const { id } = useParams();
  return <Navigate to={`${base}/${id ?? ""}`} replace />;
}

/** Launch gate: the router only mounts once the app lock (if set) is passed. */
function Root() {
  const [locked, setLocked] = useState<boolean | null>(null);
  useEffect(() => {
    // Fail closed: a missing/corrupt credential or database error must never
    // silently expose financial data.
    void isLockEnabled().then(setLocked).catch(() => setLocked(true));
  }, []);
  if (locked === null) return null;
  if (locked) return <LockScreen onUnlock={() => setLocked(false)} />;
  return <RouterProvider router={router} />;
}

function StartupCompatibilityError({ error }: { error: unknown }) {
  const { t } = useTranslation();
  const raw = error instanceof Error ? error.message : String(error);
  const detail = /^(SCHEMA_VERSION_|APPLICATION_VERSION_|RUNTIME_RELEASE_)/.test(raw)
    ? raw.slice(0, 240)
    : "RELEASE_PREFLIGHT_FAILED";
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 p-6 dark:bg-slate-950">
      <section className="w-full max-w-xl rounded-2xl border border-red-200 bg-white p-6 shadow-sm dark:border-red-900 dark:bg-slate-900">
        <h1 className="text-lg font-semibold text-red-700 dark:text-red-300">{t("settings.startupBlockedTitle")}</h1>
        <p className="mt-3 text-sm text-slate-600 dark:text-slate-300">{t("settings.startupBlockedHint")}</p>
        <p className="mt-4 rounded-lg bg-red-50 p-3 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-300" dir="ltr">
          {t("settings.startupBlockedCode")}: {detail}
        </p>
      </section>
    </main>
  );
}

async function bootstrap() {
  installGlobalErrorLogging();
  let language = "ar";
  let theme: "light" | "dark" = "light";
  let startupError: unknown = null;
  try {
    await getRuntimeReleaseInfo();
  } catch (error) {
    startupError = error;
    logError("release compatibility preflight failed", error);
  }
  if (!startupError) {
    try {
      await finalizePendingRestoreAudit();
      await finalizePendingBackupMetadata();
      const settings = await loadSettings();
      language = settings.language;
      theme = settings.theme;
    } catch (err) {
      logError("failed to load settings, using defaults", err);
    }
  }
  initI18n(language);
  applyTheme(theme);

  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <ErrorBoundary>
        <QueryClientProvider client={queryClient}>
          {startupError ? <StartupCompatibilityError error={startupError} /> : <Root />}
        </QueryClientProvider>
      </ErrorBoundary>
    </React.StrictMode>,
  );

  // fire-and-forget: once-per-day local backup
  if (!startupError) runDailyBackupIfDue().catch((err) => logError("auto-backup failed", err));
}

void bootstrap();
