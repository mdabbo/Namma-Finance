import { I18nManager } from "react-native";
import { layoutDirection } from "./layout";

/**
 * Keep the phone's own layout direction in step with the app language for the
 * NEXT cold start. The app's layout does not wait for it (App.tsx applies an
 * explicit direction), but the system pieces the app cannot style, such as the
 * pull-to-refresh spinner and scroll bars, follow I18nManager. It only changes
 * after the app is fully closed and reopened, so nothing here restarts the app.
 */
export function syncNativeDirection(language: string): void {
  const rtl = layoutDirection(language) === "rtl";
  I18nManager.allowRTL(rtl);
  if (I18nManager.isRTL !== rtl) I18nManager.forceRTL(rtl);
}
