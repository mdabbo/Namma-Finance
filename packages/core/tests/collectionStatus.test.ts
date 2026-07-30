import { describe, expect, it } from "vitest";
import { desiredCertificateStatus } from "../src";

/**
 * This table is the shared contract between the TypeScript read model and the
 * Rust payment transaction. `apps/desktop/src-tauri/src/lib.rs` asserts the
 * same cases in `certificate_status_fixtures`; keep them in step.
 */
describe("desiredCertificateStatus", () => {
  it("never promotes a draft", () => {
    expect(desiredCertificateStatus("DRAFT", 10_000, 10_000)).toBe("DRAFT");
    expect(desiredCertificateStatus("DRAFT", 10_000, 0)).toBe("DRAFT");
  });

  /**
   * Collection settles an approved claim; it does not approve one. A submitted
   * certificate the client has already paid stays SUBMITTED until someone
   * approves it, so cash cannot substitute for the approval step.
   */
  it("never lets collection bypass approval", () => {
    expect(desiredCertificateStatus("SUBMITTED", 10_000, 10_000)).toBe("SUBMITTED");
    expect(desiredCertificateStatus("SUBMITTED", 10_000, 25_000)).toBe("SUBMITTED");
    expect(desiredCertificateStatus("SUBMITTED", 10_000, 0)).toBe("SUBMITTED");
  });

  it("settles a fully collected approved certificate", () => {
    expect(desiredCertificateStatus("APPROVED", 10_000, 10_000)).toBe("PAID");
    expect(desiredCertificateStatus("APPROVED", 10_000, 10_001)).toBe("PAID");
  });

  it("does not promote a partially allocated certificate", () => {
    expect(desiredCertificateStatus("APPROVED", 10_000, 9_999)).toBe("APPROVED");
  });

  it("reopens an under-collected paid certificate", () => {
    expect(desiredCertificateStatus("PAID", 10_000, 9_999)).toBe("APPROVED");
    expect(desiredCertificateStatus("PAID", 10_000, 0)).toBe("APPROVED");
  });

  it("keeps a still-covered paid certificate paid", () => {
    expect(desiredCertificateStatus("PAID", 10_000, 10_000)).toBe("PAID");
  });

  it("does not treat a zero-value certificate as collected", () => {
    expect(desiredCertificateStatus("APPROVED", 0, 0)).toBe("APPROVED");
    expect(desiredCertificateStatus("PAID", 0, 0)).toBe("APPROVED");
  });

  it("uses integer minor units exactly at the boundary", () => {
    expect(desiredCertificateStatus("APPROVED", 9_007_199_254_740, 9_007_199_254_739)).toBe("APPROVED");
    expect(desiredCertificateStatus("APPROVED", 9_007_199_254_740, 9_007_199_254_740)).toBe("PAID");
  });
});
