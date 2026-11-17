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
