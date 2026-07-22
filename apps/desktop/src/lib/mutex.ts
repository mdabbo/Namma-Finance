/**
 * A single global async lock that serialises the financial reconciliation
 * pipeline. Every milestone reconciliation trigger runs in the same webview
 * process. Without serialisation two stage or contract edits can
 * interleave at `await` boundaries and race on the read-modify-write of a
 * contract's milestone JSON, which double-creates milestone certificates and
 * wipes their certificateId links (observed in the simulation harness).
 *
 * The wrapped functions never call each other under the lock, so this plain
 * promise-chain lock cannot deadlock (no reentrancy).
 */

let chain: Promise<unknown> = Promise.resolve();

export function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  // keep the chain alive regardless of this task's success/failure
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
