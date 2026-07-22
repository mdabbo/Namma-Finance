import { useEffect } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  Banknote,
  BarChart3,
  Building2,
  Clock,
  FileSpreadsheet,
  FileClock,
  LayoutDashboard,
  Moon,
  Receipt,
  Search,
  Settings,
  Sun,
  Users,
  Wallet,
  Briefcase,
} from "lucide-react";
import { useSettings, useUpdateSetting } from "../lib/settings";
import { allowedPath, homePath, useRole } from "../lib/roles";
import { useAutoSync } from "../repositories/sync";
import { Button, cx } from "../components/ui";
import { NotificationBell } from "../components/NotificationBell";
import { useSearchPalette } from "../features/search/SearchPalette";
import logoUrl from "../assets/namaa-logo.png";

const NAV = [
  { to: "/", key: "nav.dashboard", icon: LayoutDashboard },
  { to: "/clients", key: "nav.clients", icon: Building2 },
  { to: "/projects", key: "nav.projects", icon: Briefcase },
  { to: "/certificates", key: "nav.certificates", icon: FileSpreadsheet },
  { to: "/payments", key: "nav.payments", icon: Banknote },
  { to: "/expenses", key: "nav.expenses", icon: Wallet },
  { to: "/people", key: "nav.people", icon: Users },
  { to: "/time", key: "nav.time", icon: Clock },
  { to: "/reports", key: "nav.reports", icon: BarChart3 },
  { to: "/audit", key: "nav.audit", icon: FileClock },
  { to: "/settings", key: "nav.settings", icon: Settings },
];

export function Layout() {
  const { t } = useTranslation();
  const { data: settings } = useSettings();
  const updateSetting = useUpdateSetting();
  const { openSearch, SearchPortal } = useSearchPalette();
  const role = useRole();
  const location = useLocation();
  const navigate = useNavigate();
  useAutoSync();

  // role gate: engineers only reach projects & settings
  useEffect(() => {
    if (!allowedPath(role, location.pathname)) navigate(homePath(role), { replace: true });
  }, [role, location.pathname, navigate]);

  const nav = NAV.filter((item) => allowedPath(role, item.to));
  const theme = settings?.theme ?? "light";
  const language = settings?.language ?? "ar";

  return (
    <div className="flex h-screen overflow-hidden">
      <aside className="flex w-56 shrink-0 flex-col border-e border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-center gap-2.5 px-4 py-4">
          <img src={logoUrl} alt="NAMAA" className="h-10 w-10 shrink-0" />
          <div>
            <p className="text-sm font-semibold leading-tight">{t("common.appName")}</p>
            <p className="text-[10px] italic text-slate-400">{t("common.tagline")}</p>
          </div>
        </div>
        <nav className="mt-2 flex-1 space-y-0.5 px-2">
          {nav.map(({ to, key, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === "/"}
              className={({ isActive }) =>
                cx(
                  "flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                  isActive
                    ? "bg-brand-50 text-brand-700 dark:bg-brand-900/40 dark:text-brand-200"
                    : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800",
                )
              }
            >
              <Icon size={17} />
              {t(key)}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-slate-200 p-3 text-[11px] text-slate-400 dark:border-slate-800">
          <Receipt size={12} className="mb-1" />
          {t("dashboard.consolidatedNote", { currency: settings?.baseCurrency ?? "EGP" })}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-slate-200 bg-white px-5 dark:border-slate-800 dark:bg-slate-900">
          <div />
          <div className="flex items-center gap-1.5">
            <button
              onClick={openSearch}
              title={t("common.searchPlaceholder")}
              className="flex items-center gap-2 rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs text-slate-400 transition-colors hover:border-brand-300 hover:text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:hover:text-slate-300"
            >
              <Search size={13} />
              {t("common.search")}
              <kbd className="rounded border border-slate-300 px-1 text-[9px] dark:border-slate-600">Ctrl+K</kbd>
            </button>
            {role !== "ENGINEER" && <NotificationBell />}
            <Button
              variant="ghost"
              title={t("settings.baseCurrency")}
              className="!px-2 text-xs font-semibold tnum"
              onClick={() => {
                const order = ["EGP", "SAR", "USD"] as const;
                const current = settings?.baseCurrency ?? "EGP";
                const next = order[(order.indexOf(current) + 1) % order.length]!;
                updateSetting.mutate({ key: "baseCurrency", value: next });
              }}
            >
              {settings?.baseCurrency ?? "EGP"}
            </Button>
            <Button
              variant="ghost"
              title={t("settings.language")}
              onClick={() => updateSetting.mutate({ key: "language", value: language === "ar" ? "en" : "ar" })}
            >
              {language === "ar" ? "EN" : "ع"}
            </Button>
            <Button
              variant="ghost"
              title={t("settings.theme")}
              onClick={() => updateSetting.mutate({ key: "theme", value: theme === "light" ? "dark" : "light" })}
            >
              {theme === "light" ? <Moon size={17} /> : <Sun size={17} />}
            </Button>
          </div>
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto p-5">
          <Outlet />
        </main>
      </div>
      {SearchPortal}
    </div>
  );
}
