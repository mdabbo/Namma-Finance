import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { execute, select } from "./db";
import { switchLanguage } from "./i18n";

export interface AppSettings {
  language: "ar" | "en";
  theme: "light" | "dark";
  projectCodePrefix: string;
  lastAutoBackupDate: string;
  /** Currency the dashboard and consolidated totals are displayed in. */
  baseCurrency: "EGP" | "SAR" | "USD";
  /** Optional extra folder (e.g. Google Drive) that daily backups are copied into. */
  backupFolder: string;
  /** How office overhead is allocated to projects for net-profit reporting. */
  overheadRule: "REVENUE" | "DIRECT_COST" | "EVEN";
  /** Phase 3 cloud sync (Supabase). The anon key is public-safe; RLS guards the data. */
  syncUrl: string;
  syncAnonKey: string;
  syncEmail: string;
  syncAuto: boolean;
  /** Cached cloud role (ADMIN/ACCOUNTANT/ENGINEER); empty = never fetched. */
  syncRole: string;
}

const DEFAULTS: AppSettings = {
  language: "ar",
  theme: "light",
  projectCodePrefix: "PRJ",
  lastAutoBackupDate: "",
  baseCurrency: "EGP",
  backupFolder: "",
  overheadRule: "REVENUE",
  syncUrl: "",
  syncAnonKey: "",
  syncEmail: "",
  syncAuto: false,
  syncRole: "",
};

const KEY_MAP: Record<keyof AppSettings, string> = {
  language: "language",
  theme: "theme",
  projectCodePrefix: "project_code_prefix",
  lastAutoBackupDate: "last_auto_backup_date",
  baseCurrency: "base_currency",
  backupFolder: "backup_folder",
  overheadRule: "overhead_rule",
  syncUrl: "sync_url",
  syncAnonKey: "sync_anon_key",
  syncEmail: "sync_email",
  syncAuto: "sync_auto",
  syncRole: "sync_role",
};

export async function loadSettings(): Promise<AppSettings> {
  const rows = await select<{ key: string; value: string }>("SELECT key, value FROM settings");
  const map = new Map(rows.map((r) => [r.key, r.value]));
  return {
    language: (map.get("language") as AppSettings["language"]) || DEFAULTS.language,
    theme: (map.get("theme") as AppSettings["theme"]) || DEFAULTS.theme,
    projectCodePrefix: map.get("project_code_prefix") || DEFAULTS.projectCodePrefix,
    lastAutoBackupDate: map.get("last_auto_backup_date") ?? "",
    baseCurrency: (map.get("base_currency") as AppSettings["baseCurrency"]) || DEFAULTS.baseCurrency,
    backupFolder: map.get("backup_folder") ?? "",
    overheadRule: (map.get("overhead_rule") as AppSettings["overheadRule"]) || DEFAULTS.overheadRule,
    syncUrl: map.get("sync_url") ?? "",
    syncAnonKey: map.get("sync_anon_key") ?? "",
    syncEmail: map.get("sync_email") ?? "",
    syncAuto: map.get("sync_auto") === "true",
    syncRole: map.get("sync_role") ?? "",
  };
}

export async function saveSetting<K extends keyof AppSettings>(key: K, value: AppSettings[K]): Promise<void> {
  await execute(
    "INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value = $2",
    [KEY_MAP[key], String(value)],
  );
}

export function applyTheme(theme: "light" | "dark"): void {
  document.documentElement.classList.toggle("dark", theme === "dark");
}

export function useSettings() {
  return useQuery({ queryKey: ["settings"], queryFn: loadSettings });
}

type SettingUpdate = { [K in keyof AppSettings]: { key: K; value: AppSettings[K] } }[keyof AppSettings];

export function useUpdateSetting() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: SettingUpdate) => {
      await saveSetting(input.key, input.value);
      if (input.key === "language") await switchLanguage(input.value);
      if (input.key === "theme") applyTheme(input.value);
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["settings"] }),
  });
}
