import { useParams, useNavigate, Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowRight, ArrowLeft, Building2, Mail, MapPin, Phone, ReceiptText } from "lucide-react";
import { computeClientFinancials } from "@mep/core";
import { useClient } from "../../repositories/clients";
import { useProjectsByClient } from "../../repositories/projects";
import { useWorkspaceFinancials } from "../../repositories/financials";
import { useBaseMoney } from "../../lib/baseCurrency";
import { Badge, Card, EmptyState } from "../../components/ui";
import { KpiCard } from "../../components/KpiCard";
import { Banknote, Briefcase, Wallet } from "lucide-react";

export function ClientDetailPage() {
  const { id } = useParams();
  const clientId = Number(id);
  const { t, i18n } = useTranslation();
  const base = useBaseMoney();
  const navigate = useNavigate();
  const { data: client } = useClient(clientId);
  const { data: projects = [] } = useProjectsByClient(clientId);
  const { data: financials } = useWorkspaceFinancials();

  if (!client) return <EmptyState message={t("common.loading")} />;

  const rollup = financials ? computeClientFinancials(clientId, financials.projects) : null;
  const BackIcon = i18n.dir() === "rtl" ? ArrowRight : ArrowLeft;

  return (
    <div>
      <button onClick={() => navigate("/clients")} className="mb-3 flex items-center gap-1 text-sm text-slate-500 hover:text-brand-600">
        <BackIcon size={15} /> {t("clients.title")}
      </button>

      <div className="mb-4 flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold">{client.name}</h1>
          {client.company && <p className="text-sm text-slate-500">{client.company}</p>}
        </div>
      </div>

      <div className="mb-4 grid grid-cols-3 gap-3">
        <KpiCard label={t("clients.totalContracts")} value={base.format(rollup?.contractValueEgp ?? 0)} icon={Briefcase} />
        <KpiCard label={t("clients.totalCollected")} value={base.format(rollup?.collectedEgp ?? 0)} icon={Banknote} tone="positive" />
        <KpiCard
          label={t("clients.outstanding")}
          value={base.format(rollup?.outstandingEgp ?? 0)}
          icon={Wallet}
          tone={(rollup?.outstandingEgp ?? 0) > 0 ? "warning" : "default"}
        />
      </div>

      <div className="grid grid-cols-3 gap-4">
        <Card className="p-4 text-sm">
          <h2 className="mb-3 font-semibold">{t("clients.single")}</h2>
          <dl className="space-y-2 text-slate-600 dark:text-slate-300">
            {client.phone && (
              <div className="flex items-center gap-2"><Phone size={14} className="text-slate-400" /><span className="tnum">{client.phone}</span></div>
            )}
            {client.email && (
              <div className="flex items-center gap-2"><Mail size={14} className="text-slate-400" /><span dir="ltr">{client.email}</span></div>
            )}
            {client.address && (
              <div className="flex items-center gap-2"><MapPin size={14} className="text-slate-400" />{client.address}</div>
            )}
            {client.taxNumber && (
              <div className="flex items-center gap-2"><ReceiptText size={14} className="text-slate-400" /><span className="tnum">{client.taxNumber}</span></div>
            )}
            {client.contacts && (
              <div className="flex items-start gap-2"><Building2 size={14} className="mt-0.5 text-slate-400" /><span className="whitespace-pre-wrap">{client.contacts}</span></div>
            )}
            {client.notes && <p className="border-t border-slate-100 pt-2 text-slate-500 dark:border-slate-800">{client.notes}</p>}
          </dl>
        </Card>

        <Card className="col-span-2 p-4">
          <h2 className="mb-3 font-semibold">{t("clients.projects")}</h2>
          {projects.length === 0 ? (
            <EmptyState message={t("clients.noProjects")} />
          ) : (
            <div className="space-y-2">
              {projects.map((p) => {
                const fin = financials?.projects.find((f) => f.project.id === p.id);
                return (
                  <Link
                    key={p.id}
                    to={`/projects/${p.id}`}
                    className="flex items-center justify-between rounded-lg border border-slate-100 px-3 py-2.5 hover:border-brand-200 hover:bg-brand-50/40 dark:border-slate-800 dark:hover:bg-slate-800/60"
                  >
                    <div>
                      <p className="text-sm font-medium">{p.name}</p>
                      <p className="text-xs text-slate-400 tnum">{p.code}</p>
                    </div>
                    <div className="flex items-center gap-4">
                      <span className="text-sm tnum">{base.format(fin?.contractValueEgp ?? 0)}</span>
                      <Badge value={p.status} label={t(`status.${p.status}`)} />
                    </div>
                  </Link>
                );
              })}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
