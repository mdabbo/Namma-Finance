import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AppState, Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as LocalAuthentication from "expo-local-authentication";
import { Text } from "../components/AppText";
import { BrandLogo } from "../components/BrandLogo";
import { Icon } from "../components/ui";
import { LOCK_SETTING_KEY, lockEnabled, lockOnResume, SECURITY_NONE } from "../lib/appLock";
import { colors, radius, space, type } from "../lib/theme";

/**
 * Covers the app with a lock screen until the phone's own lock (fingerprint,
 * face, or the phone's PIN or pattern) is passed. See lib/appLock.ts for when.
 *
 * The screens stay mounted under the cover, so a half-filled form is still
 * there after unlocking.
 */

type Phase = "checking" | "locked" | "open";

interface AppLockApi {
  /** Whether the phone has a screen lock the app can ask for. */
  available: boolean;
  enabled: boolean;
  /** Turns the lock on or off; asks for the phone's lock first. False if not passed. */
  setEnabled(on: boolean): Promise<boolean>;
}

const AppLockContext = createContext<AppLockApi | null>(null);

export function useAppLock(): AppLockApi {
  const api = useContext(AppLockContext);
  if (!api) throw new Error("AppLockGate missing");
  return api;
}

async function securityLevel(): Promise<number> {
  try {
    return await LocalAuthentication.getEnrolledLevelAsync();
  } catch {
    return SECURITY_NONE;
  }
}

export function AppLockGate({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>("checking");
  const [available, setAvailable] = useState(false);
  const [enabled, setEnabledState] = useState(false);
  const [failed, setFailed] = useState(false);
  const enabledRef = useRef(false);
  const backgroundAt = useRef<number | null>(null);
  // The phone's own prompt (and its PIN screen) can send the app to the
  // background; that must not count as leaving the app.
  const asking = useRef(false);

  const ask = useCallback(async (): Promise<boolean> => {
    if (asking.current) return false;
    asking.current = true;
    try {
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: t("mobile.lockPrompt"),
        cancelLabel: t("common.cancel"),
        disableDeviceFallback: false,
      });
      return result.success;
    } catch {
      return false;
    } finally {
      asking.current = false;
      backgroundAt.current = null;
    }
  }, [t]);

  const unlock = useCallback(async () => {
    setFailed(false);
    if (await ask()) setPhase("open");
    else setFailed(true);
  }, [ask]);

  // Opening the app from closed.
  useEffect(() => {
    void (async () => {
      const [level, stored] = await Promise.all([securityLevel(), AsyncStorage.getItem(LOCK_SETTING_KEY).catch(() => null)]);
      const on = lockEnabled(stored, level);
      setAvailable(level > SECURITY_NONE);
      setEnabledState(on);
      enabledRef.current = on;
      setPhase(on ? "locked" : "open");
    })();
  }, []);

  // Leaving and coming back.
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (status) => {
      if (asking.current) return;
      if (status === "background") {
        backgroundAt.current = Date.now();
      } else if (status === "active") {
        if (enabledRef.current && lockOnResume(backgroundAt.current, Date.now())) setPhase("locked");
        backgroundAt.current = null;
      }
    });
    return () => subscription.remove();
  }, []);

  // Ask straight away when the lock appears, while the app is in front.
  useEffect(() => {
    if (phase === "locked" && AppState.currentState === "active") void unlock();
  }, [phase, unlock]);

  const api = useMemo<AppLockApi>(
    () => ({
      available,
      enabled,
      setEnabled: async (on) => {
        if (!(await ask())) return false;
        await AsyncStorage.setItem(LOCK_SETTING_KEY, on ? "1" : "0").catch(() => undefined);
        enabledRef.current = on;
        setEnabledState(on);
        return true;
      },
    }),
    [available, enabled, ask],
  );

  return (
    <AppLockContext.Provider value={api}>
      {children}
      {phase !== "open" ? <LockCover checking={phase === "checking"} failed={failed} onUnlock={unlock} label={t("mobile.lockUnlock")} title={t("mobile.lockTitle")} retryHint={t("mobile.lockFailed")} /> : null}
    </AppLockContext.Provider>
  );
}

function LockCover({
  checking,
  failed,
  onUnlock,
  label,
  title,
  retryHint,
}: {
  checking: boolean;
  failed: boolean;
  onUnlock: () => void;
  label: string;
  title: string;
  retryHint: string;
}) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.cover, { paddingTop: insets.top + space.xxl, paddingBottom: insets.bottom + space.xxl }]} accessibilityViewIsModal>
      <BrandLogo variant="horizontal" height={48} />
      {checking ? null : (
        <View style={styles.body}>
          <View style={styles.lockBadge}>
            <Icon name="lock" size={28} color={colors.brand} />
          </View>
          <Text style={styles.title}>{title}</Text>
          {failed ? <Text style={styles.hint}>{retryHint}</Text> : null}
          <Pressable onPress={onUnlock} accessibilityRole="button" style={({ pressed }) => [styles.button, pressed && styles.pressed]}>
            <Icon name="unlock" size={18} color={colors.onBrand} />
            <Text style={styles.buttonText}>{label}</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  cover: { ...StyleSheet.absoluteFillObject, zIndex: 1000, elevation: 1000, backgroundColor: colors.bg, alignItems: "center", justifyContent: "space-between" },
  body: { alignItems: "center", gap: space.lg, paddingHorizontal: space.xl, marginBottom: space.xxl * 2 },
  lockBadge: { width: 64, height: 64, borderRadius: 32, alignItems: "center", justifyContent: "center", backgroundColor: colors.brandTint },
  title: { ...type.title, color: colors.text, textAlign: "center" },
  hint: { ...type.body, color: colors.subtle, textAlign: "center" },
  button: { flexDirection: "row", alignItems: "center", gap: space.sm, height: 50, paddingHorizontal: space.xxl, borderRadius: radius.md, backgroundColor: colors.brand },
  pressed: { opacity: 0.85 },
  buttonText: { fontSize: 16, fontWeight: "700", color: colors.onBrand },
});
