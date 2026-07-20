import { useState } from "react";
import { useTranslation } from "react-i18next";
import { FileDown, FileSpreadsheet, FileText } from "lucide-react";
import {
  certificateDueDate,
  computeAging,
  computeProfitability,
  isBillable,
  laborCostMinor,
  minutesToHours,
  toEgpPiasters,
} from "@mep/core";
import { useWorkspaceFinancials } from "../../repositories/financials";
import { useClients } from "../../repositories/clients";
import { useCertificates } from "../../repositories/certificates";
import { usePayments } from "../../repositories/payments";
import { useExpenses } from "../../repositories/expenses";
import { listAllAssignments, listAllPersonPayments, usePeople } from "../../repositories/people";
import { listTimeEntries } from "../../repositories/timeEntries";
import { useSettings } from "../../lib/settings";
import { useBaseMoney } from "../../lib/baseCurrency";
import { todayIso, useFormat } from "../../lib/format";
import { exportCsv, exportXlsx } from "../../lib/export";
import { Button, Card, EmptyState, Select } from "../../components/ui";
import { PrintPortal } from "../../components/PrintPortal";

type ReportKey =
  | "projects" | "clients" | "certificates" | "payments" | "expenses"
  | "people" | "time" | "profitability" | "aging" | "annual";

const REPORTS: ReportKey[] = ["projects", "clients", "certificates", "payments", "expenses", "people", "time", "profitability", "aging", "annual"];

