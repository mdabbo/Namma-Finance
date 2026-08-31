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

  /**
   * CI ran typecheck and tests but nothing that catches what a type checker is
   * happy with: an import left behind by a refactor, or a regex escape that
   * makes an assertion vacuous. Both were present in this repository when the
   * gate was added.
   */
  it("lints before it typechecks or tests", () => {
    const unit = workflow.slice(workflow.indexOf("\n  unit:"), workflow.indexOf("\n  rust:"));
    expect(unit).toContain("pnpm lint");
    expect(unit.indexOf("pnpm lint")).toBeLessThan(unit.indexOf("pnpm test"));
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
    /* eslint-disable no-template-curly-in-string -- asserting workflow syntax verbatim */
    expect(workflow).toContain("COMMIT_SHA: ${{ github.sha }}");
    expect(workflow).toContain("RUN_ID: ${{ github.run_id }}");
    /* eslint-enable no-template-curly-in-string */
  });

  /**
   * Audit regression: `${{ ... }}` inside a `run:` script is spliced in before
   * bash parses the command. A ref is attacker-chosen on a fork pull request
   * and a branch name may legally contain a double quote, so interpolating one
   * into a script is a command-injection vector. Context must arrive through
   * `env:`, where it is only ever data.
   */
  it("never interpolates workflow context into a shell script", () => {
    const lines = workflow.split("\n");
    const offenders: string[] = [];
    let insideRun = false;
    let runIndent = 0;
    for (const line of lines) {
      const runStart = line.match(/^(\s*)(?:- )?run: /);
      if (runStart) {
        insideRun = true;
        runIndent = runStart[1]!.length;
        if (/\$\{\{/.test(line)) offenders.push(line.trim());
        continue;
      }
      if (insideRun) {
        const indent = line.search(/\S/);
        if (line.trim() !== "" && indent <= runIndent) {
          insideRun = false;
        } else if (/\$\{\{/.test(line)) {
          offenders.push(line.trim());
        }
      }
    }
    expect(offenders, `interpolated context inside run script: ${offenders.join(" | ")}`)
      .toEqual([]);
  });

  it("builds the desktop app only after the gates that judge it pass", () => {
    const build = workflow.slice(workflow.indexOf("\n  build:"));
    const needs = build.match(/needs:\s*\[(.+)\]/)?.[1] ?? "";
    for (const job of ["unit", "rust", "e2e"]) {
      expect(needs, `build must wait for ${job}`).toContain(job);
    }
  });

  /**
   * Audit regression: the job was named "Desktop production build" and its
   * evidence step recorded a commit SHA, but it only ran `vite build` — a web
   * bundle, not the thing a user installs. It could stay green through a Rust
   * compile error, so the recorded evidence attested to an artifact that had
   * never been built.
   */
  it("actually compiles the desktop application, not just the web bundle", () => {
    const build = workflow.slice(workflow.indexOf("\n  build:"));
    expect(build).toContain("tauri build");
    // The Rust toolchain must be present or the compile cannot happen at all.
    expect(build).toContain("dtolnay/rust-toolchain");
  });

  it("keeps the installers, not only the log that says a build happened", () => {
    const build = workflow.slice(workflow.indexOf("\n  build:"));
    expect(build).toContain("name: desktop-installers");
    // An empty upload must fail loudly rather than pass as "nothing to do".
    expect(build).toMatch(/name: desktop-installers[\s\S]{0,160}if-no-files-found: error/);
  });

  it("bounds every job with a timeout", () => {
    const jobsBlock = workflow.slice(workflow.indexOf("\njobs:"));
    const jobs = [...jobsBlock.matchAll(/^ {2}([a-z0-9-]+):$/gm)].map((match) => match[1]);
    expect(jobs).toEqual(["unit", "rust", "e2e", "build"]);
    expect([...jobsBlock.matchAll(/^ {4}timeout-minutes: \d+$/gm)]).toHaveLength(jobs.length);
  });
});
