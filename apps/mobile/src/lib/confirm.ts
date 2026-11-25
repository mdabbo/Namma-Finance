import { Alert, Platform } from "react-native";

/**
 * Asks before an action that cannot be taken back from the phone. On the web
 * preview Alert has no buttons, so the browser's own confirm is used.
 */
export function confirmAction(
  title: string,
  message: string,
  labels: { yes: string; no: string },
  onYes: () => void,
  style: "default" | "destructive" = "default",
): void {
  if (Platform.OS === "web") {
    if (globalThis.confirm?.(`${title}\n\n${message}`)) onYes();
    return;
  }
  Alert.alert(title, message, [
    { text: labels.no, style: "cancel" },
    { text: labels.yes, style, onPress: onYes },
  ]);
}
