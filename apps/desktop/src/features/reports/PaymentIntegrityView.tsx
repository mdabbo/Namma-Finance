import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Card } from "../../components/ui";
import { useFormat } from "../../lib/format";
import { listLegacyDuplicateAllocations, listSuspectedSyntheticPayments } from "../../repositories/paymentIntegrity";

export function PaymentIntegrityView() {
  const { t } = useTranslation();
  const fmt = useFormat();
  const { data: rows = [] } = useQuery({ queryKey: ["payment-integrity"], queryFn: listSuspectedSyntheticPayments });
  const { data: duplicates = [] } = useQuery({ queryKey: ["allocation-integrity"], queryFn: listLegacyDuplicateAllocations });
  return (
    <Card className="p-4">
      <h2 className="font-semibold">{t("reports.paymentIntegrity")}</h2>
      <p className="mb-4 mt-1 text-xs text-slate-500">{t("reports.paymentIntegrityNote")}</p>
      <table className="w-full text-sm">
        <thead><tr>
          <th>{t("projects.single")}</th><th>{t("certificates.number")}</th>
          <th>{t("payments.number")}</th><th>{t("common.date")}</th><th className="text-end">{t("common.amount")}</th>
        </tr></thead>
        <tbody>{rows.map((row) => <tr key={row.paymentId}>
          <td>{row.projectName}</td><td className="tnum">{row.certificateNumber}</td>
          <td className="tnum">{row.paymentNumber}</td><td>{fmt.date(row.paymentDate)}</td>
          <td className="text-end tnum">{fmt.money(row.amountMinor, row.currency)}</td>
        </tr>)}</tbody>
      </table>
      {rows.length === 0 && <p className="py-5 text-center text-sm text-slate-400">{t("reports.noIntegrityIssues")}</p>}
      <h3 className="mt-6 font-semibold">{t("reports.duplicateAllocations")}</h3>
      <p className="mb-3 mt-1 text-xs text-slate-500">{t("reports.duplicateAllocationsNote")}</p>
      <table className="w-full text-sm">
        <thead><tr><th>{t("projects.single")}</th><th>{t("certificates.number")}</th>
          <th>{t("payments.number")}</th><th className="text-end">{t("common.amount")}</th></tr></thead>
        <tbody>{duplicates.map((row) => <tr key={row.allocationId}>
          <td>{row.projectName}</td><td className="tnum">{row.certificateNumber}</td>
          <td className="tnum">{row.paymentNumber}</td>
          <td className="text-end tnum">{fmt.money(row.amountMinor, row.currency)}</td>
        </tr>)}</tbody>
      </table>
      {duplicates.length === 0 && <p className="py-5 text-center text-sm text-slate-400">{t("reports.noDuplicateAllocations")}</p>}
    </Card>
  );
}
