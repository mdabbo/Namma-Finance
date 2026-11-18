import { StyleSheet, Text as RNText, TextInput as RNTextInput, type TextInputProps, type TextProps, type TextStyle } from "react-native";
import { useTranslation } from "react-i18next";
import { fontFamilyFor } from "../lib/layout";

/**
 * Text and TextInput that use Tajawal when the app is in Arabic. Every screen
 * imports these instead of react-native's own (a test enforces it), so the
 * brand's Arabic font cannot be skipped by accident.
 */

function withFont(style: TextProps["style"], language: string): TextProps["style"] {
  const flat = (StyleSheet.flatten(style) ?? {}) as TextStyle;
  const fontFamily = flat.fontFamily ?? fontFamilyFor(language, flat.fontWeight);
  if (!fontFamily) return style;
  // The weight is part of the family now; leaving it would embolden twice.
  return [style, { fontFamily, fontWeight: "normal" }];
}

export function Text({ style, ...rest }: TextProps) {
  const { i18n } = useTranslation();
  return <RNText {...rest} style={withFont(style, i18n.language)} />;
}

export function TextInput({ style, ...rest }: TextInputProps) {
  const { i18n } = useTranslation();
  return <RNTextInput {...rest} style={withFont(style, i18n.language)} />;
}
