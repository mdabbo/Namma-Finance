import { select } from "./db";

/**
 * End-to-end stand-in for the Rust-backed app lock (see lib/lock.ts).
 *
 * The real lock is deliberately enforced in Rust — Argon2 verification and
 * attempt throttling never enter the WebView — so a browser has no way to
 * invoke it and the app fails closed on the lock screen, which would block
 * every UI spec.
 *
 * This bridge answers only the state question, reading the SAME settings rows
 * `read_lock_credentials` reads and applying the same rules, so a fresh
 * workspace reports "no lock" exactly as the desktop app does. Password
 * verification stays unavailable here on purpose: it belongs to the Rust suite
 * (argon2 verification, throttling, corrupt-state handling), not to a browser
 * where a stubbed implementation would prove nothing.
 */

export async function isLockEnabled(): Promise<boolean> {
  const rows = await select<{ key: string; value: string }>(
    "SELECT key, value FROM settings WHERE key IN ('app_lock_credential','app_lock_hash','app_lock_salt')",
  );
  const value = (key: string) => {
    const found = rows.find((row) => row.key === key)?.value;
    return found ? found : null;
  };
  const credential = value("app_lock_credential");
  const legacyHash = value("app_lock_hash");
  const legacySalt = value("app_lock_salt");
  if (credential === null && legacyHash === null && legacySalt === null) return false;
  if (credential !== null && credential.startsWith("$argon2id$")) return true;
  if (credential === null && legacyHash !== null && legacySalt !== null) return true;
  throw new Error("LOCK_STATE_CORRUPT");
}

function unavailable(): never {
  throw new Error("LOCK_MUTATION_UNAVAILABLE_IN_E2E");
}

export async function setLockPassword(): Promise<void> {
  unavailable();
}

export async function verifyLockPassword(): Promise<boolean> {
  unavailable();
}

export async function disableLock(): Promise<void> {
  unavailable();
}

export { lockErrorMessageKey } from "./lock";
