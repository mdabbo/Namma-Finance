import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * C4: route pages load on demand so the first paint ships the shell, not every
 * feature (the entry chunk was 2.08 MB before). A static page import in
 * main.tsx silently undoes that, and no type check or E2E test notices.
 */
const main = readFileSync(resolve(import.meta.dirname, "..", "src", "main.tsx"), "utf8");

describe("C4 lazy routes", () => {
  it("imports no feature page statically", () => {
    const staticFeatureImports = main
      .split(/\r?\n/)
      .filter((line) => /^import\b.*from\s+["']\.\/features\//.test(line));
    expect(staticFeatureImports).toEqual([]);
  });

  it("loads every routed page through page(() => import(...))", () => {
    const lazyPages = [...main.matchAll(/lazy: page\(\(\) => import\("\.\/features\/[^"]+"\), "(\w+)"\)/g)];
    expect(lazyPages.length).toBeGreaterThanOrEqual(16);
    expect(main).not.toMatch(/element: <\w+(Page|View) \/>/);
  });

  it("keeps what must render when nothing else can load eager", () => {
    // The lock screen, layout, error boundary and startup error screen are the
    // fallbacks: if they were lazy, a failed chunk load could blank the window.
    for (const eager of ['{ LockScreen } from "./components/LockScreen"', '{ Layout } from "./app/Layout"', '"./components/ErrorBoundary"']) {
      expect(main).toContain(`import ${eager.startsWith("{") ? eager : `{ ErrorBoundary, RouteErrorElement } from ${eager}`}`);
    }
    expect(main).toContain("function StartupCompatibilityError");
  });
});
