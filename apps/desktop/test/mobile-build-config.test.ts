import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The Android APK is built in the cloud by EAS from apps/mobile/eas.json
 * (plan step F3). Nothing builds it in CI, so these checks keep the build
 * profile from drifting away from the repository it is built from.
 */

const read = (path: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../../${path}`, import.meta.url)), "utf8"));

const root = read("package.json");
const app = read("apps/mobile/app.json").expo;
const eas = read("apps/mobile/eas.json");

describe("mobile APK build profile", () => {
  it("produces an installable APK for internal distribution, not a store bundle", () => {
    expect(eas.build.apk.distribution).toBe("internal");
    expect(eas.build.apk.android.buildType).toBe("apk");
  });

  it("installs with the repository's own pnpm and Node", () => {
    expect(`pnpm@${eas.build.apk.pnpm}`).toBe(root.packageManager);
    const easMajor = Number(String(eas.build.apk.node).split(".")[0]);
    const required = Number(/(\d+)/.exec(root.engines.node)![1]);
    expect(easMajor).toBeGreaterThanOrEqual(required);
  });

  it("lets EAS raise the build number so each APK installs over the last", () => {
    expect(eas.cli.appVersionSource).toBe("remote");
    expect(eas.build.apk.autoIncrement).toBe(true);
  });

  it("keeps the Android application id an installed phone already knows", () => {
    // Changing it makes Android treat the next APK as a different app: the old
    // one stays installed and the saved sign-in is not carried over.
    expect(app.android.package).toBe("com.mepfinance.mobile");
  });
});

describe("the DABWORKS logo on the phone", () => {
  const mobileFile = (path: string) => readFileSync(fileURLToPath(new URL(`../../mobile/${path}`, import.meta.url)));

  it("uses the brand's navy app icon behind the white D", () => {
    // Brand package: app icons are AppIcon_Navy (white D, orange cut, Deep Navy).
    expect(app.android.adaptiveIcon.backgroundColor).toBe("#0B2545");
  });

  it("shows the official logo artwork, never a redrawn mark", () => {
    const logo = mobileFile("src/components/BrandLogo.tsx").toString();
    expect(logo).toContain("assets/brand/wordmark-fullcolor.png");
    expect(logo).toContain("assets/brand/horizontal-fullcolor.png");
    for (const file of ["wordmark-fullcolor.png", "horizontal-fullcolor.png"]) {
      // PNG signature: the files are the package's images, not placeholders.
      expect(mobileFile(`assets/brand/${file}`).subarray(1, 4).toString()).toBe("PNG");
    }
    const home = mobileFile("src/screens/HomeScreen.tsx").toString();
    expect(home).toContain('<BrandLogo variant="wordmark"');
    expect(home).not.toMatch(/markSlash|>D<[/]Text>/);
    expect(mobileFile("src/screens/SetupScreen.tsx").toString()).toContain('<BrandLogo variant="horizontal"');
  });
});
