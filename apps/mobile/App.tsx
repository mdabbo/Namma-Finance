import { useEffect, useMemo, useState, type ReactNode } from "react";
import { StatusBar } from "expo-status-bar";
import { ActivityIndicator, View } from "react-native";
import { useFonts } from "expo-font";
import { Tajawal_400Regular, Tajawal_500Medium, Tajawal_700Bold } from "@expo-google-fonts/tajawal";
import { NavigationContainer } from "@react-navigation/native";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import i18n, { initI18n } from "./src/lib/i18n";
import { getClient, getSession, loadConfig, loadLanguage, type SyncConfig } from "./src/lib/supabase";
import { SupabaseContext } from "./src/hooks/useWorkspace";
import { ReportingCurrencyProvider } from "./src/hooks/useReportingCurrency";
import { SetupScreen } from "./src/screens/SetupScreen";
import { HomeScreen } from "./src/screens/HomeScreen";
import { ProjectsScreen } from "./src/screens/ProjectsScreen";
import { ProjectDetailScreen } from "./src/screens/ProjectDetailScreen";
import { PayTeamScreen } from "./src/screens/PayTeamScreen";
import { SettingsScreen } from "./src/screens/SettingsScreen";
import { TimeScreen } from "./src/screens/TimeScreen";
import { ClaimsScreen } from "./src/screens/ClaimsScreen";
import { TimeQueueProvider } from "./src/hooks/useTimeQueue";
import { AppLockGate } from "./src/hooks/useAppLock";
import { fetchServerNow } from "./src/lib/timeEntriesCloud";
import { colors } from "./src/lib/theme";
import { fontFamilyFor, layoutDirection, TAJAWAL } from "./src/lib/layout";
import { Icon, type IconName } from "./src/components/ui";

const TAB_ICONS: Record<string, IconName> = { Home: "home", Projects: "briefcase", Time: "clock", Claims: "file-text", Settings: "settings" };
import { syncNativeDirection } from "./src/lib/nativeDirection";
import type { ProjectsStackParams } from "./src/navigation";

/**
 * `EXPO_PUBLIC_PREVIEW=1 pnpm web` opens the app in a browser on made-up data,
 * with no login, for looking at screens. The flag is fixed when the app is
 * bundled, so the installed APK drops the preview code altogether.
 */
const PREVIEW = process.env.EXPO_PUBLIC_PREVIEW === "1";
const PREVIEW_CONFIG: SyncConfig = { url: "preview", anonKey: "preview" };

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1 } } });
const Tabs = createBottomTabNavigator();
const ProjectsStack = createNativeStackNavigator<ProjectsStackParams>();

type Boot =
  | { phase: "loading" }
  | { phase: "setup"; config: SyncConfig | null }
  | { phase: "ready"; config: SyncConfig };

export default function App() {
  const [boot, setBoot] = useState<Boot>({ phase: "loading" });
  // Arabic uses Tajawal. A font that fails to load must not lock the app out:
  // the screens then fall back to the phone's own font.
  const [fontsLoaded, fontError] = useFonts({
    [TAJAWAL.regular]: Tajawal_400Regular,
    [TAJAWAL.medium]: Tajawal_500Medium,
    [TAJAWAL.bold]: Tajawal_700Bold,
  });

  useEffect(() => {
    void (async () => {
      const language = await loadLanguage();
      initI18n(language);
      syncNativeDirection(language);
      if (PREVIEW) return setBoot({ phase: "ready", config: PREVIEW_CONFIG });
      const config = await loadConfig();
      if (!config) return setBoot({ phase: "setup", config: null });
      const session = await getSession(config).catch(() => null);
      setBoot(session ? { phase: "ready", config } : { phase: "setup", config });
    })();
  }, []);

  if (boot.phase === "loading" || !(fontsLoaded || fontError)) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.bg }}>
        <ActivityIndicator color={colors.brand} size="large" />
      </View>
    );
  }

  if (boot.phase === "setup") {
    return (
      <DirectionRoot>
        <StatusBar style="dark" />
        <SetupScreen initial={boot.config} onSignedIn={(config) => setBoot({ phase: "ready", config })} />
      </DirectionRoot>
    );
  }

  return (
    <DirectionRoot>
      <AppLockGate>
      <QueryClientProvider client={queryClient}>
        <SupabaseContext.Provider value={PREVIEW ? previewClient() : getClient(boot.config)}>
          <StatusBar style="dark" />
          <ReportingCurrencyProvider>
          <TimeQueueProvider serverNow={serverClock(boot.config)}>
          <MainNavigator onSignedOut={() => setBoot({ phase: "setup", config: boot.config })} />
          </TimeQueueProvider>
          </ReportingCurrencyProvider>
        </SupabaseContext.Provider>
      </QueryClientProvider>
      </AppLockGate>
    </DirectionRoot>
  );
}

