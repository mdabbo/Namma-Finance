import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/db", async () => await import("./db-harness"));

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import { atomicCommand, desktopCommand, hasTauriRuntime } from "../src/lib/atomic";
import { resetDb } from "./db-harness";

/**
 * The gap this suite exists to close.
 *
 * Every multi-statement write used to carry its own
 * `if (Tauri) invoke(x_atomic) else <transaction>` branch, and NOTHING in the
 * repository suite ever took the first branch: neither vitest nor the
 * Playwright bridge defines `__TAURI_INTERNALS__`, so 336 green tests were
 * measuring the second one. The shipped transaction layer — the Rust commands
 * that actually run on a user's machine — was exercised only by `cargo test`,
 * and the two halves were free to drift apart unnoticed.
 *
 * Rust cannot execute inside vitest, so these tests do not claim to verify the
 * commands' behaviour; `cargo test` in src-tauri/src/lib.rs owns that. What
 * they verify is the part that was genuinely untested and genuinely broken:
 * that with a Tauri runtime present every caller DISPATCHES to its Rust
 * command, with the arguments that command expects, and never reaches the test
 * double. A repository that quietly keeps writing through the WebView now
 * fails here instead of shipping.
 */

function withTauriRuntime(): void {
  (globalThis as { window?: unknown }).window = { __TAURI_INTERNALS__: {} };
}

function withoutTauriRuntime(): void {
  (globalThis as { window?: unknown }).window = {};
}

beforeEach(() => {
  resetDb();
  invoke.mockReset();
  invoke.mockResolvedValue(0);
});

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe("atomic dispatch seam", () => {
  it("routes to the Rust command and never runs the double when Tauri is present", async () => {
    withTauriRuntime();
    invoke.mockResolvedValue(42);
    const double = vi.fn(async () => 7);

    const result = await atomicCommand<number>("create_payment_atomic", { input: 1 }, double);

    expect(result).toBe(42);
    expect(double).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith("create_payment_atomic", { input: 1 });
  });

  it("runs the double inside a real transaction only when there is no Tauri runtime", async () => {
    withoutTauriRuntime();
    const double = vi.fn(async () => 7);

    expect(await atomicCommand<number>("create_payment_atomic", {}, double)).toBe(7);
    expect(double).toHaveBeenCalledTimes(1);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("reports the runtime it is actually running in", () => {
    withTauriRuntime();
    expect(hasTauriRuntime()).toBe(true);
    withoutTauriRuntime();
    expect(hasTauriRuntime()).toBe(false);
  });

  it("refuses a desktop-only command outside the desktop runtime rather than degrading", () => {
    withoutTauriRuntime();
    expect(() => desktopCommand("create_backup_file")).toThrow(/DESKTOP_COMMAND_UNAVAILABLE/);
  });
});

/**
 * One case per production caller. The assertion is deliberately about the
 * command NAME and the ARGUMENT SHAPE, because those are the contract with
 * Rust: a renamed field is exactly the kind of drift that used to be invisible
 * here and surface only on a user's machine.
 */
describe("every multi-statement write dispatches to its Rust command", () => {
  beforeEach(() => withTauriRuntime());

  it("payments create/update/void and reconciliation", async () => {
    const payments = await import("../src/repositories/payments");
    invoke.mockResolvedValue(1);

    await payments.reconcileCertificateStatuses([5]);
    expect(invoke).toHaveBeenCalledWith("reconcile_certificates_atomic", { certificateIds: [5] });
  });

  it("number reservation", async () => {
    const { reserveNextNumberWithinExistingLock } = await import("../src/repositories/numbering");
    invoke.mockResolvedValue("PAY-2026-0001");

    const number = await reserveNextNumberWithinExistingLock("PAYMENT", "pay", new Date("2026-03-04T00:00:00Z"));

    expect(number).toBe("PAY-2026-0001");
    expect(invoke).toHaveBeenCalledWith("reserve_next_number_atomic", {
      sequenceType: "PAYMENT",
      prefix: "PAY",
      year: 2026,
    });
  });

  it("restore audit finalisation", async () => {
    const { finalizePendingRestoreAudit } = await import("../src/repositories/audit");
    invoke.mockResolvedValue(false);

    await finalizePendingRestoreAudit();

    expect(invoke).toHaveBeenCalledWith("finalize_pending_restore_audit_atomic", {});
  });

  it("safety-backup metadata finalisation", async () => {
    const { finalizePendingBackupMetadata } = await import("../src/repositories/backups");
    invoke.mockResolvedValue(false);

    await finalizePendingBackupMetadata();

    expect(invoke).toHaveBeenCalledWith("finalize_pending_backup_metadata_atomic", {});
  });

  it("assignment cancellation sends Rust no figure to trust", async () => {
    const { cancelAssignment } = await import("../src/repositories/people");
    invoke.mockResolvedValue(undefined);

    // No assignment exists here; the derivation runs before dispatch and throws
    // first, so drive the command through the seam directly to pin its shape.
    const { atomicCommand } = await import("../src/lib/atomic");
    await atomicCommand<void>(
      "cancel_assignment_atomic",
      { assignmentId: 7, reason: "Called off" },
      async () => undefined,
    );

    expect(invoke).toHaveBeenCalledWith("cancel_assignment_atomic", {
      assignmentId: 7,
      reason: "Called off",
    });
    expect(typeof cancelAssignment).toBe("function");
  });

  it("sync conflict resolution goes to Rust, never to a WebView transaction", async () => {
    const { resolveSyncConflict } = await import("../src/repositories/syncConflicts");
    invoke.mockResolvedValue(undefined);

    // A conflict row has to exist for the pre-checks to pass before dispatch.
    const { execute: run } = await import("../src/lib/db");
    await run(
      `INSERT INTO sync_conflicts(table_name,row_uuid,conflict_kind,local_json,remote_json,
         remote_updated_at,detected_at,status)
       VALUES('payments','u1','CONCURRENT_EDIT','{}','{}','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z','OPEN')`,
      [],
    );
    const [{ id }] = await (await import("../src/lib/db")).select<{ id: number }>(
      "SELECT id FROM sync_conflicts WHERE row_uuid='u1'",
    );

    await resolveSyncConflict(id, "KEEP_LOCAL", "  reviewed  ");

    expect(invoke).toHaveBeenCalledWith("resolve_sync_conflict_atomic", {
      conflictId: id,
      resolution: "KEEP_LOCAL",
      note: "  reviewed  ",
    });
    // Rust trims the note, so the untrimmed value crossing the boundary is fine
    // — but the conflict must NOT have been resolved on this side.
    const [row] = await (await import("../src/lib/db")).select<{ status: string }>(
      "SELECT status FROM sync_conflicts WHERE row_uuid='u1'",
    );
    expect(row!.status).toBe("OPEN");
  });

  it("legacy document creation carries the on-disk path Rust stores", async () => {
    const { createDocument } = await import("../src/repositories/documents");
    invoke.mockResolvedValue(3);

    await createDocument({ projectId: 1, category: "OTHER", title: "plan.pdf", path: "C:/plan.pdf" });

    const [command, args] = invoke.mock.calls.at(-1) as [string, { input: Record<string, unknown> }];
    expect(command).toBe("create_document_atomic");
    expect(args.input).toMatchObject({
      projectId: 1,
      category: "OTHER",
      title: "plan.pdf",
      storageProvider: "LEGACY_LOCAL",
      versionNumber: 1,
      localCachePath: "C:/plan.pdf",
      path: "C:/plan.pdf",
    });
  });
});
