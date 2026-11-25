import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { LOCK_AFTER_MS, lockEnabled, lockOnResume } from "../../mobile/src/lib/appLock";

/**
 * The phone app's lock: the phone's own fingerprint, face or PIN on reopen.
 * The rules are tested directly; the wiring, which needs a phone, is held in
 * place by source guards.
 */

const mobile = (path: string) => readFileSync(fileURLToPath(new URL(`../../mobile/${path}`, import.meta.url)), "utf8");

describe("when the lock is on", () => {
  const PIN = 1; // SecurityLevel.SECRET
  const FINGERPRINT = 3; // SecurityLevel.BIOMETRIC_STRONG

  it("is on by default on a phone with a screen lock", () => {
    expect(lockEnabled(null, PIN)).toBe(true);
    expect(lockEnabled(null, FINGERPRINT)).toBe(true);
  });

  it("follows the user's choice", () => {
    expect(lockEnabled("0", FINGERPRINT)).toBe(false);
    expect(lockEnabled("1", FINGERPRINT)).toBe(true);
  });

  it("is off on a phone with no screen lock, which could never unlock it", () => {
    expect(lockEnabled(null, 0)).toBe(false);
    expect(lockEnabled("1", 0)).toBe(false);
  });
});

describe("when coming back locks", () => {
  const t = 1_000_000;

  it("does not lock after a short trip to another app", () => {
    expect(lockOnResume(t, t + LOCK_AFTER_MS - 1)).toBe(false);
    expect(lockOnResume(t, t + 5_000)).toBe(false);
  });

  it("locks after a minute or more away", () => {
    expect(LOCK_AFTER_MS).toBe(60_000);
    expect(lockOnResume(t, t + LOCK_AFTER_MS)).toBe(true);
    expect(lockOnResume(t, t + 3_600_000)).toBe(true);
  });

  it("locks when the clock moved backwards", () => {
    expect(lockOnResume(t, t - 1)).toBe(true);
  });

  it("does not lock without a trip to the background", () => {
    expect(lockOnResume(null, t)).toBe(false);
  });
});

describe("the lock's wiring", () => {
  const app = mobile("App.tsx");
  const gate = mobile("src/hooks/useAppLock.tsx");
  const settings = mobile("src/screens/SettingsScreen.tsx");

  it("covers everything the signed-in app shows", () => {
    const opened = app.indexOf("<AppLockGate>");
    const closed = app.indexOf("</AppLockGate>");
    expect(opened).toBeGreaterThan(-1);
    expect(app.indexOf("<QueryClientProvider")).toBeGreaterThan(opened);
    expect(app.indexOf("<MainNavigator")).toBeGreaterThan(opened);
    expect(app.indexOf("<MainNavigator")).toBeLessThan(closed);
  });

  it("starts covered, so nothing shows before the lock is decided", () => {
    expect(gate).toMatch(/useState<Phase>\("checking"\)/);
    expect(gate).toMatch(/phase !== "open" \? <LockCover/);
  });

  it("locks on coming back only through the tested rule", () => {
    expect(gate).toMatch(/lockOnResume\(backgroundAt\.current, Date\.now\(\)\)\) setPhase\("locked"\)/);
    // The phone's own prompt can send the app to the background; that is not leaving.
    expect(gate).toMatch(/if \(asking\.current\) return;/);
  });

  it("asks for the phone's lock before the setting can change", () => {
    const setter = gate.slice(gate.indexOf("setEnabled: async"));
    expect(setter.indexOf("await ask()")).toBeGreaterThan(-1);
    expect(setter.indexOf("await ask()")).toBeLessThan(setter.indexOf("AsyncStorage.setItem"));
    expect(settings).toContain("lock.setEnabled(on)");
  });

  it("lets the phone's PIN stand in for a fingerprint", () => {
    expect(gate).toContain("disableDeviceFallback: false");
  });
});
