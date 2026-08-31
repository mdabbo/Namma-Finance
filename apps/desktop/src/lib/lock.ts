import { invoke } from "@tauri-apps/api/core";

/**
 * Local application-door lock backed by Argon2id in Rust. It protects casual
 * access on a shared Windows account; it does NOT encrypt the SQLite database.
 * Database/volume encryption is a separate commercial deployment option.
 */
export async function isLockEnabled(): Promise<boolean> {
  return invoke<boolean>("app_lock_enabled");
}

export async function setLockPassword(password: string, currentPassword?: string): Promise<void> {
  await invoke("set_app_lock", { password, currentPassword: currentPassword ?? null });
}

export async function verifyLockPassword(password: string): Promise<boolean> {
  return invoke<boolean>("verify_app_lock", { password });
}

export async function disableLock(password: string): Promise<void> {
  await invoke("disable_app_lock", { password });
}

export type LockErrorMessageKey = "wrong" | "mismatch" | "retry" | "databaseBusy" | "failed";

/** Keep credential failures distinct from storage/runtime failures. */
export function lockErrorMessageKey(error: unknown): LockErrorMessageKey {
  const message = error instanceof Error ? error.message : String(error);
  if (/LOCK_PASSWORD_INVALID|CURRENT_PASSWORD_REQUIRED/i.test(message)) return "wrong";
  if (/LOCK_PASSWORD_LENGTH_INVALID/i.test(message)) return "mismatch";
  if (/LOCK_RETRY_AFTER/i.test(message)) return "retry";
  if (/database is locked|\bcode:\s*5\b|APP_DATABASE_UNAVAILABLE|RUNTIME_DATABASE_UNAVAILABLE/i.test(message)) {
    return "databaseBusy";
  }
  return "failed";
}
