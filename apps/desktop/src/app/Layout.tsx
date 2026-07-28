import { useEffect } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  BarChart3,
  ChevronLeft,
  ChevronRight,
  LayoutDashboard,
  Landmark,
  Moon,
  Search,
  Settings,
  Sun,
  Users,
  Briefcase,
  Receipt,
  type LucideIcon,
} from "lucide-react";
import { useSettings, useUpdateSetting } from "../lib/settings";
import { allowedPath, canMountRoute, roleRedirectTarget, useRoleAccess } from "../lib/roles";
import { useAutoSync } from "../repositories/sync";
import { Button, cx } from "../components/ui";
import { NotificationBell } from "../components/NotificationBell";
import { useSearchPalette } from "../features/search/SearchPalette";
import {
  PRIMARY_NAVIGATION,
  SECONDARY_NAVIGATION,
  activeSecondaryItemId,
  activeSectionForPath,
  breadcrumbsForPath,
  type NavigationSectionId,
} from "./navigation";
import logoUrl from "../assets/namaa-logo.png";

const NAV_ICONS: Record<NavigationSectionId, LucideIcon> = {
  overview: LayoutDashboard,
  projects: Briefcase,
  finance: Landmark,
  team: Users,
  reports: BarChart3,
  settings: Settings,
};

export function Layout() {
  const { t, i18n } = useTranslation();
  const { data: settings } = useSettings();
  const updateSetting = useUpdateSetting();
  const { role, rolePending } = useRoleAccess();
  const { openSearch, SearchPortal } = useSearchPalette(role);
  const location = useLocation();
  const navigate = useNavigate();
  useAutoSync();

  // role gate: engineers only reach projects & settings
  const redirectTarget = roleRedirectTarget(role, location.pathname, rolePending);
  const routeAuthorized = canMountRoute(role, location.pathname, rolePending);
  useEffect(() => {
    if (redirectTarget) navigate(redirectTarget, { replace: true });
  }, [redirectTarget, navigate]);

  const nav = PRIMARY_NAVIGATION.filter((item) => allowedPath(role, item.to));
  const activeSection = activeSectionForPath(location.pathname);
  const secondary = activeSection
    ? SECONDARY_NAVIGATION[activeSection].filter((item) => allowedPath(role, item.to))
    : [];
  const activeSecondary = activeSecondaryItemId(location.pathname, secondary);
  const breadcrumbs = breadcrumbsForPath(location.pathname);
  const BreadcrumbSeparator = i18n.dir() === "rtl" ? ChevronLeft : ChevronRight;
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
          {nav.map(({ id, to, labelKey }) => {
            const Icon = NAV_ICONS[id];
            const isActive = activeSection === id;
            return (
              <Link
                key={id}
                to={to}
                aria-current={isActive ? "page" : undefined}
                className={cx(
                  "flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                  isActive
                    ? "bg-brand-50 text-brand-700 dark:bg-brand-900/40 dark:text-brand-200"
                    : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800",
                )}
              >
                <Icon size={17} />
                {t(labelKey)}
              </Link>
            );
          })}
        </nav>
        <div className="border-t border-slate-200 p-3 text-[11px] text-slate-400 dark:border-slate-800">
          <Receipt size={12} className="mb-1" />
          {t("dashboard.consolidatedNote", { currency: settings?.baseCurrency ?? "EGP" })}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-slate-200 bg-white px-5 dark:border-slate-800 dark:bg-slate-900">
          <nav aria-label={t("nav.breadcrumbs")} className="min-w-0">
            <ol className="flex min-w-0 items-center gap-1 text-xs text-slate-500 dark:text-slate-400">
              {breadcrumbs.map((item, index) => (
                <li key={`${item.labelKey}-${index}`} className="flex min-w-0 items-center gap-1">
                  {index > 0 && <BreadcrumbSeparator size={13} className="shrink-0 text-slate-300 dark:text-slate-600" />}
                  {item.to ? (
                    <Link className="truncate hover:text-brand-600 dark:hover:text-brand-300" to={item.to}>
                      {t(item.labelKey)}
                    </Link>
                  ) : (
                    <span className="truncate font-medium text-slate-700 dark:text-slate-200" aria-current="page">
                      {t(item.labelKey)}
                    </span>
                  )}
                </li>
              ))}
            </ol>
          </nav>
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
        {secondary.length > 0 && (
          <div className="flex h-11 shrink-0 items-end border-b border-slate-200 bg-white px-5 dark:border-slate-800 dark:bg-slate-900">
            <nav aria-label={t("nav.sectionNavigation")} className="flex max-w-full gap-1 overflow-x-auto">
              {secondary.map((item) => {
                const isActive = activeSecondary === item.id;
                return (
                  <NavLink
                    key={item.id}
                    to={item.to}
                    end={item.exact}
                    aria-current={isActive ? "page" : undefined}
                    className={cx(
                      "shrink-0 border-b-2 px-3 py-2 text-sm font-medium transition-colors",
                      isActive
                        ? "border-brand-600 text-brand-700 dark:text-brand-300"
                        : "border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200",
                    )}
                  >
                    {t(item.labelKey)}
                  </NavLink>
                );
              })}
            </nav>
          </div>
        )}
        <main className="min-h-0 flex-1 overflow-y-auto p-5">
          {routeAuthorized ? <Outlet /> : null}
        </main>
      </div>
      {SearchPortal}
    </div>
  );
}
