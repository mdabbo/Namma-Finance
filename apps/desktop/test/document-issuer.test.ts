import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import { resources } from "@mep/core/i18n";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/db", async () => await import("./db-harness"));

import { EGP_VALUATION } from "@mep/core";
import { resetDb } from "./db-harness";
import { createClient } from "../src/repositories/clients";
import { createProject } from "../src/repositories/projects";
import { createContract, getContract } from "../src/repositories/contracts";
import { createCertificate, listCertificates } from "../src/repositories/certificates";
import { loadWorkspaceFinancials } from "../src/repositories/financials";
import { CertificateDocument } from "../src/features/certificates/CertificateDocument";
import { documentIssuerName } from "../src/lib/issuer";

/**
 * Printed documents name the office, not the software.
 *
 * A payment certificate was headed with the product name and carried it again
 * above the issuer's signature line, so the document a client signs named an
 * accounting application as the other party. After the product was renamed the
 * certificates read "DABWORKS Finance". The company name the office enters in
 * Settings was never used.
 */

const PRODUCT = "DABWORKS Finance";
const OFFICE = "DABWORKS Engineering Consultancy";

beforeAll(async () => {
  await i18next.use(initReactI18next).init({
    resources,
    lng: "en",
    fallbackLng: "en",
    interpolation: { escapeValue: false },
  });
});

async function certificateDocument(issuerName: string): Promise<string> {
  const clientId = await createClient({ name: "RGU", company: null, address: null, phone: null,
    email: null, taxNumber: null, contacts: null, notes: null });
  const projectId = await createProject("PRJ-2026-002", { name: "CASA", clientId,
    country: null, city: null, manager: null, discipline: "MULTI", projectType: null, status: "ACTIVE",
    currency: "SAR", fxRateMicro: 12_900_000, startDate: null, endDate: null, progressBp: 0, description: null });
  const contractId = await createContract({ projectId, number: "CON-2026-0001", title: null,
    valueMinor: 32_500_000, vatBp: 1500, retentionBp: 0, withholdingBp: 0, advanceMinor: 0,
    advanceRecoveryMethod: "PROPORTIONAL", performanceBondBp: 0, performanceBondBank: null,
    performanceBondExpiry: null, paymentTermsDays: 30, paymentTermsNotes: null,
    valuationMode: "LUMP_SUM", milestones: null, drawings: null, attachments: null,
    signedDate: "2026-01-01", notes: null });
  await createCertificate(1, { contractId, number: "PC-2026-0001", date: "2026-02-01",
    submissionDate: "2026-02-01", dueDateOverride: null, description: "Milestone 1",
    grossMinor: 8_125_000, discountMinor: 0, manualAdvanceRecoveryMinor: null, status: "APPROVED" });

  const [cert] = await listCertificates();
  const contract = await getContract(contractId);
  const workspace = await loadWorkspaceFinancials(EGP_VALUATION);
  const state = workspace.contractStates.get(contractId)!.certificates[0]!;
  return renderToStaticMarkup(createElement(CertificateDocument, {
    cert: cert!,
    contract: contract!,
    breakdown: state.breakdown,
    issuerName,
  }));
}

const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;

describe("document issuer", () => {
  it("is the office's company name when one is set", () => {
    expect(documentIssuerName(OFFICE, PRODUCT)).toBe(OFFICE);
    expect(documentIssuerName(`  ${OFFICE}  `, PRODUCT)).toBe(OFFICE);
  });

  it("falls back to the product name only when no company name exists", () => {
    for (const blank of ["", "   ", null, undefined]) {
      expect(documentIssuerName(blank, PRODUCT)).toBe(PRODUCT);
    }
  });
});

describe("printed payment certificate", () => {
  beforeEach(() => resetDb());

  it("is headed and signed by the office, and never names the software", async () => {
    const html = await certificateDocument(documentIssuerName(OFFICE, PRODUCT));
    // Once in the header, once above the issuer's signature line.
    expect(occurrences(html, OFFICE)).toBe(2);
    expect(html).not.toContain(PRODUCT);
    // The certificate itself is still the certificate.
    expect(html).toContain("PC-2026-0001");
    expect(html).toContain("RGU");
  });

  it("prints the product name only for a workspace with no company name yet", async () => {
    const html = await certificateDocument(documentIssuerName("", PRODUCT));
    expect(occurrences(html, PRODUCT)).toBe(2);
  });
});

/**
 * The three documents that leave the office each used to print
 * `t("common.appName")` directly. They must go through the issuer rule, so a
 * new document cannot quietly reach for the product name again.
 */
describe("printed documents resolve their issuer through one rule", () => {
  const read = (...path: string[]) =>
    readFileSync(join(import.meta.dirname, "..", "src", "features", ...path), "utf8");

  it("the certificate takes its issuer as a prop and holds no product name", () => {
    expect(read("certificates", "CertificateDocument.tsx")).not.toContain("common.appName");
  });

  it.each([
    ["certificates", "CertificatesPage.tsx"],
    ["people", "PersonDetailPage.tsx"],
    ["reports", "ReportsCenter.tsx"],
  ])("%s/%s uses the product name only as the issuer fallback", (folder, file) => {
    const source = read(folder, file);
    const uses = occurrences(source, 't("common.appName")');
    const asFallback = occurrences(source, 'documentIssuerName(settings?.companyName, t("common.appName"))');
    expect(uses).toBeGreaterThan(0);
    expect(uses).toBe(asFallback);
  });
});
