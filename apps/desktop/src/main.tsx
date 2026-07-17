import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createHashRouter, RouterProvider } from "react-router-dom";
import "./styles.css";
import { initI18n } from "./lib/i18n";
import { applyTheme, loadSettings } from "./lib/settings";
import { runDailyBackupIfDue } from "./repositories/backups";
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
import { ReportsPage } from "./features/reports/ReportsPage";
import { SettingsPage } from "./features/settings/SettingsPage";

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
      { path: "reports", element: <ReportsPage /> },
      { path: "settings", element: <SettingsPage /> },
    ],
  },
]);

async function bootstrap() {
  let language = "ar";
  let theme: "light" | "dark" = "light";
  try {
    const settings = await loadSettings();
    language = settings.language;
    theme = settings.theme;
  } catch (err) {
    console.error("failed to load settings, using defaults", err);
  }
  initI18n(language);
  applyTheme(theme);

  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </React.StrictMode>,
  );

  // fire-and-forget: once-per-day local backup
  runDailyBackupIfDue().catch((err) => console.error("auto-backup failed", err));

  // heal certificates marked PAID before payments were enforced: create their
  // backing payment records so "collected" matches reality (idempotent).
  // Repeats every 10 minutes so a gap left by a failed save-time backfill
  // closes without waiting for the next app start.
  void import("./repositories/backfill").then(({ runPaidBackfill }) => {
    void runPaidBackfill(queryClient);
    setInterval(() => void runPaidBackfill(queryClient), 10 * 60_000);
  });
}

void bootstrap();