export function ReportsCenter() {
  const { t, i18n } = useTranslation();
  const fmt = useFormat();
  const base = useBaseMoney();
  const { data: financials } = useWorkspaceFinancials();
  const { data: clients = [] } = useClients();
  const { data: certificates = [] } = useCertificates();
  const { data: payments = [] } = usePayments();
  const { data: expenses = [] } = useExpenses();
  const { data: people = [] } = usePeople();
  const { data: settings } = useSettings();

  const [year, setYear] = useState(() => new Date().getFullYear());
  const [printing, setPrinting] = useState<{ title: string; rows: Record<string, unknown>[] } | null>(null);

  const money = (egp: number) => base.format(egp);

  async function buildRows(key: ReportKey): Promise<Record<string, unknown>[]> {
    if (!financials) return [];
    switch (key) {
      case "projects":
        return financials.projects.map((p) => ({
          [t("projects.code")]: p.project.code,
          [t("common.name")]: p.project.name,
          [t("projects.client")]: clients.find((c) => c.id === p.project.clientId)?.name ?? "",
          [t("projects.discipline")]: t(`discipline.${p.project.discipline}`),
          [t("common.status")]: t(`status.${p.project.status}`),
          [t("clients.totalContracts")]: money(p.contractValueEgp),
          [t("dashboard.kpiRevenue")]: money(p.revenueEgp),
          [t("projects.collected")]: money(p.collectedEgp),
          [t("clients.outstanding")]: money(p.outstandingEgp),
        }));
      case "clients":
        return clients.map((c) => {
          const own = financials.projects.filter((p) => p.project.clientId === c.id);
          return {
            [t("common.name")]: c.name,
            [t("clients.company")]: c.company ?? "",
            [t("clients.projects")]: own.length,
            [t("clients.totalContracts")]: money(own.reduce((s, p) => s + p.contractValueEgp, 0)),
            [t("clients.totalCollected")]: money(own.reduce((s, p) => s + p.collectedEgp, 0)),
            [t("clients.outstanding")]: money(own.reduce((s, p) => s + p.outstandingEgp, 0)),
          };
        });
      case "certificates":
        return certificates.map((cert) => {
          const cs = financials.contractStates.get(cert.contractId)?.certificates.find((x) => x.certificate.id === cert.id);
          return {
            [t("certificates.number")]: cert.number,
            [t("projects.single")]: cert.projectName,
            [t("clients.single")]: cert.clientName,
            [t("common.date")]: cert.date,
            [t("common.status")]: t(`status.${cert.status}`),
            [t("certificates.gross")]: fmt.money(cert.grossMinor, cert.currency),
            [t("certificates.netPayable")]: fmt.money(cs?.breakdown.netPayableMinor ?? 0, cert.currency),
            [t("certificates.paid")]: fmt.money(cs?.paidMinor ?? 0, cert.currency),
            [t("certificates.unpaid")]: fmt.money(cs?.unpaidMinor ?? 0, cert.currency),
          };
        });
      case "payments":
        return payments.map((p) => ({
          [t("payments.number")]: p.number,
          [t("projects.single")]: p.projectName,
          [t("clients.single")]: p.clientName,
          [t("payments.kind")]: t(`paymentKind.${p.kind}`),
          [t("common.date")]: p.date,
          [t("payments.method")]: t(`method.${p.method}`),
          [t("common.amount")]: fmt.money(p.amountMinor, p.currency),
        }));
      case "expenses":
        return expenses.map((e) => ({
          [t("common.date")]: e.date,
          [t("expenses.category")]: i18n.language === "ar" ? e.categoryAr : e.categoryEn,
          [t("common.description")]: e.description,
          [t("expenses.project")]: e.projectName ?? t("common.overhead"),
          [t("expenses.supplier")]: e.supplier ?? "",
          [t("common.amount")]: fmt.money(e.amountMinor, e.currency),
        }));
      case "people": {
        const assignments = await listAllAssignments();
        const personPayments = await listAllPersonPayments();
        return people.map((person) => {
          const own = assignments.filter((a) => a.personId === person.id);
          const paid = personPayments
            .filter((p) => own.some((a) => a.id === p.assignmentId))
            .reduce((s, p) => s + p.amountMinor, 0);
          const agreed = own.reduce((s, a) => s + a.agreedMinor, 0);
          return {
            [t("common.name")]: person.name,
            [t("payments.kind")]: t(`personType.${person.type}`),
            [t("people.specialization")]: person.specialization ?? "",
            [t("people.assignments")]: own.length,
            [t("people.agreedAmount")]: fmt.money(agreed, person.currency),
            [t("people.paidToDate")]: fmt.money(paid, person.currency),
            [t("people.remainingAmount")]: fmt.money(agreed - paid, person.currency),
          };
        });
      }
      case "time": {
        const entries = await listTimeEntries();
        return entries.map((e) => ({
          [t("common.date")]: e.date,
          [t("time.person")]: e.personName,
          [t("projects.single")]: e.projectName,
          [t("time.stage")]: e.stageName ?? "",
          [t("common.notes")]: e.note ?? "",
          [t("time.hours")]: minutesToHours(e.minutes),
          [t("time.billable")]: e.billable ? t("time.billable") : t("time.nonBillable"),
          [t("time.laborCost")]: e.hourlyRateMinor
            ? fmt.money(laborCostMinor(e.minutes, e.hourlyRateMinor), e.personCurrency)
            : t("reports.noRate"),
        }));
      }
      case "profitability": {
        const overhead = financials.allExpenses
          .filter((e) => e.projectId === null)
          .reduce((s, e) => s + toEgpPiasters(e.amountMinor, e.currency, e.fxRateMicro), 0);
        return computeProfitability(financials.projects, overhead, settings?.overheadRule ?? "REVENUE").map((r, i) => ({
          "#": i + 1,
          [t("projects.single")]: `${r.projectCode} ${r.projectName}`,
          [t("reports.revenue")]: money(r.revenueEgp),
          [t("reports.directCosts")]: money(r.directCostEgp),
          [t("reports.grossProfit")]: money(r.grossProfitEgp),
          [t("reports.overheadShare")]: money(r.overheadEgp),
          [t("reports.netProfit")]: money(r.netProfitEgp),
          [t("reports.netMargin")]: fmt.percent(r.netMarginBp),
        }));
      }
      case "aging": {
        const inputs = [...financials.contractStates.values()].flatMap((state) => {
          const project = financials.projects.find((p) => p.project.id === state.contract.projectId)?.project;
          return state.certificates
            .filter((cs) => isBillable(cs.certificate.status) && cs.unpaidMinor > 0)
            .map((cs) => ({
              certificateId: cs.certificate.id,
              certificateNumber: cs.certificate.number,
              projectName: project?.name ?? "",
              clientName: clients.find((c) => c.id === project?.clientId)?.name ?? "",
              dueDate: certificateDueDate(cs.certificate, state.contract.paymentTermsDays),
              unpaidEgp: project ? toEgpPiasters(cs.unpaidMinor, project.currency, project.fxRateMicro) : cs.unpaidMinor,
            }));
        });
        const summary = computeAging(inputs, todayIso());
        return summary.rows.map((r) => ({
          [t("certificates.number")]: r.certificateNumber,
          [t("projects.single")]: r.projectName,
          [t("clients.single")]: r.clientName,
          [t("certificates.dueDate")]: r.dueDate ?? "",
          [t("reports.daysOverdue")]: r.daysOverdue,
          [t("certificates.unpaid")]: money(r.unpaidEgp),
          [t("common.status")]: t(`reports.aging${r.bucket}`),
        }));
      }
      case "annual": {
        const inYear = (date: string) => date.startsWith(String(year));
        const revenue = [...financials.contractStates.values()].reduce((sum, state) => {
          const project = financials.projects.find((p) => p.project.id === state.contract.projectId)?.project;
          return (
            sum +
            state.certificates
              .filter((cs) => isBillable(cs.certificate.status) && inYear(cs.certificate.date))
              .reduce((s, cs) => s + (project ? toEgpPiasters(cs.breakdown.baseMinor, project.currency, project.fxRateMicro) : cs.breakdown.baseMinor), 0)
          );
        }, 0);
        const collected = financials.cashIn.filter((p) => inYear(p.date)).reduce((s, p) => s + p.egpMinor, 0);
        const yearExpenses = financials.allExpenses.filter((e) => inYear(e.date));
        const byCategory = new Map<string, number>();
        for (const e of yearExpenses) {
          const key = i18n.language === "ar"
            ? expenses.find((x) => x.id === e.id)?.categoryAr ?? "?"
            : expenses.find((x) => x.id === e.id)?.categoryEn ?? "?";
          byCategory.set(key, (byCategory.get(key) ?? 0) + toEgpPiasters(e.amountMinor, e.currency, e.fxRateMicro));
        }
        const totalExpenses = [...byCategory.values()].reduce((a, b) => a + b, 0);
        const rows: Record<string, unknown>[] = [
          { [t("common.description")]: t("reports.annualRevenue"), [t("common.amount")]: money(revenue) },
          { [t("common.description")]: t("reports.annualCollected"), [t("common.amount")]: money(collected) },
        ];
        for (const [cat, value] of [...byCategory.entries()].sort((a, b) => b[1] - a[1])) {
          rows.push({ [t("common.description")]: `${t("expenses.category")}: ${cat}`, [t("common.amount")]: money(value) });
        }
        rows.push({ [t("common.description")]: t("dashboard.kpiExpenses"), [t("common.amount")]: money(totalExpenses) });
        rows.push({ [t("common.description")]: t("reports.annualProfit"), [t("common.amount")]: money(revenue - totalExpenses) });
        return rows;
      }
    }
  }

  async function run(key: ReportKey, format: "pdf" | "xlsx" | "csv") {
    const rows = await buildRows(key);
    const title = t(`reports.report${key.charAt(0).toUpperCase()}${key.slice(1)}`) + (key === "annual" ? ` ${year}` : "");
    if (rows.length === 0) return;
    if (format === "pdf") setPrinting({ title, rows });
    else if (format === "xlsx") await exportXlsx(title, title, rows);
    else await exportCsv(title, rows);
  }

  if (!financials) return <EmptyState message={t("common.loading")} />;

  return (
    <div className="grid grid-cols-3 gap-3">
      {REPORTS.map((key) => (
        <Card key={key} className="flex flex-col justify-between p-4">
          <p className="mb-3 text-sm font-semibold">
            {t(`reports.report${key.charAt(0).toUpperCase()}${key.slice(1)}`)}
          </p>
          {key === "annual" && (
            <Select className="mb-3 !w-28" value={year} onChange={(e) => setYear(Number(e.target.value))}>
              {Array.from({ length: 6 }, (_, i) => new Date().getFullYear() - i).map((y) => (
                <option key={y} value={y}>{y}</option>
              ))}
            </Select>
          )}
          <div className="flex gap-1.5">
            <Button onClick={() => void run(key, "pdf")}>
              <FileDown size={14} /> PDF
            </Button>
            <Button onClick={() => void run(key, "xlsx")}>
              <FileSpreadsheet size={14} /> Excel
            </Button>
            <Button onClick={() => void run(key, "csv")}>
              <FileText size={14} /> {t("reports.exportCsv")}
            </Button>
          </div>
        </Card>
      ))}

      {printing && (
        <PrintPortal onDone={() => setPrinting(null)}>
          <div dir={i18n.dir()} className="text-[12px] text-black">
            <div className="mb-4 flex items-baseline justify-between border-b-2 border-slate-800 pb-2">
              <h1 className="text-xl font-bold">{printing.title}</h1>
              <p className="text-slate-500">
                {t("common.appName")} · {t("reports.generatedOn")} <span className="tnum">{fmt.date(todayIso())}</span>
              </p>
            </div>
            <table className="w-full border-collapse">
              <thead>
                <tr className="bg-slate-100">
                  {Object.keys(printing.rows[0] ?? {}).map((h) => (
                    <th key={h} className="border border-slate-300 px-2 py-1.5 text-start">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {printing.rows.map((row, i) => (
                  <tr key={i}>
                    {Object.values(row).map((v, j) => (
                      <td key={j} className="border border-slate-300 px-2 py-1 tnum">{String(v ?? "")}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </PrintPortal>
      )}
    </div>
  );
}
