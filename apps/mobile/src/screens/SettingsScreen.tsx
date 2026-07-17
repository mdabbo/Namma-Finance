import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useTranslation } from "react-i18next";
import { useSupabase } from "../hooks/useWorkspace";
import { saveLanguage } from "../lib/supabase";
import { card, colors } from "../lib/theme";

export function SettingsScreen({ onSignedOut }: { onSignedOut: () => void }) {
  const { t, i18n } = useTranslation();
  const client = useSupabase();

  async function switchLanguage(lang: "ar" | "en") {
    await i18n.changeLanguage(lang);
    await saveLanguage(lang);
  }

  return (
    <View style={styles.screen}>
      <View style={[card, styles.section]}>
        <Text style={styles.label}>{t("settings.language")}</Text>
        <View style={styles.langRow}>
          <LangButton active={i18n.language === "ar"} label={t("settings.arabic")} onPress={() => void switchLanguage("ar")} />
          <LangButton active={i18n.language === "en"} label={t("settings.english")} onPress={() => void switchLanguage("en")} />
        </View>
      </View>

      <View style={[card, styles.section]}>
        <TouchableOpacity
          style={styles.signOut}
          onPress={() => {
            void client.auth.signOut().then(onSignedOut);
          }}
        >
          <Text style={styles.signOutText}>{t("settings.syncSignOut")}</Text>
        </TouchableOpacity>
      </View>

      <Text style={styles.note}>{t("dashboard.consolidatedNote", { currency: "EGP" })}</Text>
    </View>
  );
}

function LangButton({ active, label, onPress }: { active: boolean; label: string; onPress: () => void }) {
  return (
    <TouchableOpacity style={[styles.lang, active && styles.langActive]} onPress={onPress}>
      <Text style={[styles.langText, active && styles.langTextActive]}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg, padding: 14, gap: 12 },
  section: { gap: 8 },
  label: { fontSize: 12, color: colors.subtle, fontWeight: "600" },
  langRow: { flexDirection: "row", gap: 8 },
  lang: { flex: 1, borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingVertical: 10, alignItems: "center" },
  langActive: { backgroundColor: colors.chipBg, borderColor: colors.brand },
  langText: { fontSize: 14, color: colors.subtle },
  langTextActive: { color: colors.brand, fontWeight: "700" },
  signOut: { alignItems: "center", paddingVertical: 4 },
  signOutText: { color: colors.red, fontWeight: "600", fontSize: 14 },
  note: { textAlign: "center", fontSize: 11, color: colors.faint, marginTop: 8 },
});
