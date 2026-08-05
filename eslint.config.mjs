import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

/**
 * Lint rules, kept deliberately narrow.
 *
 * CI ran typecheck and tests but nothing that catches the class of mistake a
 * type checker is happy with: an unused import left behind by a refactor, a
 * floating promise in a financial write, a `case` that falls into the next one.
 *
 * The ruleset is not "everything recommended". Rules that would demand a broad
 * rewrite of working, audited financial code earn nothing today and would train
 * everyone to run with warnings — so stylistic rules are off and the type-aware
 * tier is not enabled. What stays is the set where a hit is a real defect.
 */
export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/target/**",
      "**/playwright-report/**",
      "**/test-results/**",
      "**/*.d.ts",
      "**/coverage/**",
      "apps/desktop/src/generated/**",
      "apps/mobile/src/generated/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        // Browser/WebView surface the app actually uses.
        window: "readonly",
        document: "readonly",
        console: "readonly",
        localStorage: "readonly",
        fetch: "readonly",
        crypto: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        queueMicrotask: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        TextEncoder: "readonly",
        TextDecoder: "readonly",
        Blob: "readonly",
        File: "readonly",
        FormData: "readonly",
        Response: "readonly",
        Request: "readonly",
        Headers: "readonly",
        AbortController: "readonly",
        HTMLElement: "readonly",
        HTMLInputElement: "readonly",
        HTMLDivElement: "readonly",
        Element: "readonly",
        Event: "readonly",
        KeyboardEvent: "readonly",
        MouseEvent: "readonly",
        MediaQueryListEvent: "readonly",
        IntersectionObserver: "readonly",
        ResizeObserver: "readonly",
        matchMedia: "readonly",
        alert: "readonly",
        confirm: "readonly",
        navigator: "readonly",
        location: "readonly",
        history: "readonly",
        performance: "readonly",
        structuredClone: "readonly",
        // Node surface, for scripts, config and the e2e bridge.
        process: "readonly",
        Buffer: "readonly",
        __dirname: "readonly",
        globalThis: "readonly",
      },
    },
    rules: {
      // An unused symbol after a refactor is the signal; an intentionally
      // ignored argument is spelled with a leading underscore.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      // `any` is a real escape hatch in a few places; flag it without failing.
      "@typescript-eslint/no-explicit-any": "warn",
      "no-fallthrough": "error",
      "no-constant-binary-expression": "error",
      "no-self-compare": "error",
      "no-unmodified-loop-condition": "error",
      "no-unreachable-loop": "error",
      "no-template-curly-in-string": "error",
      eqeqeq: ["error", "always", { null: "ignore" }],
    },
  },
  {
    files: ["apps/**/*.tsx"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      // A dependency array that lies is how a screen ends up showing figures
      // from the previous project.
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
);
