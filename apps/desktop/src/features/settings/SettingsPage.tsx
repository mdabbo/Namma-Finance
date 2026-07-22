import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CloudUpload, DatabaseBackup, Languages, Coins, Info, Lock, Tags, Plus, RefreshCw, UsersRound } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { useSettings, useUpdateSetting } from "../../lib/settings";
import { useRole, type Role } from "../../lib/roles";
import { getSyncClient } from "../../lib/sync/client";
import { disableLock, isLockEnabled, lockErrorMessageKey, setLockPassword } from "../../lib/lock";
import { useCurrencyMutations, useCurrencyRates } from "../../repositories/currencies";
import { useCategories, useExpenseMutations } from "../../repositories/expenses";
import { useBackupMutations, useBackups } from "../../repositories/backups";
import { invalidateSyncClient, useLastSyncReport, useSyncMutations, useSyncSession } from "../../repositories/sync";
import { Button, Card, Field, Input, Select, cx } from "../../components/ui";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { useFormat } from "../../lib/format";
import { listOpenSyncConflicts, resolveSyncConflict, type SyncConflictResolution } from "../../repositories/syncConflicts";
import { loadReleaseInfo } from "../../lib/release";

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
  const { data: releaseInfo } = useQuery({ queryKey: ["release-info"], queryFn: loadReleaseInfo, staleTime: Infinity });

  const [newCategory, setNewCategory] = useState({ nameAr: "", nameEn: "" });
  const [confirmRestore, setConfirmRestore] = useState(false);
  const role = useRole();
  // engineers: personal preferences only
  const full = role !== "ENGINEER";

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
            {(["contractNumberPrefix", "certificateNumberPrefix", "paymentNumberPrefix", "expenseNumberPrefix"] as const).map((key) => (
              <Field key={key} label={t(`settings.${key}`)}>
                <Input
                  defaultValue={settings?.[key] ?? ""}
                  dir="ltr"
                  maxLength={12}
                  onBlur={(e) => {
                    const value = e.target.value.trim().toUpperCase();
                    if (/^[A-Z0-9]{1,12}$/.test(value) && value !== settings?.[key]) updateSetting.mutate({ key, value });
                  }}
                />
              </Field>
            ))}
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
          <SectionTitle icon={<Info size={16} />} title={t("settings.releaseInfo")} />
          <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
            <ReleaseValue label={t("settings.applicationVersion")} value={releaseInfo?.appVersion ?? "—"} />
            <ReleaseValue label={t("settings.releaseChannel")} value={releaseInfo ? t(`settings.releaseChannels.${releaseInfo.channel}`) : "—"} />
            <ReleaseValue label={t("settings.databaseSchemaVersion")} value={releaseInfo ? String(releaseInfo.schemaVersion) : "—"} />
          </dl>
          {releaseInfo && releaseInfo.schemaVersion !== releaseInfo.expectedSchemaVersion && (
            <p className="mt-3 text-xs font-medium text-red-600" role="alert">
              {t("settings.schemaMismatch", { expected: releaseInfo.expectedSchemaVersion, actual: releaseInfo.schemaVersion })}
            </p>
          )}
        </Card>

        {full && (
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
        )}

        {full && (
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

        )}

        <SecuritySection />

        <SyncSection />

        {role === "ADMIN" && <UsersSection />}

        {full && (
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
          <Field label={t("settings.backupRetention")} className="mb-4 max-w-xs">
            <Input key={settings?.backupRetentionCount ?? 14} type="number" min={1} max={365} defaultValue={settings?.backupRetentionCount ?? 14} onBlur={(e) => { const value=Math.min(365,Math.max(1,Number(e.target.value)||14)); if(value!==settings?.backupRetentionCount) updateSetting.mutate({key:"backupRetentionCount",value}); }} />
          </Field>
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
                    <span dir="ltr" className="truncate" title={b.sha256Checksum??undefined}>{b.filename}</span>
                    <span className="shrink-0 tnum">{fmt.date(b.createdAt.slice(0, 10))} · {b.backupType} · v{b.databaseVersion??"?"}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {(backupMutations.backupNow.error || backupMutations.restore.error) && (
            <p className="mt-3 text-xs text-red-600" dir="ltr">{String((backupMutations.backupNow.error ?? backupMutations.restore.error) instanceof Error ? (backupMutations.backupNow.error ?? backupMutations.restore.error as Error).message : (backupMutations.backupNow.error ?? backupMutations.restore.error))}</p>
          )}
        </Card>
        )}
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

