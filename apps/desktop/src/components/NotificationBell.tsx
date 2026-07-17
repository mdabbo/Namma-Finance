import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Bell } from "lucide-react";
import { useNotifications, useNotificationToasts, type NotificationKind } from "../repositories/notifications";
import { cx } from "./ui";

const KIND_DOT: Record<NotificationKind, string> = {
  OVERDUE: "bg-red-500",
  DUE_SOON: "bg-amber-500",
  READY_TO_COLLECT: "bg-emerald-500",
  TEAM_PAYABLE: "bg-sky-500",
  BOND_EXPIRY: "bg-purple-500",
  RECURRING_DUE: "bg-slate-400",
};

/** Phase 5: the in-app notification center (top bar). */
export function NotificationBell() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const items = useNotifications();
  useNotificationToasts(items);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        className="relative rounded-lg p-2 text-slate-500 transition-colors hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
        title={t("notifications.title")}
        onClick={() => setOpen((o) => !o)}
      >
        <Bell size={17} />
        {items.length > 0 && (
          <span className="absolute -end-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[9px] font-bold text-white">
            {items.length > 99 ? "99+" : items.length}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute end-0 top-full z-50 mt-1 w-96 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl dark:border-slate-700 dark:bg-slate-900">
          <p className="border-b border-slate-100 px-3 py-2 text-xs font-semibold text-slate-500 dark:border-slate-800">
            {t("notifications.title")} {items.length > 0 && `(${items.length})`}
          </p>
          <div className="max-h-96 overflow-y-auto">
            {items.length === 0 ? (
              <p className="px-3 py-6 text-center text-xs text-slate-400">{t("notifications.empty")}</p>
            ) : (
              items.map((item) => (
                <button
                  key={item.key}
                  className="flex w-full items-start gap-2 border-b border-slate-50 px-3 py-2 text-start transition-colors hover:bg-slate-50 dark:border-slate-800/50 dark:hover:bg-slate-800"
                  onClick={() => {
                    setOpen(false);
                    navigate(item.to);
                  }}
                >
                  <span className={cx("mt-1.5 h-2 w-2 shrink-0 rounded-full", KIND_DOT[item.kind])} />
                  <span className="min-w-0">
                    <span className="block text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                      {t(`notifications.kind.${item.kind}`)}
                    </span>
                    <span className="block truncate text-sm font-medium">{item.title}</span>
                    <span className="block truncate text-xs text-slate-500">{item.detail}</span>
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
