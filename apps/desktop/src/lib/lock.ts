import { execute, select } from "./db";

/**
 * App lock: a password gate shown at launch (per device). The password is
 * stored only as a PBKDF2-SHA256 hash + random salt in the local settings
 * table. This protects the app's door on a shared PC — it does NOT encrypt
 * the database file on disk.
 *
 * Recovery: when cloud sync is configured, signing in with the office
 * Supabase account also unlocks (see LockScreen).
 */

const ITERATIONS = 100_000;

const toHex = (buf: ArrayBuffer): string =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

const fromHex = (hex: string): Uint8Array =>
  new Uint8Array(hex.match(/.{2}/g)?.map((b) => parseInt(b, 16)) ?? []);

async function derive(password: string, salt: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations: ITERATIONS },
    key,
    256,
  );
  return toHex(bits);
}

async function getSetting(key: string): Promise<string> {
  const rows = await select<{ value: string }>("SELECT value FROM settings WHERE key = $1", [key]);
  return rows[0]?.value ?? "";
}

async function putSetting(key: string, value: string): Promise<void> {
  await execute("INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value = $2", [key, value]);
}

export async function isLockEnabled(): Promise<boolean> {
  return (await getSetting("app_lock_hash")) !== "";
}

export async function setLockPassword(password: string): Promise<void> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(password, salt);
  await putSetting("app_lock_salt", toHex(salt.buffer));
  await putSetting("app_lock_hash", hash);
}

export async function verifyLockPassword(password: string): Promise<boolean> {
  const [hash, salt] = await Promise.all([getSetting("app_lock_hash"), getSetting("app_lock_salt")]);
  if (!hash || !salt) return true; // lock not set
  return (await derive(password, fromHex(salt))) === hash;
}

export async function disableLock(): Promise<void> {
  await putSetting("app_lock_hash", "");
  await putSetting("app_lock_salt", "");
}
