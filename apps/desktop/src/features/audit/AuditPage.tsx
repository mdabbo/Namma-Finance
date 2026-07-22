import { useState } from "react";
import { useTranslation } from "react-i18next";
import { FileClock, X } from "lucide-react";
import { type AuditFilters, type AuditRecord, useAuditRecords, useEntityHistory } from "../../repositories/audit";
import { Button, Input, Select } from "../../components/ui";

const ENTITIES = ["contract","contract_revision","variation_order","payment_certificate","payment","payment_allocation","expense","recurring_expense","person","person_payment","project_assignment","time_entry","project","currency","setting","backup"];
const ACTIONS = ["CREATE","UPDATE","DELETE","REVISION_CREATE","STATUS_CHANGE","VOID","ARCHIVE","RESTORE","ALLOCATION_ADD","ALLOCATION_UPDATE","ALLOCATION_REMOVE","RATE_CHANGE","SETTING_CHANGE","BACKUP"];

function JsonBlock({ value }: { value: string | null }) {
  if (!value) return <span className="text-xs text-slate-400">—</span>;
  let shown = value;
  try { shown = JSON.stringify(JSON.parse(value), null, 2); } catch { /* retain stored value */ }
  return <pre dir="ltr" className="max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-slate-950 p-3 text-[11px] text-slate-100">{shown}</pre>;
}

function HistoryPanel({ record, close }: { record: AuditRecord; close: () => void }) {
  const { t, i18n } = useTranslation();
  const history = useEntityHistory(record);
  return (
    <div className="fixed inset-y-0 end-0 z-40 w-full max-w-xl overflow-y-auto border-s border-slate-200 bg-white p-5 shadow-2xl dark:border-slate-700 dark:bg-slate-900">
      <div className="mb-5 flex items-start justify-between gap-3">
        <div><h2 className="font-semibold">{t("audit.history")}</h2><p dir="ltr" className="text-xs text-slate-400">{record.entityType} · {record.entityId ?? record.entityUuid}</p></div>
        <Button variant="ghost" onClick={close}><X size={17} /></Button>
      </div>
      <div className="space-y-4 border-s-2 border-brand-100 ps-5 dark:border-brand-900">
        {(history.data ?? []).map((item) => (
          <article key={item.id} className="relative rounded-xl border border-slate-200 p-4 dark:border-slate-700">
            <span className="absolute -start-[27px] top-5 h-3 w-3 rounded-full bg-brand-500" />
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><b className="text-sm text-brand-700 dark:text-brand-300">{item.action}</b><time className="text-xs text-slate-400">{new Intl.DateTimeFormat(i18n.language,{dateStyle:"medium",timeStyle:"short"}).format(new Date(item.timestamp))}</time></div>
            {item.reason && <p className="mb-3 text-xs text-slate-500">{item.reason}</p>}
            <div className="grid gap-3 sm:grid-cols-2"><div><p className="mb-1 text-xs font-medium">{t("audit.before")}</p><JsonBlock value={item.beforeJson} /></div><div><p className="mb-1 text-xs font-medium">{t("audit.after")}</p><JsonBlock value={item.afterJson} /></div></div>
          </article>
        ))}
      </div>
    </div>
  );
}

export function AuditPage() {
  const { t, i18n } = useTranslation();
  const [filters, setFilters] = useState<AuditFilters>({});
  const [selected, setSelected] = useState<AuditRecord | null>(null);
  const audit = useAuditRecords(filters);
  const set = (key: keyof AuditFilters, value: string) => setFilters((current) => ({ ...current, [key]: value || undefined }));
  return (
    <div>
      <div className="mb-4 flex items-center gap-2"><FileClock className="text-brand-600" size={22} /><h1 className="text-xl font-semibold">{t("audit.title")}</h1></div>
      <div className="mb-4 grid gap-3 rounded-xl border border-slate-200 bg-white p-4 md:grid-cols-5 dark:border-slate-800 dark:bg-slate-900">
        <Input type="date" value={filters.dateFrom ?? ""} onChange={(e) => set("dateFrom",e.target.value)} title={t("audit.dateFrom")} />
        <Input type="date" value={filters.dateTo ?? ""} onChange={(e) => set("dateTo",e.target.value)} title={t("audit.dateTo")} />
        <Select value={filters.entityType ?? ""} onChange={(e) => set("entityType",e.target.value)}><option value="">{t("audit.allEntities")}</option>{ENTITIES.map((v)=><option key={v} value={v}>{v}</option>)}</Select>
        <Select value={filters.action ?? ""} onChange={(e) => set("action",e.target.value)}><option value="">{t("audit.allActions")}</option>{ACTIONS.map((v)=><option key={v} value={v}>{v}</option>)}</Select>
        <Input value={filters.userId ?? ""} onChange={(e) => set("userId",e.target.value)} placeholder={t("audit.user")} />
      </div>
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <div className="overflow-x-auto"><table className="w-full text-sm"><thead className="bg-slate-50 text-xs text-slate-500 dark:bg-slate-800"><tr><th className="p-3 text-start">{t("audit.timestamp")}</th><th className="p-3 text-start">{t("audit.action")}</th><th className="p-3 text-start">{t("audit.entity")}</th><th className="p-3 text-start">{t("audit.user")}</th><th className="p-3 text-start">{t("audit.source")}</th></tr></thead><tbody>
          {(audit.data ?? []).map((item)=><tr key={item.id} onClick={()=>setSelected(item)} className="cursor-pointer border-t border-slate-100 hover:bg-brand-50/50 dark:border-slate-800 dark:hover:bg-slate-800"><td className="p-3 whitespace-nowrap">{new Intl.DateTimeFormat(i18n.language,{dateStyle:"medium",timeStyle:"short"}).format(new Date(item.timestamp))}</td><td className="p-3 font-medium text-brand-700 dark:text-brand-300">{item.action}</td><td className="p-3" dir="ltr">{item.entityType} #{item.entityId ?? item.entityUuid}</td><td className="p-3">{item.userId || t("audit.localUser")}</td><td className="p-3">{item.source}</td></tr>)}
        </tbody></table></div>
        {!audit.isLoading && !audit.data?.length && <p className="p-8 text-center text-sm text-slate-400">{t("audit.empty")}</p>}
      </div>
      {selected && <HistoryPanel record={selected} close={()=>setSelected(null)} />}
    </div>
  );
}
