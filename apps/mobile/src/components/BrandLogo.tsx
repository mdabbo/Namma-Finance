import { Image, type ImageStyle, type StyleProp } from "react-native";

/**
 * The official DABWORKS logo, copied unchanged from the brand package
 * (DABWORKS_Brand_System/01_Logo_Master_Pack/PNG). Never redraw it: the
 * package says these are exact copies of the client artwork.
 *
 *  - "wordmark": DABWORKS without the tagline, for small sizes (app headers).
 *  - "horizontal": the primary logo with "Engineering That Works.".
 *
 * Both are the FullColor variant, for light backgrounds. Sized by height; the
 * width follows the artwork's own proportions.
 */
// Metro bundles images only through a static require(); an import would need
// image module typings this app does not declare.
/* eslint-disable @typescript-eslint/no-require-imports */
const LOGOS = {
  wordmark: { source: require("../../assets/brand/wordmark-fullcolor.png"), ratio: 1200 / 141 },
  horizontal: { source: require("../../assets/brand/horizontal-fullcolor.png"), ratio: 1200 / 248 },
} as const;
/* eslint-enable @typescript-eslint/no-require-imports */

export function BrandLogo({ variant, height, style }: { variant: keyof typeof LOGOS; height: number; style?: StyleProp<ImageStyle> }) {
  const logo = LOGOS[variant];
  return (
    <Image
      source={logo.source}
      style={[{ height, width: Math.round(height * logo.ratio) }, style]}
      resizeMode="contain"
      accessibilityRole="image"
      accessibilityLabel="DABWORKS"
    />
  );
}
