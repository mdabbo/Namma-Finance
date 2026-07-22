import { describe, expect, it } from "vitest";
import { desiredCertificateStatus } from "../src";

describe("desiredCertificateStatus", () => {
  it("never promotes a draft", () => {
    expect(desiredCertificateStatus("DRAFT", 10_000, 10_000)).toBe("DRAFT");
  });

  it.each(["SUBMITTED", "APPROVED"] as const)("promotes fully allocated %s certificates", (status) => {
    expect(desiredCertificateStatus(status, 10_000, 10_000)).toBe("PAID");
  });

  it("does not promote a partially allocated certificate", () => {
    expect(desiredCertificateStatus("APPROVED", 10_000, 9_999)).toBe("APPROVED");
  });

  it("reopens an under-collected paid certificate", () => {
    expect(desiredCertificateStatus("PAID", 10_000, 9_999)).toBe("APPROVED");
  });

  it("does not treat a zero-value certificate as collected", () => {
    expect(desiredCertificateStatus("APPROVED", 0, 0)).toBe("APPROVED");
  });

  it("uses integer minor units exactly for over-allocation", () => {
    expect(desiredCertificateStatus("SUBMITTED", 9_007_199_254_740, 9_007_199_254_741)).toBe("PAID");
  });
});
