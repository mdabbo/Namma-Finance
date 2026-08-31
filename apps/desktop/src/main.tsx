import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createHashRouter, Navigate, RouterProvider, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import "./styles.css";
import { initI18n } from "./lib/i18n";
import { applyTheme, loadSettings } from "./lib/settings";
import { isLockEnabled } from "./lib/lock";
import { LockScreen } from "./components/LockScreen";
import { finalizePendingBackupMetadata, runDailyBackupIfDue } from "./repositories/backups";
import { Layout } from "./app/Layout";
import { DashboardPage } from "./features/dashboard/DashboardPage";
import { ClientsPage } from "./features/clients/ClientsPage";
import { ClientDetailPage } from "./features/clients/ClientDetailPage";
import { ProjectsPage } from "./features/projects/ProjectsPage";
import { ProjectDetailPage } from "./features/projects/ProjectDetailPage";
import { CertificatesPage } from "./features/certificates/CertificatesPage";
import { PaymentsPage } from "./features/payments/PaymentsPage";
import { ExpensesPage } from "./features/expenses/ExpensesPage";
import { FinanceOverviewPage } from "./features/finance/FinanceOverviewPage";
import { ReceivablesPage } from "./features/finance/ReceivablesPage";
import { PeoplePage } from "./features/people/PeoplePage";
import { PersonDetailPage } from "./features/people/PersonDetailPage";
import { TimePage } from "./features/time/TimePage";
import { ReportsPage } from "./features/reports/ReportsPage";
import { CashflowView } from "./features/reports/CashflowView";
import { SettingsPage } from "./features/settings/SettingsPage";
import { finalizePendingRestoreAudit } from "./repositories/audit";
import { getRuntimeReleaseInfo } from "./lib/db";

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 5_000, retry: 1 } },
});

const router = createHashRouter([
  {
    path: "/",
    element: <Layout />,
    children: [
      { index: true, element: <Navigate to="/overview" replace /> },
      { path: "overview", element: <DashboardPage /> },

      { path: "projects", element: <ProjectsPage /> },
      { path: "projects/clients", element: <ClientsPage /> },
      { path: "projects/clients/:id", element: <ClientDetailPage /> },
      { path: "projects/:id", element: <ProjectDetailPage /> },

      { path: "finance", element: <FinanceOverviewPage /> },
      { path: "finance/certificates", element: <CertificatesPage /> },
      { path: "finance/payments", element: <PaymentsPage /> },
      { path: "finance/expenses", element: <ExpensesPage /> },
      { path: "finance/receivables", element: <ReceivablesPage /> },
      { path: "finance/cash-flow", element: <CashflowView /> },

      { path: "team", element: <Navigate to="/team/people" replace /> },
      { path: "team/people", element: <PeoplePage /> },
      { path: "team/people/:id", element: <PersonDetailPage /> },
      { path: "team/time", element: <TimePage /> },

      { path: "reports", element: <Navigate to="/reports/profitability" replace /> },
      { path: "reports/:view", element: <ReportsPage /> },
      { path: "settings", element: <Navigate to="/settings/general" replace /> },
      // Audit is a settings section like any other, so it renders inside
      // SettingsPage and keeps the single Settings navigator on screen.
      { path: "settings/:section", element: <SettingsPage /> },

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
    ],
  },
]);

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
  let language = "ar";
  let theme: "light" | "dark" = "light";
  let startupError: unknown = null;
  try {
    await getRuntimeReleaseInfo();
  } catch (error) {
    startupError = error;
    console.error("release compatibility preflight failed", error);
  }
  if (!startupError) {
    try {
      await finalizePendingRestoreAudit();
      await finalizePendingBackupMetadata();
      const settings = await loadSettings();
      language = settings.language;
      theme = settings.theme;
    } catch (err) {
      console.error("failed to load settings, using defaults", err);
    }
  }
  initI18n(language);
  applyTheme(theme);

  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <QueryClientProvider client={queryClient}>
        {startupError ? <StartupCompatibilityError error={startupError} /> : <Root />}
      </QueryClientProvider>
    </React.StrictMode>,
  );

  // fire-and-forget: once-per-day local backup
  if (!startupError) runDailyBackupIfDue().catch((err) => console.error("auto-backup failed", err));
}

void bootstrap();