function ReleaseValue({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-slate-400">{label}</dt>
      <dd className="mt-1 font-semibold tnum" dir="auto">{value}</dd>
    </div>
  );
}

/**
 * App lock: password gate at launch (per device), derived with Argon2id in
 * Rust. This is explicitly not database encryption.
 */
function SecuritySection() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data: enabled = false } = useQuery({ queryKey: ["app-lock"], queryFn: isLockEnabled });
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const reset = () => {
    setCurrent("");
    setNext("");
    setConfirm("");
    void qc.invalidateQueries({ queryKey: ["app-lock"] });
  };

  async function save(disable: boolean) {
    setMessage(null);
    try {
      if (disable) {
        await disableLock(current);
        setMessage({ ok: true, text: t("lock.disabled") });
      } else {
        if (next.length < 8 || next !== confirm) {
          setMessage({ ok: false, text: t("lock.mismatch") });
          return;
        }
        await setLockPassword(next, enabled ? current : undefined);
        setMessage({ ok: true, text: t("lock.saved") });
      }
      reset();
    } catch (error) {
      setMessage({ ok: false, text: t(`lock.${lockErrorMessageKey(error)}`) });
    }
  }

  return (
    <Card className="p-5">
      <SectionTitle icon={<Lock size={16} />} title={t("lock.sectionTitle")} />
      <p className="mb-3 text-xs text-slate-400">{t("lock.hint")}</p>
      <div className="flex flex-wrap items-end gap-3">
        {enabled && (
          <Field label={t("lock.current")} className="w-56">
            <Input dir="ltr" type="password" value={current} onChange={(e) => setCurrent(e.target.value)} />
          </Field>
        )}
        <Field label={enabled ? t("lock.new") : t("lock.password")} className="w-56">
          <Input dir="ltr" type="password" value={next} onChange={(e) => setNext(e.target.value)} />
        </Field>
        <Field label={t("lock.confirm")} className="w-56">
          <Input dir="ltr" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </Field>
        <Button variant="primary" disabled={next === ""} onClick={() => void save(false)}>
          {enabled ? t("lock.change") : t("lock.enable")}
        </Button>
        {enabled && (
          <Button className="!text-red-600" onClick={() => void save(true)}>
            {t("lock.disable")}
          </Button>
        )}
      </div>
      {message && <p className={cx("mt-2 text-xs", message.ok ? "text-emerald-600" : "text-red-600")}>{message.text}</p>}
    </Card>
  );
}

/**
 * Phase 5: office users & roles (admin only). Logins themselves are created
 * in the Supabase dashboard (Authentication → Users); this panel assigns
 * each login its app role.
 */
interface UserRoleRow {
  user_id: string;
  email: string;
  display_name: string | null;
  role: Role;
}

function UsersSection() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data: rows = [], error } = useQuery({
    queryKey: ["user-roles"],
    queryFn: async (): Promise<UserRoleRow[]> => {
      const client = await getSyncClient();
      const { data, error: qError } = await client.from("user_roles").select("user_id, email, display_name, role").order("email");
      if (qError) throw new Error(qError.message);
      return (data ?? []) as UserRoleRow[];
    },
    retry: 0,
  });
  const setRole = useMutation({
    mutationFn: async (v: { userId: string; role: Role }) => {
      const client = await getSyncClient();
      const { error: uError } = await client
        .from("user_roles")
        .update({ role: v.role, updated_at: new Date().toISOString() })
        .eq("user_id", v.userId);
      if (uError) throw new Error(uError.message);
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["user-roles"] }),
  });

  return (
    <Card className="p-5">
      <SectionTitle icon={<UsersRound size={16} />} title={t("settings.usersTitle")} />
      <p className="mb-3 text-xs text-slate-400">{t("settings.usersHint")}</p>
      {error && <p className="mb-2 text-xs text-red-600">{(error as Error).message}</p>}
      <div className="space-y-2">
        {rows.map((row) => (
          <div key={row.user_id} className="flex items-center gap-3">
            <span className="w-72 truncate text-sm" dir="ltr">{row.email}</span>
            <Select
              className="!w-44"
              value={row.role}
              disabled={setRole.isPending}
              onChange={(e) => setRole.mutate({ userId: row.user_id, role: e.target.value as Role })}
            >
              {(["ADMIN", "ACCOUNTANT", "ENGINEER"] as const).map((r) => (
                <option key={r} value={r}>{t(`roles.${r}`)}</option>
              ))}
            </Select>
          </div>
        ))}
        {rows.length === 0 && !error && <p className="text-xs text-slate-400">{t("common.empty")}</p>}
      </div>
    </Card>
  );
}

