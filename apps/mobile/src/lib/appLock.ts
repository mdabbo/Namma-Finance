/**
 * When the phone app asks for the phone's own lock (fingerprint, face, or the
 * phone's PIN/pattern) before showing anything.
 *
 * - Opening the app from closed always asks.
 * - Coming back after LOCK_AFTER_MS or more in the background asks.
 * - A short trip to another app (a call, a message) does not.
 *
 * The lock hides the screens; it does not encrypt anything. Data on the phone
 * is what the cloud returns to the signed-in login.
 *
 * No React Native here, so the desktop test suite can hold the rules in place
 * (apps/desktop/test/mobile-app-lock.test.ts).
 */

export const LOCK_AFTER_MS = 60_000;

/** Stored as "1"/"0"; missing means "on when the phone has a screen lock". */
export const LOCK_SETTING_KEY = "namaa.appLock";

/** Mirrors SecurityLevel in expo-local-authentication. */
export const SECURITY_NONE = 0;

/**
 * Whether the lock is on. With no stored choice it is on whenever the phone
 * has any screen lock, because the owner asked for a lock on reopen. A phone
 * with no screen lock cannot be asked, so the lock is off there.
 */
export function lockEnabled(stored: string | null, securityLevel: number): boolean {
  if (securityLevel <= SECURITY_NONE) return false;
  return stored !== "0";
}

/**
 * Whether coming back to the front should lock. `backgroundAt` is when the app
 * last went to the background (null if it has not since the last unlock).
 */
export function lockOnResume(backgroundAt: number | null, now: number): boolean {
  if (backgroundAt === null) return false;
  // A clock that moved backwards (time zone or manual change) locks, to be safe.
  const away = now - backgroundAt;
  return away < 0 || away >= LOCK_AFTER_MS;
}
