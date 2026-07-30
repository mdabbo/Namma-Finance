import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { computeCertificate, desiredCertificateStatus } from "../src";
import type { AdvanceRecoveryMethod, CertificateStatus } from "../src";

/**
 * The certificate calculation now exists twice: in TypeScript for the read
 * model, and in Rust for the payment transaction that owns status. Two engines
 * mean two chances to be wrong, so both assert this one fixture file.
 *
 * Rust side: `certificate_fixtures_match_typescript` in
 * apps/desktop/src-tauri/src/lib.rs.
 */

interface NetPayableFixture {
  name: string;
  grossMinor: number;
  discountMinor: number;
  vatBp: number;
  retentionBp: number;
  withholdingBp: number;
  advanceMinor: number;
  advanceMethod: AdvanceRecoveryMethod;
  manualRecoveryMinor: number | null;
  contractValueMinor: number;
  recoveredBeforeMinor: number;
  expectedNetPayableMinor: number;
  expectedRecoveryMinor: number;
}

interface StatusFixture {
  name: string;
  current: CertificateStatus;
  netPayableMinor: number;
  allocatedMinor: number;
  expected: CertificateStatus;
}

const fixtures = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../../fixtures/certificate-financials.json"), "utf8"),
) as { netPayable: NetPayableFixture[]; status: StatusFixture[] };

describe("shared certificate fixtures", () => {
  it("covers every deduction and both advance-recovery methods", () => {
    expect(fixtures.netPayable.length).toBeGreaterThanOrEqual(15);
    expect(fixtures.status.length).toBeGreaterThanOrEqual(14);
    const methods = new Set(fixtures.netPayable.map((fixture) => fixture.advanceMethod));
    expect([...methods].sort()).toEqual(["MANUAL", "PROPORTIONAL"]);
  });

  it.each(fixtures.netPayable.map((fixture) => [fixture.name, fixture] as const))(
    "net payable: %s",
    (_name, fixture) => {
      const breakdown = computeCertificate({
        grossMinor: fixture.grossMinor,
        discountMinor: fixture.discountMinor,
        vatBp: fixture.vatBp,
        retentionBp: fixture.retentionBp,
        withholdingBp: fixture.withholdingBp,
        advance: {
          method: fixture.advanceMethod,
          contractValueMinor: fixture.contractValueMinor,
          advanceMinor: fixture.advanceMinor,
          recoveredBeforeMinor: fixture.recoveredBeforeMinor,
          manualRecoveryMinor: fixture.manualRecoveryMinor,
        },
      });
      expect(breakdown.netPayableMinor).toBe(fixture.expectedNetPayableMinor);
      expect(breakdown.advanceRecoveryMinor).toBe(fixture.expectedRecoveryMinor);
      expect(Number.isInteger(breakdown.netPayableMinor)).toBe(true);
    },
  );

  it.each(fixtures.status.map((fixture) => [fixture.name, fixture] as const))(
    "status: %s",
    (_name, fixture) => {
      expect(
        desiredCertificateStatus(fixture.current, fixture.netPayableMinor, fixture.allocatedMinor),
      ).toBe(fixture.expected);
    },
  );
});
