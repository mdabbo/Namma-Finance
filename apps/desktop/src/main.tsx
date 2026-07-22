import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createHashRouter, RouterProvider } from "react-router-dom";
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
import { PeoplePage } from "./features/people/PeoplePage";
import { PersonDetailPage } from "./features/people/PersonDetailPage";
import { TimePage } from "./features/time/TimePage";
import { ReportsPage } from "./features/reports/ReportsPage";
import { SettingsPage } from "./features/settings/SettingsPage";
import { AuditPage } from "./features/audit/AuditPage";
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
      { index: true, element: <DashboardPage /> },
      { path: "clients", element: <ClientsPage /> },
      { path: "clients/:id", element: <ClientDetailPage /> },
      { path: "projects", element: <ProjectsPage /> },
      { path: "projects/:id", element: <ProjectDetailPage /> },
      { path: "certificates", element: <CertificatesPage /> },
      { path: "payments", element: <PaymentsPage /> },
      { path: "expenses", element: <ExpensesPage /> },
      { path: "people", element: <PeoplePage /> },
      { path: "people/:id", element: <PersonDetailPage /> },
      { path: "time", element: <TimePage /> },
      { path: "reports", element: <ReportsPage /> },
      { path: "audit", element: <AuditPage /> },
      { path: "settings", element: <SettingsPage /> },
    ],
  },
]);

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
