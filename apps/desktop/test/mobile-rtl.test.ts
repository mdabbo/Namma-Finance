import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { arabicFontFamily, backGlyph, fontFamilyFor, layoutDirection, TAJAWAL } from "../../mobile/src/lib/layout";

/**
 * Right-to-left layout and Arabic type on the phone (plan step F2).
 *
 * The phone app has no test runner of its own yet (plan step C7), so its
 * rules live in react-native-free modules and are tested here, and the rest is
 * held in place by source guards: they cannot see a screen, but they stop the
 * mistakes that make a screen come out wrong in Arabic.
 */

const mobile = fileURLToPath(new URL("../../mobile", import.meta.url));
const sourceFiles: string[] = [];
function collect(dir: string): void {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === "generated") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) collect(path);
    else if (/\.tsx?$/.test(name)) sourceFiles.push(path);
  }
}
collect(join(mobile, "src"));
sourceFiles.push(join(mobile, "App.tsx"));
const text = (path: string) => readFileSync(path, "utf8");
const rel = (path: string) => relative(mobile, path).replace(/\\/g, "/");

describe("layout direction", () => {
  it("lays Arabic out right to left and English left to right", () => {
    expect(layoutDirection("ar")).toBe("rtl");
    expect(layoutDirection("en")).toBe("ltr");
    expect(layoutDirection("ar-EG")).toBe("ltr"); // the app only ever stores "ar" or "en"
    expect(layoutDirection("")).toBe("ltr");
  });

  it("points the back chevron at the start edge", () => {
    expect(backGlyph("ltr")).toBe("‹");
    expect(backGlyph("rtl")).toBe("›");
  });
});

describe("Arabic font", () => {
  it("is Tajawal in Arabic and the phone's own font in English", () => {
    expect(fontFamilyFor("ar", undefined)).toBe(TAJAWAL.regular);
    expect(fontFamilyFor("en", "700")).toBeUndefined();
  });

  it("picks one family per weight the screens use, since Android ignores fontWeight", () => {
    expect(arabicFontFamily(undefined)).toBe(TAJAWAL.regular);
    expect(arabicFontFamily("normal")).toBe(TAJAWAL.regular);
    expect(arabicFontFamily("400")).toBe(TAJAWAL.regular);
    expect(arabicFontFamily("500")).toBe(TAJAWAL.medium);
    expect(arabicFontFamily("600")).toBe(TAJAWAL.bold);
    expect(arabicFontFamily("700")).toBe(TAJAWAL.bold);
    expect(arabicFontFamily("bold")).toBe(TAJAWAL.bold);
    expect(arabicFontFamily(700)).toBe(TAJAWAL.bold);
  });

  it("loads exactly the families the helper can return", () => {
    const app = text(join(mobile, "App.tsx"));
    for (const family of Object.values(TAJAWAL)) {
      expect(app, family).toContain(`[TAJAWAL.${Object.entries(TAJAWAL).find(([, v]) => v === family)![0]}]`);
    }
  });
});

describe("source guards", () => {
  it("has files to guard", () => {
    expect(sourceFiles.map(rel)).toEqual(expect.arrayContaining(["App.tsx", "src/screens/HomeScreen.tsx", "src/components/AppText.tsx"]));
  });

  it("styles nothing by physical side, which would not flip in Arabic", () => {
    // Use start/end, marginStart/paddingEnd, borderStartWidth and so on. A line may opt out
    // with "ltr-content" when it holds text that is always left to right (URLs, keys, emails).
    const physical =
      /\b(left|right|marginLeft|marginRight|paddingLeft|paddingRight|borderLeftWidth|borderRightWidth|borderLeftColor|borderRightColor)\s*:|textAlign\s*:\s*["'](left|right)["']/;
    const offenders: string[] = [];
    for (const path of sourceFiles) {
      text(path).split(/\r?\n/).forEach((line, index) => {
        if (physical.test(line) && !line.includes("ltr-content")) offenders.push(`${rel(path)}:${index + 1}  ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it("takes Text and TextInput from AppText so Arabic gets its font", () => {
    const offenders: string[] = [];
    for (const path of sourceFiles) {
      if (rel(path) === "src/components/AppText.tsx") continue;
      for (const match of text(path).matchAll(/import\s*\{([^}]*)\}\s*from\s*["']react-native["']/g)) {
        if (/\b(Text|TextInput)\b/.test(match[1].replace(/\bas\s+\w+/g, ""))) offenders.push(rel(path));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("applies the language's direction to the whole app and to navigation", () => {
    const app = text(join(mobile, "App.tsx"));
    expect(app).toMatch(/direction:\s*layoutDirection\(/);
    expect(app).toMatch(/<NavigationContainer\s+direction=\{layoutDirection\(/);
  });

  it("draws the Projects headers in JavaScript, never the native stack header", () => {
    const app = text(join(mobile, "App.tsx"));
    expect(app).toMatch(/<ProjectsStack\.Navigator\s+screenOptions=\{\{\s*headerShown:\s*false\s*\}\}/);
    expect(text(join(mobile, "src/screens/ProjectsScreen.tsx"))).toContain("<ScreenHeader");
    // The detail screen draws it twice: while the project loads, and once it has loaded.
    const detail = text(join(mobile, "src/screens/ProjectDetailScreen.tsx"));
    expect(detail.match(/<ScreenHeader[^>]*onBack=/g) ?? []).toHaveLength(2);
  });

  it("switches language without a restart but keeps the phone's own direction in step", () => {
    const settings = text(join(mobile, "src/screens/SettingsScreen.tsx"));
    expect(settings).toContain("syncNativeDirection(lang)");
    expect(settings).not.toMatch(/reloadAsync|DevSettings|exitApp/);
    expect(text(join(mobile, "App.tsx"))).toContain("syncNativeDirection(language)");
  });
});
