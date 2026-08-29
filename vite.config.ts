import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const host = process.env.TAURI_DEV_HOST;

// mode "web" = the GitHub Pages build (ffmpeg.wasm engine, /Kecilin/ base).
export default defineConfig(({ mode }) => ({
  base: mode === "web" ? "/Kecilin/" : "/",
  define: {
    __APP_VERSION__: JSON.stringify(process.env.npm_package_version ?? "dev"),
  },
  plugins: [
    react(),
    tailwindcss(),
    {
      name: "kecilin-coi-inject",
      // SharedArrayBuffer (multithreaded wasm) needs COOP/COEP headers, which
      // GitHub Pages can't set — coi-serviceworker injects them client-side.
      transformIndexHtml(html: string) {
        return mode === "web"
          ? html.replace(
              "</title>",
              '</title>\n    <script src="/Kecilin/coi-serviceworker.min.js"></script>',
            )
          : html;
      },
    },
  ],

  // Vite options tailored for Tauri development:
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    // 3. tell Vite to ignore watching `src-tauri`
    watch: { ignored: ["**/src-tauri/**"] },
  },
}));
