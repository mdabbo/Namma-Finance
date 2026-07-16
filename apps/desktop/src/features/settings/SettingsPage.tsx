import { useState } from "react";
import { useTranslation } from "react-i18next";
import { DatabaseBackup, Languages, Coins, Tags, Plus, RefreshCw } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { useSettings, useUpdateSetting } from "../../lib/settings";
import { useCurrencyMutations, useCurrencyRates } from "../../repositories/currencies";
import { useCategories, useExpenseMutations } from "../../repositories/expenses";
import { useBackupMutations, useBackups } from "../../repositories/backups";
import { Button, Card, Field, Input, Select, cx } from "../../components/ui";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { useFormat } from "../../lib/format";

export function SettingsPage() {
  const { t, i18n } = useTranslation();
  const fmt = useFormat();
  const { data: settings } = useSettings();
  const updateSetting = useUpdateSetting();
  const { data: rates = [] } = useCurrencyRates();
  const currencyMutations = useCurrencyMutations();
  const { data: categories = [] } = useCategories(true);
  const expenseMutations = useExpenseMutations();
  const { data: backups = [] } = useBackups();
  const backupMutations = useBackupMutations();

  const [newCategory, setNewCategory] = useState({ nameAr: "", nameEn: "" });
  const [confirmRestore, setConfirmRestore] = useState(false);

  return (
    <div className="max-w-4xl">
      <h1 className="mb-4 text-xl font-semibold">{t("settings.title")}</h1>

      <div className="space-y-4">
        <Card className="p-5">
          <SectionTitle icon={<Languages size={16} />} title={t("settings.general")} />
          <div className="grid grid-cols-3 gap-4">
            <Field label={t("settings.language")}>
              <Select
                value={settings?.language ?? "ar"}
                onChange={(e) => updateSetting.mutate({ key: "language", value: e.target.value as "ar" | "en" })}
              >
                <option value="ar">{t("settings.arabic")}</option>
                <option value="en">{t("settings.english")}</option>
              </Select>
            </Field>
            <Field label={t("settings.theme")}>
              <Select
                value={settings?.theme ?? "light"}
                onChange={(e) => updateSetting.mutate({ key: "theme", value: e.target.value as "light" | "dark" })}
              >
                <option value="light">{t("settings.light")}</option>
                <option value="dark">{t("settings.dark")}</option>
              </Select>
            </Field>
            <Field label={t("settings.projectCodePrefix")}>
              <Input
                defaultValue={settings?.projectCodePrefix ?? "PRJ"}
                dir="ltr"
                onBlur={(e) => {
                  const value = e.target.value.trim().toUpperCase() || "PRJ";
                  if (value !== settings?.projectCodePrefix) updateSetting.mutate({ key: "projectCodePrefix", value });
                }}
              />
            </Field>
            <Field label={t("settings.baseCurrency")}>
              <Select
                value={settings?.baseCurrency ?? "EGP"}
                onChange={(e) => updateSetting.mutate({ key: "baseCurrency", value: e.target.value as "EGP" | "SAR" | "USD" })}
              >
                <option value="EGP">EGP</option>
                <option value="SAR">SAR</option>
                <option value="USD">USD</option>
              </Select>
              <p className="mt-1 text-xs text-slate-400">{t("settings.baseCurrencyNote")}</p>
            </Field>
          </div>
        </Card>

        <Card className="p-5">
          <SectionTitle icon={<Coins size={16} />} title={t("settings.currencies")} />
          <div className="mb-4 flex items-center gap-3">
            <Button
              variant="primary"
              disabled={currencyMutations.syncFromCbe.isPending}
              onClick={() => currencyMutations.syncFromCbe.mutate()}
            >
              <RefreshCw size={14} className={currencyMutations.syncFromCbe.isPending ? "animate-spin" : ""} />
              {t("settings.syncRates")}
            </Button>
            {currencyMutations.syncFromCbe.isSuccess && (
              <span className="text-xs text-emerald-600 dark:text-emerald-400">{t("settings.ratesUpdated")}</span>
            )}
            {currencyMutations.syncFromCbe.isError && (
              <span className="text-xs text-red-600">{t("settings.ratesFailed")}</span>
            )}
          </div>
          <p className="mb-3 text-xs text-slate-400">{t("settings.syncRatesNote")}</p>
          <div className="grid grid-cols-2 gap-x-8 gap-y-2">
            {rates.map((rate) => (
              <div key={rate.code} className="flex items-center gap-3">
                <span className="w-12 text-sm font-semibold tnum">{rate.code}</span>
                <span className="text-xs text-slate-400">{t("settings.ratePerEgp")} {rate.code}:</span>
                <Input
                  dir="ltr"
                  className="!w-32 text-end tnum"
                  disabled={rate.code === "EGP"}
                  defaultValue={rate.fxRateMicro / 1_000_000}
                  onBlur={(e) => {
                    const v = Number(e.target.value);
                    const micro = Math.round(v * 1_000_000);
                    if (Number.isFinite(v) && v > 0 && micro !== rate.fxRateMicro) {
                      currencyMutations.updateRate.mutate({ code: rate.code, fxRateMicro: micro });
                    }
                  }}
                />
              </div>
            ))}
          </div>
        </Card>

        <Card className="p-5">
          <SectionTitle icon={<Tags size={16} />} title={t("settings.expenseCategories")} />
          <div className="space-y-2">
            {categories.map((cat) => (
              <div key={cat.id} className={cx("flex items-center gap-3", !cat.isActive && "opacity-50")}>
                <Input
                  className="!w-56"
                  defaultValue={cat.nameAr}
                  onBlur={(e) => {
                    if (e.target.value !== cat.nameAr)
                      expenseMutations.updateCategory.mutate({ id: cat.id, nameAr: e.target.value, nameEn: cat.nameEn, isActive: cat.isActive });
                  }}
                />
                <Input
                  className="!w-56"
                  dir="ltr"
                  defaultValue={cat.nameEn}
                  onBlur={(e) => {
                    if (e.target.value !== cat.nameEn)
                      expenseMutations.updateCategory.mutate({ id: cat.id, nameAr: cat.nameAr, nameEn: e.target.value, isActive: cat.isActive });
                  }}
                />
                <Button
                  variant="ghost"
                  onClick={() =>
                    expenseMutations.updateCategory.mutate({ id: cat.id, nameAr: cat.nameAr, nameEn: cat.nameEn, isActive: !cat.isActive })
                  }
                >
                  {cat.isActive ? t("people.active") : t("people.inactive")}
                </Button>
              </div>
            ))}
            <div className="flex items-center gap-3 border-t border-slate-100 pt-3 dark:border-slate-800">
              <Input
                className="!w-56"
                placeholder={t("settings.categoryNameAr")}
                value={newCategory.nameAr}
                onChange={(e) => setNewCategory((c) => ({ ...c, nameAr: e.target.value }))}
              />
              <Input
                className="!w-56"
                dir="ltr"
                placeholder={t("settings.categoryNameEn")}
                value={newCategory.nameEn}
                onChange={(e) => setNewCategory((c) => ({ ...c, nameEn: e.target.value }))}
              />
              <Button
                variant="primary"
                disabled={!newCategory.nameAr.trim() || !newCategory.nameEn.trim()}
                onClick={() =>
                  expenseMutations.createCategory.mutate(
                    { nameAr: newCategory.nameAr.trim(), nameEn: newCategory.nameEn.trim() },
                    { onSuccess: () => setNewCategory({ nameAr: "", nameEn: "" }) },
                  )
                }
              >
                <Plus size={15} /> {t("expenses.newCategory")}
              </Button>
            </div>
          </div>
        </Card>

        <Card className="p-5">
          <SectionTitle icon={<DatabaseBackup size={16} />} title={t("settings.backup")} />
          <p className="mb-3 text-xs text-slate-400">{t("settings.dailyBackupNote")}</p>
          <Field label={t("settings.backupFolder")} className="mb-1 max-w-xl">
            <div className="flex gap-2">
              <Input value={settings?.backupFolder ?? ""} readOnly dir="ltr" className="flex-1 text-xs" />
              <Button
                onClick={async () => {
                  const dir = await open({ directory: true, multiple: false });
                  if (typeof dir === "string") updateSetting.mutate({ key: "backupFolder", value: dir });
                }}
              >
                {t("settings.chooseFolder")}
              </Button>
              {settings?.backupFolder && (
                <Button variant="ghost" onClick={() => updateSetting.mutate({ key: "backupFolder", value: "" })}>
                  ✕
                </Button>
              )}
            </div>
          </Field>
          <p className="mb-4 text-xs text-slate-400">{t("settings.backupFolderNote")}</p>
          <div className="mb-4 flex gap-2">
            <Button variant="primary" onClick={() => backupMutations.backupNow.mutate()} disabled={backupMutations.backupNow.isPending}>
              {t("settings.backupNow")}
            </Button>
            <Button onClick={() => setConfirmRestore(true)}>{t("settings.restoreBackup")}</Button>
          </div>
          {backups.length > 0 && (
            <div className="max-h-48 overflow-y-auto text-xs">
              <p className="mb-1 font-medium text-slate-500">{t("settings.lastBackup")}:</p>
              <ul className="space-y-1 text-slate-400">
                {backups.map((b) => (
                  <li key={b.id} className="flex justify-between gap-4">
                    <span dir="ltr" className="truncate">{b.path}</span>
                    <span className="shrink-0 tnum">{fmt.date(b.createdAt.slice(0, 10))} · {b.kind}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>
      </div>

      {confirmRestore && (
        <ConfirmDialog
          title={t("settings.restoreBackup")}
          message={t("settings.restoreWarning")}
          confirmLabel={t("common.confirm")}
          busy={backupMutations.restore.isPending}
          onCancel={() => setConfirmRestore(false)}
          onConfirm={() => backupMutations.restore.mutate(undefined, { onSettled: () => setConfirmRestore(false) })}
        />
      )}
      {/* keep i18n import referenced for language-sensitive rerender */}
      <span className="hidden">{i18n.language}</span>
    </div>
  );
}

function SectionTitle({ icon, title }: { icon: React.ReactNode; title: string }) {
  return (
    <div className="mb-4 flex items-center gap-2 text-sm font-semibold">
      <span className="rounded-lg bg-brand-50 p-1.5 text-brand-600 dark:bg-brand-900/40 dark:text-brand-300">{icon}</span>
      {title}
    </div>
  );
}
