import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: process.env.VITE_BASE_PATH ?? "/",
  plugins: [react()],
  // coolprop-wasm uses import.meta.url to resolve its side-car .wasm.
  // Vite's dep-pre-bundling rewrites the module into .vite/deps/ where the
  // wasm is missing, so the fetch hits the SPA fallback and returns HTML.
  // Excluding it keeps import.meta.url pointing at node_modules/coolprop-wasm/
  // where the wasm is co-located and served correctly by the dev server.
  optimizeDeps: {
    exclude: ["coolprop-wasm"],
  },
  // Forward library API calls to the local companion server (scripts/serve.ts)
  // so `npm run dev` works with the component library when `npm run serve` (or
  // `npx tsx scripts/serve.ts`) is running in another terminal. Without this,
  // /api/* hits the SPA fallback and returns index.html instead of JSON.
  server: {
    proxy: {
      "/api": {
        target: "http://127.0.0.1:4174",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
  worker: {
    format: "es",
  },
});
