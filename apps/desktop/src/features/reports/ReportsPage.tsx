import { useState } from "react";
import { useTranslation } from "react-i18next";
import { cx } from "../../components/ui";
import { CashflowView } from "./CashflowView";
import { ProfitabilityView } from "./ProfitabilityView";
import { CostingView } from "./CostingView";
import { ReportsCenter } from "./ReportsCenter";
import { ImportWizard } from "./ImportWizard";

type Tab = "cashflow" | "profitability" | "costing" | "center" | "import";

export function ReportsPage() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>("cashflow");

  const TABS: { key: Tab; label: string }[] = [
    { key: "cashflow", label: t("reports.cashflow") },
    { key: "profitability", label: t("reports.profitability") },
    { key: "costing", label: t("reports.costing") },
    { key: "center", label: t("reports.center") },
    { key: "import", label: t("importer.title") },
  ];

  return (
    <div>
      <h1 className="mb-4 text-xl font-semibold">{t("reports.title")}</h1>
      <div className="mb-4 flex gap-1 border-b border-slate-200 dark:border-slate-800">
        {TABS.map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={cx(
              "border-b-2 px-3 py-2 text-sm font-medium transition-colors",
              tab === key
                ? "border-brand-600 text-brand-700 dark:text-brand-300"
                : "border-transparent text-slate-500 hover:text-slate-700 dark:hover:text-slate-300",
            )}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "cashflow" && <CashflowView />}
      {tab === "profitability" && <ProfitabilityView />}
      {tab === "costing" && <CostingView />}
      {tab === "center" && <ReportsCenter />}
      {tab === "import" && <ImportWizard />}
    </div>
  );
}
