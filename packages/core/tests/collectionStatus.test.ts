import { describe, expect, it } from "vitest";
import { desiredCertificateStatus } from "../src";

/**
 * This table is the shared contract between the TypeScript read model and the
 * Rust payment transaction. `apps/desktop/src-tauri/src/lib.rs` asserts the
 * same cases in `certificate_status_fixtures`; keep them in step.
 */
describe("desiredCertificateStatus", () => {
  it("never promotes a draft", () => {
    expect(desiredCertificateStatus("DRAFT", 10_000, 10_000, 10_000)).toBe("DRAFT");
    expect(desiredCertificateStatus("DRAFT", 10_000, 0, 10_000)).toBe("DRAFT");
  });

  /**
   * Collection settles an approved claim; it does not approve one. A submitted
   * certificate the client has already paid stays SUBMITTED until someone
   * approves it, so cash cannot substitute for the approval step.
   */
  it("never lets collection bypass approval", () => {
    expect(desiredCertificateStatus("SUBMITTED", 10_000, 10_000, 10_000)).toBe("SUBMITTED");
    expect(desiredCertificateStatus("SUBMITTED", 10_000, 25_000, 10_000)).toBe("SUBMITTED");
    expect(desiredCertificateStatus("SUBMITTED", 10_000, 0, 10_000)).toBe("SUBMITTED");
  });

  it("settles a fully collected approved certificate", () => {
    expect(desiredCertificateStatus("APPROVED", 10_000, 10_000, 10_000)).toBe("PAID");
    expect(desiredCertificateStatus("APPROVED", 10_000, 10_001, 10_000)).toBe("PAID");
  });

  it("does not promote a partially allocated certificate", () => {
    expect(desiredCertificateStatus("APPROVED", 10_000, 9_999, 10_000)).toBe("APPROVED");
  });

  it("reopens an under-collected paid certificate", () => {
    expect(desiredCertificateStatus("PAID", 10_000, 9_999, 10_000)).toBe("APPROVED");
    expect(desiredCertificateStatus("PAID", 10_000, 0, 10_000)).toBe("APPROVED");
  });

  it("keeps a still-covered paid certificate paid", () => {
    expect(desiredCertificateStatus("PAID", 10_000, 10_000, 10_000)).toBe("PAID");
  });

  /**
   * A net payable of zero means two different things, and the certified base
   * is what separates them.
   */
  it("leaves an empty certificate alone, because it claims nothing", () => {
    expect(desiredCertificateStatus("APPROVED", 0, 0, 0)).toBe("APPROVED");
    expect(desiredCertificateStatus("PAID", 0, 0, 0)).toBe("APPROVED");
  });

  it("settles certified work whose payable is fully consumed by advance recovery", () => {
    // A contract billed fully in advance: every certificate nets to zero, the
    // client owes nothing and never will. Requiring a positive net payable to
    // settle left these reported as open claims forever.
    expect(desiredCertificateStatus("APPROVED", 0, 0, 100_000)).toBe("PAID");
    expect(desiredCertificateStatus("PAID", 0, 0, 100_000)).toBe("PAID");
  });

  it("treats an over-deducted certificate as nothing left to collect", () => {
    expect(desiredCertificateStatus("APPROVED", -2_500, 0, 100_000)).toBe("PAID");
  });

  it("still never promotes a draft or submitted certificate, whatever nets to zero", () => {
    expect(desiredCertificateStatus("DRAFT", 0, 0, 100_000)).toBe("DRAFT");
    expect(desiredCertificateStatus("SUBMITTED", 0, 0, 100_000)).toBe("SUBMITTED");
  });

  it("uses integer minor units exactly at the boundary", () => {
    expect(desiredCertificateStatus("APPROVED", 9_007_199_254_740, 9_007_199_254_739, 9_007_199_254_740)).toBe("APPROVED");
    expect(desiredCertificateStatus("APPROVED", 9_007_199_254_740, 9_007_199_254_740, 9_007_199_254_740)).toBe("PAID");
  });
});
