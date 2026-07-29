import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

/**
 * End-to-end mode only. Two capabilities live outside the WebView in the real
 * app — the SQL plugin and the Rust-enforced app lock — so a browser cannot
 * reach them and the app would fail closed on the lock screen with no data.
 * These modules are swapped for bridges that talk to a real SQLite instance
 * running the real migrations. Matching on the RESOLVED path covers every
 * relative spelling ("./db", "../lib/db"). Never active in a production build.
 */
const E2E_BRIDGED_MODULES = ["db", "lock"];

function e2eBridge(): Plugin {
  return {
    name: "mep-e2e-bridge",
    enforce: "pre",
    async resolveId(source, importer, options) {
      const target = E2E_BRIDGED_MODULES.find(
        (name) => source === `./${name}` || source.endsWith(`/lib/${name}`),
      );
      if (!target) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (!resolved) return null;
      const pattern = new RegExp(`[\\\\/]src[\\\\/]lib[\\\\/]${target}\\.ts$`);
      if (!pattern.test(resolved.id)) return null;
      const bridged = resolved.id.replace(/\.ts$/, ".e2e.ts");
      // The bridge itself re-exports pure helpers from the real module; never
      // redirect it onto itself.
      return importer && importer === bridged ? null : bridged;
    },
  };
}

export default defineConfig(async ({ command, mode }) => ({
  plugins: [
    react(),
    tailwindcss(),
    // Dev server only. `mode` is a user-supplied flag, so gating on it alone
    // would let `vite build --mode e2e` emit a shippable bundle whose database
    // is a plain HTTP endpoint and whose app lock never consults Rust. A build
    // never gets the bridges, whatever mode it is given.
    ...(command === "serve" && mode === "e2e" ? [e2eBridge()] : []),
  ],
  optimizeDeps: {
    // @mep/core is raw workspace TypeScript — let Vite transform it directly
    exclude: ["@mep/core"],
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
    fs: {
      // allow importing @mep/core sources from the workspace root
      allow: ["../.."],
    },
  },
}));
