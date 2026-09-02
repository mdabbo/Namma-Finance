import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const src = join(__dirname, "../src");

function source(path: string) {
  return readFileSync(join(src, path), "utf8");
}

describe("entity archive and void actions stay reachable", () => {
  it("shows archive actions from client and project detail screens", () => {
    const clientDetail = source("features/clients/ClientDetailPage.tsx");
    const projectDetail = source("features/projects/ProjectDetailPage.tsx");

    expect(clientDetail).toContain("clientCascadeInfo");
    expect(clientDetail).toContain("lifecycle.archiveClient");
    expect(clientDetail).toContain("navigate(\"/projects/clients\")");

    expect(projectDetail).toContain("projectCascadeInfo");
    expect(projectDetail).toContain("lifecycle.archiveProject");
    expect(projectDetail).toContain("navigate(\"/projects\")");
  });

  it("keeps certificate void available inside the project finance workspace", () => {
    const financeTab = source("features/projects/ProjectFinanceTab.tsx");

    expect(financeTab).toContain("useCertificateMutations");
    expect(financeTab).toContain("setVoidingCertificate");
    expect(financeTab).toContain("lifecycle.voidCertificate");
    expect(financeTab).toContain("ALLOCATED_CERTIFICATE_CANNOT_BE_VOIDED");
  });
});

describe("contract edits after certificate history guide the revision path", () => {
  it("requires revision metadata when protected commercial terms change", () => {
    const form = source("features/projects/ContractForm.tsx");
    const projectDetail = source("features/projects/ProjectDetailPage.tsx");

    expect(form).toContain("protectedTermsChanged");
    expect(form).toContain("revisionRequired");
    expect(form).toContain("contracts.revisionRequiredHint");
    expect(form).toContain("onSubmit(parsed.data, protectedTermsChanged");
    expect(projectDetail).toContain("hasFinancialHistory=");
  });
});
