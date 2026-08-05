import { invoke } from "@tauri-apps/api/core";
import { runInTransaction } from "./db";

/**
 * The single seam between a multi-statement write and the transaction that
 * makes it one fact.
 *
 * Every such write used to spell its own branch — `if (Tauri) invoke(x_atomic)
 * else BEGIN IMMEDIATE …` — and the two halves drifted apart unnoticed,
 * because nothing in the test suite ever took the first branch. Routing them
 * all through one function makes the choice testable in one place and makes
 * the second half's status explicit: it is a TEST DOUBLE, not a fallback.
 *
 * In the shipped app `hasTauriRuntime()` is always true, so the Rust command is
 * always what runs. The double exists so the vitest harness and the Playwright
 * bridge — neither of which can execute Rust — can still drive repository code
 * against a real SQLite engine. It must never be reachable from a build:
 * `test/atomic-dispatch.test.ts` asserts every caller dispatches to its Rust
 * command when a Tauri runtime is present, and never touches the double.
 *
 * The double gets its atomicity from `runInTransaction`, which the database
 * layer owns. It does not issue BEGIN/COMMIT as SQL — `assertRestrictedSql`
 * refuses transaction control from the WebView, in the bridge exactly as in
 * production.
 */
export function hasTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function atomicCommand<T>(
  command: string,
  args: Record<string, unknown>,
  testDouble: () => Promise<T>,
): Promise<T> {
  if (hasTauriRuntime()) return invoke<T>(command, args);
  return runInTransaction(testDouble);
}

/**
 * A Rust command with no test double, for work that cannot exist outside the
 * desktop runtime at all (file system, OS keychain, process control).
 */
export function desktopCommand<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!hasTauriRuntime()) throw new Error(`DESKTOP_COMMAND_UNAVAILABLE: ${command}`);
  return invoke<T>(command, args);
}
