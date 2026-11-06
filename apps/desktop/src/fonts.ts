/**
 * DABWORKS brand typefaces, self-hosted.
 *
 * The brand package specifies Montserrat for headings, Inter for body text and
 * Tajawal for Arabic (DABWORKS_Brand_System/04_Digital_Identity/Website/
 * dabworks-brand.css). The app's CSP allows `font-src 'self' data:` only, so
 * the Google Fonts link in that file cannot be used at runtime — these are
 * bundled by Vite and served from the app origin instead.
 *
 * Only the subsets the interface renders are imported; the full packages would
 * add several megabytes of unused scripts to the installer.
 */

// Montserrat — headings and the DABWORKS wordmark.
import "@fontsource/montserrat/latin-500.css";
import "@fontsource/montserrat/latin-600.css";
import "@fontsource/montserrat/latin-700.css";
import "@fontsource/montserrat/latin-800.css";

// Inter — body text, tables and forms.
import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-500.css";
import "@fontsource/inter/latin-600.css";
import "@fontsource/inter/latin-700.css";

// Tajawal — the Arabic side of the bilingual interface.
import "@fontsource/tajawal/arabic-400.css";
import "@fontsource/tajawal/arabic-500.css";
import "@fontsource/tajawal/arabic-700.css";
import "@fontsource/tajawal/arabic-800.css";
