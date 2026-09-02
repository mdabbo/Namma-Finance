import { useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Archive, ArrowRight, ArrowLeft, Building2, Mail, MapPin, Pencil, Phone, ReceiptText } from "lucide-react";
import { computeClientFinancials } from "@mep/core";
import { clientCascadeInfo, useClient, useClientMutations } from "../../repositories/clients";
import { useProjectsByClient } from "../../repositories/projects";
import { useWorkspaceFinancials } from "../../repositories/financials";
import { useBaseMoney } from "../../lib/baseCurrency";
import { Badge, Button, Card, EmptyState, PageHeader } from "../../components/ui";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { KpiCard } from "../../components/KpiCard";
import { readModelDisplay as readModelAmount } from "../../lib/readModel";
import { Banknote, Briefcase, Wallet } from "lucide-react";
import { ClientForm } from "./ClientForm";

export function ClientDetailPage() {
  const { id } = useParams();
  const clientId = Number(id);
  const { t, i18n } = useTranslation();
  const base = useBaseMoney();
  const navigate = useNavigate();
  const { data: client } = useClient(clientId);
  const { data: projects = [] } = useProjectsByClient(clientId);
  const { data: financials } = useWorkspaceFinancials();
  const mutations = useClientMutations();
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState<{ details: string[] } | null>(null);

  if (!client) return <EmptyState message={t("common.loading")} />;

  const rollup = financials ? computeClientFinancials(clientId, financials.projects) : null;
  const BackIcon = i18n.dir() === "rtl" ? ArrowRight : ArrowLeft;

  return (
    <div>
      <button onClick={() => navigate("/projects/clients")} className="mb-3 flex items-center gap-1 text-sm text-slate-500 hover:text-brand-600">
        <BackIcon size={15} /> {t("clients.title")}
      </button>

      <PageHeader
        title={client.name}
        description={client.company}
        actions={
          <>
            <Button onClick={() => setEditing(true)}>
              <Pencil size={15} aria-hidden="true" />
              {t("common.edit")}
            </Button>
            <Button
              onClick={async () => {
                const info = await clientCascadeInfo(client.id);
                setDeleting({
                  details: [
                    `${info.projects} ${t("clients.projects")}`,
                    `${info.contracts} ${t("contracts.title")}`,
                    `${info.certificates} ${t("certificates.title")}`,
                    `${info.payments} ${t("payments.title")}`,
                  ],
                });
              }}
            >
              <Archive size={15} aria-hidden="true" />
              {t("lifecycle.archiveClient")}
            </Button>
          </>
        }
      />

      <div className="mb-4 grid grid-cols-4 gap-3">
        <KpiCard label={t("cash.contractValueExcludingVat")} value={readModelAmount(rollup, (r) => base.format(r.contractValueEgp))} icon={Briefcase} />
        <KpiCard label={t("cash.certificateCollections")} value={readModelAmount(rollup, (r) => base.format(r.certificateCollectionsEgp))} icon={Banknote} tone="positive" />
        <KpiCard label={t("cash.totalActualCashIn")} value={readModelAmount(rollup, (r) => base.format(r.totalActualCashInEgp))} icon={Banknote} tone="positive" />
        <KpiCard
          label={t("cash.outstandingReceivables")}
          value={readModelAmount(rollup, (r) => base.format(r.outstandingEgp))}
          icon={Wallet}
          tone={rollup && rollup.outstandingEgp > 0 ? "warning" : "default"}
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
                      <span className="text-sm tnum">{readModelAmount(fin, (f) => base.format(f.contractValueEgp))}</span>
                      <Badge value={p.status} label={t(`status.${p.status}`)} />
                    </div>
                  </Link>
                );
              })}
            </div>
          )}
        </Card>
      </div>

      {editing && (
        <ClientForm
          initial={client}
          busy={mutations.update.isPending}
          onClose={() => setEditing(false)}
          onSubmit={(input) => mutations.update.mutate({ id: client.id, input }, { onSuccess: () => setEditing(false) })}
        />
      )}

      {deleting && (
        <ConfirmDialog
          title={t("lifecycle.archiveClient")}
          tone="neutral"
          confirmLabel={t("lifecycle.archive")}
          message={`${t("lifecycle.confirmArchiveClient")} (${client.name})`}
          details={deleting.details}
          busy={mutations.remove.isPending}
          onCancel={() => {
            mutations.remove.reset();
            setDeleting(null);
          }}
          onConfirm={() =>
            mutations.remove.mutate(
              { id: client.id },
              {
                onSuccess: () => {
                  setDeleting(null);
                  navigate("/projects/clients");
                },
              },
            )
          }
        />
      )}
    </div>
  );
}
