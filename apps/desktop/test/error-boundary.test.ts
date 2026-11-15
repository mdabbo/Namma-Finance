import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import { resources } from "@mep/core/i18n";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ErrorBoundary, ErrorFallback, buildErrorDetails, routePattern } from "../src/components/ErrorBoundary";
import { describeError, scrubText } from "../src/lib/logger";

vi.mock("@tauri-apps/plugin-log", () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }));

beforeAll(async () => {
  await i18next.use(initReactI18next).init({
    resources,
    lng: "en",
    fallbackLng: "en",
    interpolation: { escapeValue: false },
  });
});

describe("B1 error fallback", () => {
  it("renders the fallback with Reload and Copy details", () => {
    const html = renderToStaticMarkup(createElement(ErrorFallback, { error: new Error("boom") }));
    expect(html).toContain("Something went wrong");
    expect(html).toContain("Reload");
    expect(html).toContain("Copy details");
    expect(html).toContain("Error: boom");
  });

  it("renders in Arabic", async () => {
    await i18next.changeLanguage("ar");
    const html = renderToStaticMarkup(createElement(ErrorFallback, { error: new Error("boom") }));
    expect(html).toContain("حدث خطأ غير متوقع");
    expect(html).toContain("إعادة التحميل");
    await i18next.changeLanguage("en");
  });

  it("passes children through when nothing throws", () => {
    expect(renderToStaticMarkup(createElement(ErrorBoundary, null, createElement("p", null, "fine")))).toBe("<p>fine</p>");
  });

  it("the boundary turns a thrown error into the fallback", () => {
    const state = ErrorBoundary.getDerivedStateFromError(new Error("kaput"));
    expect(state.hasError).toBe(true);
    const boundary = new ErrorBoundary({ children: null });
    boundary.state = { ...boundary.state, ...state } as typeof boundary.state;
    const html = renderToStaticMarkup(boundary.render() as React.ReactElement);
    expect(html).toContain('data-testid="error-fallback"');
  });
});

describe("B1 error details carry no record values", () => {
  it("scrubs amounts, quoted names and e-mail addresses", () => {
    const message = 'Cannot pay 1,250,000.50 EGP to "Al Noor Contracting" (ahmed@example.com) on cert 12';
    const out = scrubText(message);
    expect(out).not.toMatch(/1,250|Noor|ahmed|\b12\b/);
  });

  it("keeps machine codes readable", () => {
    expect(scrubText("SCHEMA_VERSION_8 mismatch on payments_2")).toBe("SCHEMA_VERSION_8 mismatch on payments_2");
  });

  it("builds details from the route pattern, not the ids", () => {
    expect(routePattern("#/projects/3f2a9c1e-1111-4222-8333-444455556666?tab=x")).toBe("/projects/:id");
    const details = buildErrorDetails(new Error("Total 99,500 for 'Villa'"), "#/projects/42", "\n    at ProjectDetailPage (x)\n    at Layout (y)");
    expect(details).toContain("route: /projects/:id");
    expect(details).toContain("components: ProjectDetailPage > Layout");
    expect(details).not.toMatch(/99,500|Villa/);
  });

  it("describes non-Error values safely", () => {
    expect(describeError({ amount: 5 })).toBe("UnknownError");
    expect(describeError("failed for 'Ali'")).toBe("failed for [text]");
  });
});