let preview: ReturnType<typeof getClient> | null = null;
function previewClient() {
  // Required here, not imported at the top, so a build without the flag leaves it out.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  preview ??= (require("./src/preview/previewClient") as typeof import("./src/preview/previewClient")).createPreviewClient();
  return preview;
}

/**
 * Lays the whole app out right-to-left or left-to-right from the app's own
 * language. It is an explicit style on the root view, so switching language
 * in Settings re-lays-out every screen at once, with no restart.
 */
function DirectionRoot({ children }: { children: ReactNode }) {
  const { i18n: instance } = useTranslation();
  // The safe-area provider sits at the root so every screen, the sign-in one
  // included, can keep clear of the status bar and the gesture bar.
  return (
    <SafeAreaProvider>
      <View style={{ flex: 1, direction: layoutDirection(instance.language) }}>{children}</View>
    </SafeAreaProvider>
  );
}

function MainNavigator({ onSignedOut }: { onSignedOut: () => void }) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  // re-render the tab titles when the language switches
  const lang = i18n.language;
  const screens = useMemo(
    () => ({
      home: t("nav.dashboard"),
      projects: t("nav.projects"),
      time: t("nav.time"),
      claims: t("mobile.claimsTab"),
      settings: t("nav.settings"),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lang, t],
  );

  return (
    <NavigationContainer direction={layoutDirection(lang)}>
      <Tabs.Navigator
        screenOptions={({ route }) => ({
          // Every screen draws its own header, so it follows the app's direction.
          headerShown: false,
          tabBarActiveTintColor: colors.brand,
          tabBarInactiveTintColor: colors.faint,
          tabBarLabelStyle: { fontSize: 11, lineHeight: 18, fontWeight: "600", fontFamily: fontFamilyFor(lang, "600") },
          // Room for an icon and a Tajawal label, plus the phone's own bottom inset
          // (gesture bar or buttons), so nothing sits under the system bar.
          tabBarStyle: { borderTopColor: colors.border, height: 68 + insets.bottom, paddingTop: 6, paddingBottom: 10 + insets.bottom },
          tabBarIcon: ({ color }) => <Icon name={TAB_ICONS[route.name] ?? "circle"} size={21} color={color} />,
        })}
      >
        <Tabs.Screen name="Home" component={HomeScreen} options={{ title: screens.home }} />
        <Tabs.Screen name="Projects" options={{ title: screens.projects }}>
          {() => (
            // Both screens draw their own header (see ScreenHeader): the native
            // one would stay on the phone's layout direction.
            <ProjectsStack.Navigator screenOptions={{ headerShown: false }}>
              <ProjectsStack.Screen name="ProjectsList" component={ProjectsScreen} options={{ title: screens.projects }} />
              <ProjectsStack.Screen name="ProjectDetail" component={ProjectDetailScreen} options={{ title: screens.projects }} />
              <ProjectsStack.Screen name="PayTeam" component={PayTeamScreen} options={{ title: screens.projects }} />
            </ProjectsStack.Navigator>
          )}
        </Tabs.Screen>
        <Tabs.Screen name="Time" component={TimeScreen} options={{ title: screens.time }} />
        <Tabs.Screen name="Claims" component={ClaimsScreen} options={{ title: screens.claims }} />
        <Tabs.Screen name="Settings" options={{ title: screens.settings }}>
          {() => <SettingsScreen onSignedOut={onSignedOut} />}
        </Tabs.Screen>
      </Tabs.Navigator>
    </NavigationContainer>
  );
}

/**
 * The cloud's clock, for stamping time entries (see lib/timeQueue.ts). The
 * browser preview has no cloud, so it uses the computer's clock.
 */
const clocks = new Map<string, () => Promise<number>>();
function serverClock(config: SyncConfig): () => Promise<number> {
  const key = `${config.url}::${config.anonKey}`;
  let clock = clocks.get(key);
  if (!clock) {
    clock = PREVIEW ? async () => Date.now() : () => fetchServerNow(config.url, config.anonKey);
    clocks.set(key, clock);
  }
  return clock;
}
