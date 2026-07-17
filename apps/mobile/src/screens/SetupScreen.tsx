import { useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { useTranslation } from "react-i18next";
import { getClient, saveConfig, type SyncConfig } from "../lib/supabase";
import { card, colors } from "../lib/theme";

/**
 * First-run + sign-in screen: the same Supabase URL / anon key / office
 * login used in the desktop's Settings → Cloud sync.
 */
export function SetupScreen({
  initial,
  onSignedIn,
}: {
  initial: SyncConfig | null;
  onSignedIn: (config: SyncConfig) => void;
}) {
  const { t } = useTranslation();
  const [url, setUrl] = useState(initial?.url ?? "");
  const [anonKey, setAnonKey] = useState(initial?.anonKey ?? "");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = url.trim() !== "" && anonKey.trim() !== "" && email.trim() !== "" && password !== "" && !busy;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const config: SyncConfig = { url: url.trim().replace(/\/+$/, ""), anonKey: anonKey.trim() };
      const client = getClient(config);
      const { error: authError } = await client.auth.signInWithPassword({ email: email.trim(), password });
      if (authError) throw new Error(authError.message);
      await saveConfig(config);
      onSignedIn(config);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>{t("common.appName")}</Text>
        <Text style={styles.tagline}>{t("common.tagline")}</Text>

        <View style={[card, styles.form]}>
          <Field label={t("settings.syncUrl")} value={url} onChange={setUrl} placeholder="https://xxxx.supabase.co" autoCapitalize="none" />
          <Field label={t("settings.syncAnonKey")} value={anonKey} onChange={setAnonKey} placeholder="eyJ…" autoCapitalize="none" secure />
          <Field label={t("settings.syncEmail")} value={email} onChange={setEmail} keyboardType="email-address" autoCapitalize="none" />
          <Field label={t("settings.syncPassword")} value={password} onChange={setPassword} secure />

          {error && <Text style={styles.error}>{error}</Text>}

          <TouchableOpacity style={[styles.button, !canSubmit && styles.buttonDisabled]} disabled={!canSubmit} onPress={() => void submit()}>
            {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>{t("settings.syncSignIn")}</Text>}
          </TouchableOpacity>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  secure,
  keyboardType,
  autoCapitalize,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  secure?: boolean;
  keyboardType?: "email-address";
  autoCapitalize?: "none";
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        style={styles.input}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={colors.faint}
        secureTextEntry={secure}
        keyboardType={keyboardType}
        autoCapitalize={autoCapitalize}
        autoCorrect={false}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  container: { flexGrow: 1, justifyContent: "center", padding: 20 },
  title: { fontSize: 28, fontWeight: "700", color: colors.text, textAlign: "center" },
  tagline: { fontSize: 13, color: colors.subtle, textAlign: "center", marginBottom: 24, fontStyle: "italic" },
  form: { gap: 12 },
  field: { gap: 4 },
  label: { fontSize: 12, color: colors.subtle, fontWeight: "600" },
  input: {
    borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12,
    paddingVertical: 10, fontSize: 14, color: colors.text, backgroundColor: "#fff",
  },
  error: { color: colors.red, fontSize: 13 },
  button: { backgroundColor: colors.brand, borderRadius: 10, paddingVertical: 12, alignItems: "center", marginTop: 4 },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { color: "#fff", fontWeight: "600", fontSize: 15 },
});
