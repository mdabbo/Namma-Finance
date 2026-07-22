import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";
import { loadSettings, saveSetting } from "../settings";

/**
 * One Supabase client per (url, anon key) pair. The anon key is designed to
 * ship in clients; row-level security on the backend is what protects the
 * data. Auth sessions are memory-only; tokens are never persisted in
 * localStorage or the application settings database.
 */

let cached: { key: string; client: SupabaseClient } | null = null;

export class SyncNotConfiguredError extends Error {
  constructor() {
    super("sync backend not configured");
  }
}

export async function getSyncClient(): Promise<SupabaseClient> {
  const settings = await loadSettings();
  if (!settings.syncUrl || !settings.syncAnonKey) throw new SyncNotConfiguredError();
  const key = `${settings.syncUrl}::${settings.syncAnonKey}`;
  if (cached?.key !== key) {
    cached = {
      key,
      client: createClient(settings.syncUrl, settings.syncAnonKey, {
        auth: { persistSession: false, autoRefreshToken: true, detectSessionInUrl: false },
      }),
    };
  }
  return cached.client;
}

/** Drop the cached client (after the user edits the URL/key). */
export function resetSyncClient(): void {
  cached = null;
}

export async function getSyncSession(): Promise<Session | null> {
  try {
    const client = await getSyncClient();
    const { data } = await client.auth.getSession();
    if (data.session?.user.id) await saveSetting("syncUserId", data.session.user.id);
    return data.session;
  } catch (e) {
    if (e instanceof SyncNotConfiguredError) return null;
    throw e;
  }
}

export async function syncSignIn(email: string, password: string): Promise<void> {
  const client = await getSyncClient();
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(error.message);
  await saveSetting("syncUserId", data.user.id);
}

export async function syncSignOut(): Promise<void> {
  const client = await getSyncClient();
  await client.auth.signOut();
  await saveSetting("syncUserId", "");
}
