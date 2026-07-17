import "react-native-url-polyfill/auto";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";

/**
 * The mobile app talks to the SAME Supabase project the desktop syncs to.
 * URL + anon key are entered once on first run and kept in AsyncStorage;
 * the auth session is persisted by supabase-js through AsyncStorage too.
 */

const URL_KEY = "namaa.supabase.url";
const ANON_KEY = "namaa.supabase.anonKey";
const LANG_KEY = "namaa.language";

export interface SyncConfig {
  url: string;
  anonKey: string;
}

let cached: { key: string; client: SupabaseClient } | null = null;

export async function loadConfig(): Promise<SyncConfig | null> {
  const [url, anonKey] = await Promise.all([AsyncStorage.getItem(URL_KEY), AsyncStorage.getItem(ANON_KEY)]);
  return url && anonKey ? { url, anonKey } : null;
}

export async function saveConfig(config: SyncConfig): Promise<void> {
  await Promise.all([AsyncStorage.setItem(URL_KEY, config.url), AsyncStorage.setItem(ANON_KEY, config.anonKey)]);
  cached = null;
}

export async function loadLanguage(): Promise<"ar" | "en"> {
  return ((await AsyncStorage.getItem(LANG_KEY)) as "ar" | "en") ?? "ar";
}

export async function saveLanguage(lang: "ar" | "en"): Promise<void> {
  await AsyncStorage.setItem(LANG_KEY, lang);
}

export function getClient(config: SyncConfig): SupabaseClient {
  const key = `${config.url}::${config.anonKey}`;
  if (cached?.key !== key) {
    cached = {
      key,
      client: createClient(config.url, config.anonKey, {
        auth: {
          storage: AsyncStorage,
          autoRefreshToken: true,
          persistSession: true,
          detectSessionInUrl: false,
        },
      }),
    };
  }
  return cached.client;
}

export async function getSession(config: SyncConfig): Promise<Session | null> {
  const { data } = await getClient(config).auth.getSession();
  return data.session;
}
