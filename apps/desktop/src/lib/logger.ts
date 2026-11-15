/**
 * Application logging.
 *
 * In the desktop app, records go to a rotating file in the app log directory
 * (tauri-plugin-log). Outside Tauri (vitest, the Playwright bridge) they fall
 * back to the console.
 *
 * RULE: a log record never carries amounts, client or person names, or
 * credentials. Callers pass a short constant `context` and the caught error;
 * `describeError` strips the error down to its type and a scrubbed message.
 * `test/logging.test.ts` scans every call site for interpolated values.
 */
import { error as pluginError, warn as pluginWarn, info as pluginInfo } from "@tauri-apps/plugin-log";

const MAX_MESSAGE = 300;

function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Removes anything that could be a business value from free text: quoted
 * strings (names, notes), e-mail addresses, and numbers (amounts, balances).
 * Digits glued to an identifier — `SCHEMA_VERSION_8`, `payments_2` — are kept,
 * so machine codes stay readable.
 */
export function scrubText(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]")
    .replace(/"[^"]*"|'[^']*'|`[^`]*`/g, "[text]")
    .replace(/(?<![A-Za-z_])\d[\d,]*(?:\.\d+)?/g, "#")
    .slice(0, MAX_MESSAGE);
}

/** `Name: scrubbed message` for any thrown value. */
export function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${scrubText(error.message)}`;
  if (typeof error === "string") return scrubText(error);
  return "UnknownError";
}

function write(level: "error" | "warn" | "info", context: string, error?: unknown): void {
  const line = error === undefined ? context : `${context} — ${describeError(error)}`;
  if (inTauri()) {
    const sink = level === "error" ? pluginError : level === "warn" ? pluginWarn : pluginInfo;
    // A failing logger must never become a second failure.
    void sink(line).catch(() => undefined);
  } else {
    console[level](line);
  }
}

export const logError = (context: string, error?: unknown): void => write("error", context, error);
export const logWarn = (context: string, error?: unknown): void => write("warn", context, error);
export const logInfo = (context: string): void => write("info", context);

let installed = false;

/** Sends errors nothing else caught (uncaught exceptions, rejected promises) to the log. */
export function installGlobalErrorLogging(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("error", (event) => logError("uncaught error", event.error ?? event.message));
  window.addEventListener("unhandledrejection", (event) => logError("unhandled rejection", event.reason));
}
