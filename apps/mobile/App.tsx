import { useEffect, useMemo, useState } from "react";
import { StatusBar } from "expo-status-bar";
import { ActivityIndicator, View } from "react-native";
import { NavigationContainer } from "@react-navigation/native";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import i18n, { initI18n } from "./src/lib/i18n";
import { getClient, getSession, loadConfig, loadLanguage, type SyncConfig } from "./src/lib/supabase";
import { SupabaseContext } from "./src/hooks/useWorkspace";
import { SetupScreen } from "./src/screens/SetupScreen";
import { HomeScreen } from "./src/screens/HomeScreen";
import { ProjectsScreen } from "./src/screens/ProjectsScreen";
import { ProjectDetailScreen } from "./src/screens/ProjectDetailScreen";
import { SettingsScreen } from "./src/screens/SettingsScreen";
import { colors } from "./src/lib/theme";
import type { ProjectsStackParams } from "./src/navigation";

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1 } } });
const Tabs = createBottomTabNavigator();
const ProjectsStack = createNativeStackNavigator<ProjectsStackParams>();

type Boot =
  | { phase: "loading" }
  | { phase: "setup"; config: SyncConfig | null }
  | { phase: "ready"; config: SyncConfig };

export default function App() {
  const [boot, setBoot] = useState<Boot>({ phase: "loading" });

  useEffect(() => {
    void (async () => {
      initI18n(await loadLanguage());
      const config = await loadConfig();
      if (!config) return setBoot({ phase: "setup", config: null });
      const session = await getSession(config).catch(() => null);
      setBoot(session ? { phase: "ready", config } : { phase: "setup", config });
    })();
  }, []);

  if (boot.phase === "loading") {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.bg }}>
        <ActivityIndicator color={colors.brand} size="large" />
      </View>
    );
  }

  if (boot.phase === "setup") {
    return (
      <>
        <StatusBar style="dark" />
        <SetupScreen initial={boot.config} onSignedIn={(config) => setBoot({ phase: "ready", config })} />
      </>
    );
  }

  return (
    <QueryClientProvider client={queryClient}>
      <SupabaseContext.Provider value={getClient(boot.config)}>
        <StatusBar style="dark" />
        <MainNavigator onSignedOut={() => setBoot({ phase: "setup", config: boot.config })} />
      </SupabaseContext.Provider>
    </QueryClientProvider>
  );
}

function MainNavigator({ onSignedOut }: { onSignedOut: () => void }) {
  const { t } = useTranslation();
  // re-render the tab titles when the language switches
  const lang = i18n.language;
  const screens = useMemo(
    () => ({
      home: t("nav.dashboard"),
      projects: t("nav.projects"),
      settings: t("nav.settings"),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lang, t],
  );

  return (
    <NavigationContainer>
      <Tabs.Navigator
        screenOptions={{
          headerTitleStyle: { fontSize: 16, fontWeight: "700" },
          tabBarActiveTintColor: colors.brand,
          tabBarInactiveTintColor: colors.faint,
          tabBarLabelStyle: { fontSize: 11, fontWeight: "600" },
          tabBarIconStyle: { display: "none" },
        }}
      >
        <Tabs.Screen name="Home" component={HomeScreen} options={{ title: screens.home }} />
        <Tabs.Screen name="Projects" options={{ title: screens.projects, headerShown: false }}>
          {() => (
            <ProjectsStack.Navigator>
              <ProjectsStack.Screen name="ProjectsList" component={ProjectsScreen} options={{ title: screens.projects }} />
              <ProjectsStack.Screen name="ProjectDetail" component={ProjectDetailScreen} options={{ title: "" }} />
            </ProjectsStack.Navigator>
          )}
        </Tabs.Screen>
        <Tabs.Screen name="Settings" options={{ title: screens.settings }}>
          {() => <SettingsScreen onSignedOut={onSignedOut} />}
        </Tabs.Screen>
      </Tabs.Navigator>
    </NavigationContainer>
  );
}
