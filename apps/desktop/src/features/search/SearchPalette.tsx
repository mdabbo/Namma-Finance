import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Banknote, Briefcase, Building2, FileSpreadsheet, Search, Users, Wallet } from "lucide-react";
import { useClients } from "../../repositories/clients";
import { useProjects } from "../../repositories/projects";
import { useCertificates } from "../../repositories/certificates";
import { usePayments } from "../../repositories/payments";
import { useExpenses } from "../../repositories/expenses";
import { usePeople } from "../../repositories/people";
import { Input } from "../../components/ui";

interface SearchHit {
  id: string;
  icon: typeof Search;
  title: string;
  subtitle: string;
  to: string;
}

export function useSearchPalette() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const openSearch = useCallback(() => setOpen(true), []);
  return { openSearch, SearchPortal: open ? <SearchPalette onClose={() => setOpen(false)} /> : null };
}

function SearchPalette({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);

  const { data: clients = [] } = useClients();
  const { data: projects = [] } = useProjects();
  const { data: certificates = [] } = useCertificates();
  const { data: payments = [] } = usePayments();
  const { data: expenses = [] } = useExpenses();
  const { data: people = [] } = usePeople();

  const hits = useMemo<SearchHit[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const match = (...fields: (string | null | undefined)[]) =>
      fields.some((f) => f && f.toLowerCase().includes(q));

    const results: SearchHit[] = [];
    for (const c of clients) {
      if (match(c.name, c.company, c.phone, c.email))
        results.push({ id: `c${c.id}`, icon: Building2, title: c.name, subtitle: t("clients.single"), to: `/clients/${c.id}` });
    }
    for (const p of projects) {
      if (match(p.name, p.code, p.clientName, p.city))
        results.push({ id: `p${p.id}`, icon: Briefcase, title: `${p.code} · ${p.name}`, subtitle: t("projects.single"), to: `/projects/${p.id}` });
    }
    for (const cert of certificates) {
      if (match(cert.number, cert.projectName, cert.description))
        results.push({ id: `t${cert.id}`, icon: FileSpreadsheet, title: cert.number, subtitle: `${t("certificates.single")} — ${cert.projectName}`, to: "/certificates" });
    }
    for (const pm of payments) {
      if (match(pm.number, pm.reference, pm.projectName))
        results.push({ id: `m${pm.id}`, icon: Banknote, title: pm.number, subtitle: `${t("payments.single")} — ${pm.projectName}`, to: "/payments" });
    }
    for (const e of expenses) {
      if (match(e.description, e.supplier, e.projectName))
        results.push({ id: `e${e.id}`, icon: Wallet, title: e.description, subtitle: t("expenses.single"), to: "/expenses" });
    }
    for (const person of people) {
      if (match(person.name, person.specialization, person.phone))
        results.push({ id: `f${person.id}`, icon: Users, title: person.name, subtitle: t(`personType.${person.type}`), to: `/people/${person.id}` });
    }
    return results.slice(0, 12);
  }, [query, clients, projects, certificates, payments, expenses, people, t]);

  function go(hit: SearchHit) {
    onClose();
    navigate(hit.to);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-slate-900/40 pt-24 backdrop-blur-sm" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="w-full max-w-xl rounded-2xl bg-white p-3 shadow-2xl dark:bg-slate-900">
        <div className="relative">
          <Search size={16} className="pointer-events-none absolute start-3 top-2.5 text-slate-400" />
          <Input
            autoFocus
            value={query}
            placeholder={t("common.searchPlaceholder")}
            className="ps-9 !py-2"
            onChange={(e) => {
              setQuery(e.target.value);
              setSelected(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") setSelected((s) => Math.min(s + 1, hits.length - 1));
              if (e.key === "ArrowUp") setSelected((s) => Math.max(s - 1, 0));
              if (e.key === "Enter" && hits[selected]) go(hits[selected]);
            }}
          />
        </div>
        {hits.length > 0 && (
          <ul className="mt-2 max-h-80 overflow-y-auto">
            {hits.map((hit, i) => (
              <li key={hit.id}>
                <button
                  className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-start text-sm ${i === selected ? "bg-brand-50 dark:bg-slate-800" : "hover:bg-slate-50 dark:hover:bg-slate-800/60"}`}
                  onMouseEnter={() => setSelected(i)}
                  onClick={() => go(hit)}
                >
                  <hit.icon size={16} className="shrink-0 text-slate-400" />
                  <div className="min-w-0">
                    <p className="truncate font-medium">{hit.title}</p>
                    <p className="truncate text-xs text-slate-400">{hit.subtitle}</p>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
        {query && hits.length === 0 && <p className="px-3 py-6 text-center text-sm text-slate-400">{t("common.noResults")}</p>}
      </div>
    </div>
  );
}
