import { describe, expect, it } from "vitest";
import { lockErrorMessageKey } from "../src/lib/lock";

describe("app-lock error reporting", () => {
  it("does not misreport SQLite contention as a wrong password", () => {
    expect(lockErrorMessageKey("error returned from database: (code: 5) database is locked"))
      .toBe("databaseBusy");
    expect(lockErrorMessageKey("APP_DATABASE_UNAVAILABLE: database is not loaded"))
      .toBe("databaseBusy");
  });

  it("keeps credential, throttle and validation failures distinct", () => {
    expect(lockErrorMessageKey("LOCK_PASSWORD_INVALID")).toBe("wrong");
    expect(lockErrorMessageKey("CURRENT_PASSWORD_REQUIRED")).toBe("wrong");
    expect(lockErrorMessageKey("LOCK_RETRY_AFTER:2")).toBe("retry");
    expect(lockErrorMessageKey("LOCK_PASSWORD_LENGTH_INVALID")).toBe("mismatch");
    expect(lockErrorMessageKey("LOCK_KDF_FAILED")).toBe("failed");
  });
});
