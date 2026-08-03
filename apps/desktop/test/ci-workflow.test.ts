import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const workflow = readFileSync(join(root, ".github/workflows/quality.yml"), "utf8");

/**
 * Milestone 5: the Playwright suite existed but CI never ran it, and the push
 * trigger did not cover the branch the release work lives on — so a broken UI
 * could reach a green-looking branch.
 *
 * These assertions are deliberately about the workflow's contract, not its
 * formatting: which branches are gated, that the UI suite runs, that its
 * evidence is uploaded, and that nothing shippable is built before the gates
 * that judge it have passed.
 */
describe("quality workflow", () => {
  it("gates release branches and pull requests", () => {
    expect(workflow).toMatch(/^on:/m);
    expect(workflow).toMatch(/^ {2}pull_request:/m);
    const branches = workflow.match(/branches:\s*\[(.+)\]/)?.[1] ?? "";
    for (const branch of ["main", "redesign/**", "hardening/**"]) {
      expect(branches, `push trigger must cover ${branch}`).toContain(branch);
    }
  });

  it("runs the Playwright suite as its own job", () => {
    expect(workflow).toMatch(/^ {2}e2e:/m);
    expect(workflow).toContain("playwright test");
    // The app ships in a WebView2 window, so the suite must stay on Edge.
    expect(workflow).toContain("playwright install msedge");
  });

  it("uploads UI evidence whether the suite passes or fails", () => {
    for (const artifact of [
      "core-financial-coverage",
      "playwright-report",
      "playwright-traces-and-screenshots",
      "desktop-build-evidence",
    ]) {
      expect(workflow, `missing artifact ${artifact}`).toContain(`name: ${artifact}`);
    }
    // Traces are only useful when something failed, so the upload cannot be
    // conditional on success.
    expect(workflow).toContain("if: always()");
  });

  it("ties recorded evidence to the exact commit", () => {
    expect(workflow).toContain("release-evidence.txt");
    expect(workflow).toContain("${{ github.sha }}");
    expect(workflow).toContain("actions/runs/${{ github.run_id }}");
  });

  it("builds the desktop app only after the gates that judge it pass", () => {
    const build = workflow.slice(workflow.indexOf("\n  build:"));
    const needs = build.match(/needs:\s*\[(.+)\]/)?.[1] ?? "";
    for (const job of ["unit", "rust", "e2e"]) {
      expect(needs, `build must wait for ${job}`).toContain(job);
    }
  });

  it("bounds every job with a timeout", () => {
    const jobsBlock = workflow.slice(workflow.indexOf("\njobs:"));
    const jobs = [...jobsBlock.matchAll(/^ {2}([a-z0-9-]+):$/gm)].map((match) => match[1]);
    expect(jobs).toEqual(["unit", "rust", "e2e", "build"]);
    expect([...jobsBlock.matchAll(/^ {4}timeout-minutes: \d+$/gm)]).toHaveLength(jobs.length);
  });
});
