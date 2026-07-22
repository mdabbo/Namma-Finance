import { useTranslation } from "react-i18next";
import type { CertificateBreakdown, Contract } from "@mep/core";
import { certificateDueDate } from "@mep/core";
import type { CertificateListItem } from "../../repositories/certificates";
import { useFormat } from "../../lib/format";

interface CertificateDocumentProps {
  cert: CertificateListItem;
  contract: Contract;
  breakdown: CertificateBreakdown;
}

/** Print-ready certificate document in the active UI language. */
export function CertificateDocument({ cert, contract, breakdown }: CertificateDocumentProps) {
  const { t, i18n } = useTranslation();
  const fmt = useFormat();
  const currency = cert.currency;
  const dueDate = certificateDueDate(cert, cert.paymentTermsDaysSnapshot ?? contract.paymentTermsDays);
  const vatBp = cert.vatBpSnapshot ?? contract.vatBp;
  const retentionBp = cert.retentionBpSnapshot ?? contract.retentionBp;
  const withholdingBp = cert.withholdingBpSnapshot ?? contract.withholdingBp;

  return (
    <div dir={i18n.dir()} className="mx-auto max-w-3xl text-[13px] leading-relaxed text-black">
      <div className="mb-6 flex items-start justify-between border-b-2 border-slate-800 pb-4">
        <div>
          <h1 className="text-2xl font-bold">{t("certificates.pdfTitle")}</h1>
          <p className="mt-1 text-slate-600">{t("common.appName")}</p>
        </div>
        <div className="text-end">
          <p className="text-lg font-bold tnum">{cert.number}</p>
          <p className="text-slate-600 tnum">{fmt.date(cert.date)}</p>
        </div>
      </div>

      <table className="mb-6 w-full">
        <tbody>
          {[
            [t("clients.single"), cert.clientName],
            [t("projects.single"), `${cert.projectCode} — ${cert.projectName}`],
            [t("certificates.contract"), `${contract.number}${contract.title ? ` — ${contract.title}` : ""}`],
            [t("certificates.submissionDate"), cert.submissionDate ? fmt.date(cert.submissionDate) : "—"],
            [t("certificates.dueDate"), dueDate ? fmt.date(dueDate) : "—"],
            [t("common.description"), cert.description ?? "—"],
          ].map(([label, value]) => (
            <tr key={label}>
              <td className="w-44 py-1 font-semibold text-slate-600">{label}</td>
              <td className="py-1">{value}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <table className="w-full border-collapse">
        <thead>
          <tr className="bg-slate-100">
            <th className="border border-slate-300 px-3 py-2 text-start">{t("common.description")}</th>
            <th className="border border-slate-300 px-3 py-2 text-end">{t("common.amount")} ({currency})</th>
          </tr>
        </thead>
        <tbody>
          <DocRow label={t("certificates.gross")} value={fmt.money(breakdown.grossMinor, currency)} />
          {breakdown.discountMinor > 0 && (
            <>
              <DocRow label={t("certificates.discount")} value={`(${fmt.money(breakdown.discountMinor, currency)})`} />
              <DocRow label={t("certificates.base")} value={fmt.money(breakdown.baseMinor, currency)} />
            </>
          )}
          <DocRow label={`${t("certificates.vat")} (${fmt.percent(vatBp)})`} value={fmt.money(breakdown.vatMinor, currency)} />
          <DocRow label={`${t("certificates.retention")} (${fmt.percent(retentionBp)})`} value={`(${fmt.money(breakdown.retentionMinor, currency)})`} />
          <DocRow label={t("certificates.advanceRecovery")} value={`(${fmt.money(breakdown.advanceRecoveryMinor, currency)})`} />
          {withholdingBp > 0 && (
            <DocRow label={`${t("certificates.withholding")} (${fmt.percent(withholdingBp)})`} value={`(${fmt.money(breakdown.withholdingMinor, currency)})`} />
          )}
          <tr className="bg-slate-100 font-bold">
            <td className="border border-slate-300 px-3 py-2">{t("certificates.netPayable")}</td>
            <td className="border border-slate-300 px-3 py-2 text-end tnum">{fmt.money(breakdown.netPayableMinor, currency)}</td>
          </tr>
        </tbody>
      </table>

      <div className="mt-14 grid grid-cols-2 gap-12">
        {[t("common.appName"), t("clients.single")].map((party) => (
          <div key={party} className="text-center">
            <div className="mb-10 text-sm font-semibold text-slate-600">{party}</div>
            <div className="border-t border-slate-400 pt-1 text-xs text-slate-500">{t("common.date")} / ______________</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function DocRow({ label, value }: { label: string; value: string }) {
  return (
    <tr>
      <td className="border border-slate-300 px-3 py-2">{label}</td>
      <td className="border border-slate-300 px-3 py-2 text-end tnum">{value}</td>
    </tr>
  );
}
