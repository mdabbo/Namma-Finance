import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Banknote, Briefcase, Building2, FileSpreadsheet, Search, Settings2, Users, Wallet } from "lucide-react";
import { useClients, type ClientListItem } from "../../repositories/clients";
import { useProjects, type ProjectListItem } from "../../repositories/projects";
import { useCertificates, type CertificateListItem } from "../../repositories/certificates";
import { usePayments, type PaymentListItem } from "../../repositories/payments";
import { useExpenses, type ExpenseListItem } from "../../repositories/expenses";
import { usePeople, type PersonListItem } from "../../repositories/people";
import { Input } from "../../components/ui";
import { allowedPath, searchScopeForRole, useRole, type Role } from "../../lib/roles";
import { SECONDARY_NAVIGATION, SETTINGS_SECTIONS } from "../../app/navigation";

/**
 * Named destinations the palette can jump to. Settings sections and reports
 * each have their own address, so they are found by name rather than by
 * remembering which page they used to be a tab on.
 */
const DESTINATIONS: { to: string; labelKey: string; sectionKey: string }[] = [
  ...SETTINGS_SECTIONS.map((section) => ({
    to: section.id === "audit" ? "/settings/audit" : `/settings/${section.id}`,
    labelKey: section.labelKey,
    sectionKey: "nav.settings",
  })),
  ...SECONDARY_NAVIGATION.reports.map((item) => ({
    to: item.to,
    labelKey: item.labelKey,
    sectionKey: "nav.reports",
  })),
];

interface SearchHit {
  id: string;
  icon: typeof Search;
  title: string;
  subtitle: string;
  to: string;
}

export function useSearchPalette(role: Role) {
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
  const close = useCallback(() => setOpen(false), []);
  const SearchPortal = open
    ? searchScopeForRole(role) === "PROJECTS_ONLY"
      ? <ProjectSearchPalette onClose={close} />
      : <FullSearchPalette onClose={close} />
    : null;
  return { openSearch, SearchPortal };
}

interface SearchData {
  clients: ClientListItem[];
  projects: ProjectListItem[];
  certificates: CertificateListItem[];
  payments: PaymentListItem[];
  expenses: ExpenseListItem[];
  people: PersonListItem[];
}

function ProjectSearchPalette({ onClose }: { onClose: () => void }) {
  const { data: projects = [] } = useProjects();
  return (
    <SearchPalette
      onClose={onClose}
      clients={[]}
      projects={projects}
      certificates={[]}
      payments={[]}
      expenses={[]}
      people={[]}
    />
  );
}

function FullSearchPalette({ onClose }: { onClose: () => void }) {
  const { data: clients = [] } = useClients();
  const { data: projects = [] } = useProjects();
  const { data: certificates = [] } = useCertificates();
  const { data: payments = [] } = usePayments();
  const { data: expenses = [] } = useExpenses();
  const { data: people = [] } = usePeople();
  return (
    <SearchPalette
      onClose={onClose}
      clients={clients}
      projects={projects}
      certificates={certificates}
      payments={payments}
      expenses={expenses}
      people={people}
    />
  );
}

function SearchPalette({ onClose, clients, projects, certificates, payments, expenses, people }: SearchData & { onClose: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);

  const role = useRole();
  const destinations = useMemo(() => DESTINATIONS.filter(
    (item) => !item.to.startsWith("/settings/") || allowedPath(role, item.to),
  ), [role]);

  const hits = useMemo<SearchHit[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const match = (...fields: (string | null | undefined)[]) =>
      fields.some((f) => f && f.toLowerCase().includes(q));

    const results: SearchHit[] = [];
    // Settings sections and reports have their own addresses now, so they are
    // reachable by name instead of by remembering which page they sit on.
    for (const destination of destinations) {
      const label = t(destination.labelKey);
      if (match(label, destination.to)) {
        results.push({
          id: destination.to,
          icon: Settings2,
          title: label,
          subtitle: t(destination.sectionKey),
          to: destination.to,
        });
      }
    }
    for (const c of clients) {
      if (match(c.name, c.company, c.phone, c.email))
        results.push({ id: `c${c.id}`, icon: Building2, title: c.name, subtitle: t("clients.single"), to: `/projects/clients/${c.id}` });
    }
    for (const p of projects) {
      if (match(p.name, p.code, p.clientName, p.city))
        results.push({ id: `p${p.id}`, icon: Briefcase, title: `${p.code} · ${p.name}`, subtitle: t("projects.single"), to: `/projects/${p.id}` });
    }
    for (const cert of certificates) {
      if (match(cert.number, cert.projectName, cert.description))
        results.push({ id: `t${cert.id}`, icon: FileSpreadsheet, title: cert.number, subtitle: `${t("certificates.single")} — ${cert.projectName}`, to: "/finance/certificates" });
    }
    for (const pm of payments) {
      if (match(pm.number, pm.reference, pm.projectName))
        results.push({ id: `m${pm.id}`, icon: Banknote, title: pm.number, subtitle: `${t("payments.single")} — ${pm.projectName}`, to: "/finance/payments" });
    }
    for (const e of expenses) {
      if (match(e.description, e.supplier, e.projectName))
        results.push({ id: `e${e.id}`, icon: Wallet, title: e.description, subtitle: t("expenses.single"), to: "/finance/expenses" });
    }
    for (const person of people) {
      if (match(person.name, person.specialization, person.phone))
        results.push({ id: `f${person.id}`, icon: Users, title: person.name, subtitle: t(`personType.${person.type}`), to: `/team/people/${person.id}` });
    }
    return results.slice(0, 12);
  }, [query, clients, projects, certificates, payments, expenses, people, destinations, t]);

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
