import { useTranslation } from "react-i18next";
import { Navigate, useParams } from "react-router-dom";
import { PageHeader } from "../../components/ui";
import { ProfitabilityView } from "./ProfitabilityView";
import { CostingView } from "./CostingView";
import { ReportsCenter } from "./ReportsCenter";

/**
 * Reports holds reporting only.
 *
 * The Import Wizard and Payment Integrity review were tabs here, which put
 * one-off technical operations beside the numbers the office reads every week;
 * they now live under Settings › Data Tools. Cash flow and receivables keep
 * their single home under Finance and are reached from the section navigation
 * rather than being rebuilt here, so each report has exactly one
 * implementation.
 *
 * The view is part of the URL so a report can be linked to and returned to.
 */
const VIEWS = {
  profitability: { titleKey: "reports.profitability", element: <ProfitabilityView /> },
  costing: { titleKey: "reports.costing", element: <CostingView /> },
  export: { titleKey: "reports.center", element: <ReportsCenter /> },
} as const;

export type ReportView = keyof typeof VIEWS;

export function ReportsPage() {
  const { t } = useTranslation();
  const { view } = useParams<{ view: string }>();

  if (!view) return <Navigate to="/reports/profitability" replace />;
  const active = VIEWS[view as ReportView];
  if (!active) return <Navigate to="/reports/profitability" replace />;

  return (
    <div>
      <PageHeader title={t(active.titleKey)} />
      {active.element}
    </div>
  );
}