/** Phase 3: Supabase cloud sync — connection, sign-in, manual & auto sync. */
function SyncSection() {
  const { t } = useTranslation();
  const role = useRole();
  const fmt = useFormat();
  const queryClient = useQueryClient();
  const { data: conflicts = [] } = useQuery({ queryKey: ["sync-conflicts"], queryFn: listOpenSyncConflicts });
  const [conflictNote, setConflictNote] = useState("");
  const resolveConflict = useMutation({
    mutationFn: ({ id, resolution }: { id: number; resolution: SyncConflictResolution }) => resolveSyncConflict(id, resolution, conflictNote),
    onSuccess: () => { setConflictNote(""); queryClient.invalidateQueries({ queryKey: ["sync-conflicts"] }); },
  });
  const { data: settings } = useSettings();
  const updateSetting = useUpdateSetting();
  const { data: session } = useSyncSession();
  const { data: lastReport } = useLastSyncReport();
  const sync = useSyncMutations();
  const [login, setLogin] = useState({ email: "", password: "" });

  const configured = !!settings?.syncUrl && !!settings?.syncAnonKey;

  return (
    <Card className="p-5">
      <SectionTitle icon={<CloudUpload size={16} />} title={t("settings.syncTitle")} />
      <p className="mb-4 text-xs text-slate-400">{t("settings.syncNote")}</p>

      <div className="mb-4 grid grid-cols-2 gap-4">
        <Field label={t("settings.syncUrl")}>
          <Input
            dir="ltr"
            placeholder="https://xxxx.supabase.co"
            defaultValue={settings?.syncUrl ?? ""}
            onBlur={(e) => {
              const value = e.target.value.trim();
              if (value !== settings?.syncUrl) {
                updateSetting.mutate({ key: "syncUrl", value });
                invalidateSyncClient();
              }
            }}
          />
        </Field>
        <Field label={t("settings.syncAnonKey")}>
          <Input
            dir="ltr"
            type="password"
            placeholder="eyJ…"
            defaultValue={settings?.syncAnonKey ?? ""}
            onBlur={(e) => {
              const value = e.target.value.trim();
              if (value !== settings?.syncAnonKey) {
                updateSetting.mutate({ key: "syncAnonKey", value });
                invalidateSyncClient();
              }
            }}
          />
        </Field>
      </div>

      {configured && !session && (
        <div className="mb-4 flex items-end gap-3">
          <Field label={t("settings.syncEmail")} className="w-64">
            <Input
              dir="ltr"
              type="email"
              value={login.email || settings?.syncEmail || ""}
              onChange={(e) => setLogin((l) => ({ ...l, email: e.target.value }))}
            />
          </Field>
          <Field label={t("settings.syncPassword")} className="w-64">
            <Input
              dir="ltr"
              type="password"
              value={login.password}
              onChange={(e) => setLogin((l) => ({ ...l, password: e.target.value }))}
            />
          </Field>
          <Button
            variant="primary"
            disabled={sync.signIn.isPending || !login.password || !(login.email || settings?.syncEmail)}
            onClick={() => {
              const email = login.email || settings?.syncEmail || "";
              sync.signIn.mutate(
                { email, password: login.password },
                {
                  onSuccess: () => {
                    updateSetting.mutate({ key: "syncEmail", value: email });
                    setLogin({ email: "", password: "" });
                  },
                },
              );
            }}
          >
            {t("settings.syncSignIn")}
          </Button>
          {sync.signIn.isError && (
            <span className="pb-2 text-xs text-red-600">{(sync.signIn.error as Error).message}</span>
          )}
        </div>
      )}

      {session && (
        <div className="mb-4 flex items-center gap-3">
          <span className="text-sm text-slate-500">
            {t("settings.syncSignedInAs")} <b dir="ltr">{session.user.email}</b>
          </span>
          <Button variant="ghost" onClick={() => sync.signOut.mutate()}>{t("settings.syncSignOut")}</Button>
        </div>
      )}

      {session && (
        <div className="flex flex-wrap items-center gap-4">
          <Button variant="primary" disabled={sync.run.isPending} onClick={() => sync.run.mutate()}>
            <RefreshCw size={14} className={sync.run.isPending ? "animate-spin" : ""} />
            {t("settings.syncNow")}
          </Button>
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={settings?.syncAuto ?? false}
              onChange={(e) => updateSetting.mutate({ key: "syncAuto", value: e.target.checked })}
            />
            {t("settings.syncAuto")}
          </label>
        </div>
      )}

      {(sync.run.data ?? lastReport) && (
        <SyncReportLine report={(sync.run.data ?? lastReport)!} dateFmt={(d: string) => `${fmt.date(d.slice(0, 10))} ${d.slice(11, 16)}`} />
      )}
      {role !== "ENGINEER" && conflicts.length > 0 && (
        <div className="mt-4 rounded-xl border border-amber-300 bg-amber-50 p-3 dark:bg-amber-950/20">
          <p className="mb-2 text-sm font-semibold text-amber-800 dark:text-amber-200">{t("settings.syncConflicts")}</p>
          <Input value={conflictNote} onChange={(e) => setConflictNote(e.target.value)} placeholder={t("settings.syncConflictReason")} />
          {conflicts.map((conflict) => (
            <div key={conflict.id} className="mt-2 rounded-lg border border-amber-200 p-2 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span dir="ltr">{conflict.table_name} · {conflict.row_uuid.slice(0, 8)} · {conflict.conflict_kind}</span>
                <div className="flex gap-2">
                  <Button disabled={!conflictNote.trim()} onClick={() => resolveConflict.mutate({ id: conflict.id, resolution: "KEEP_LOCAL" })}>{conflict.conflict_kind === "DUPLICATE_RECORD" ? t("settings.syncRenumberKeepBoth") : t("settings.syncKeepLocal")}</Button>
                  {conflict.conflict_kind !== "DUPLICATE_RECORD" && <Button disabled={!conflictNote.trim()} onClick={() => resolveConflict.mutate({ id: conflict.id, resolution: "KEEP_REMOTE" })}>{t("settings.syncKeepRemote")}</Button>}
                </div>
              </div>
              <details className="mt-2">
                <summary className="cursor-pointer">{t("settings.syncCompareVersions")}</summary>
                <div className="mt-2 grid gap-2 md:grid-cols-2" dir="ltr">
                  <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-white p-2 dark:bg-slate-900">{JSON.stringify(JSON.parse(conflict.local_json), null, 2)}</pre>
                  <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-white p-2 dark:bg-slate-900">{JSON.stringify(JSON.parse(conflict.remote_json), null, 2)}</pre>
                </div>
              </details>
            </div>
          ))}
          {resolveConflict.isError && <p className="mt-2 text-xs text-red-600">{(resolveConflict.error as Error).message}</p>}
        </div>
      )}
    </Card>
  );
}

function SyncReportLine({
  report,
  dateFmt,
}: {
  report: { finishedAt: string; ok: boolean; pulled: number; pushed: number; deletedLocal: number; deletedRemote: number; error?: string };
  dateFmt: (iso: string) => string;
}) {
  const { t } = useTranslation();
  return (
    <p className={cx("mt-3 text-xs", report.ok ? "text-slate-400" : "text-red-600")}>
      {t("settings.syncLast")}: {dateFmt(report.finishedAt)} —{" "}
      {report.ok
        ? `${t("settings.syncOk")} · ${t("settings.syncPulled")}: ${report.pulled + report.deletedLocal} · ${t("settings.syncPushed")}: ${report.pushed + report.deletedRemote}`
        : `${t("settings.syncFailed")}: ${report.error}`}
    </p>
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
