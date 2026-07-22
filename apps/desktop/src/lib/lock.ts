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
