// Bundles python/bridge/server.ts — the Node side of the `openflume` Python
// package — into a single self-contained ESM file plus coolprop.wasm, written
// into the Python package tree (python/src/openflume/_js/). Run via
// `npm run build:python`; the output is a build artifact (gitignored) that
// the wheel and sdist ship.
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { defineConfig } from "vite";

const require = createRequire(import.meta.url);
const outDir = resolve(import.meta.dirname, "python/src/openflume/_js");
const pkg = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "package.json"), "utf8"),
) as { version: string };

export default defineConfig({
  define: {
    __OPENFLUME_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    outDir,
    emptyOutDir: true,
    target: "node22",
    minify: false,
    sourcemap: false,
    copyPublicDir: false,
    // Self-contained: no node_modules at runtime.
    ssr: resolve(import.meta.dirname, "python/bridge/server.ts"),
    rolldownOptions: {
      // coolprop-wasm/index.js guards a CommonJS `module.exports` assignment
      // behind a typeof check; harmless in the ESM bundle.
      onLog(level, log, handler) {
        if (log.code === "COMMONJS_VARIABLE_IN_ESM") return;
        handler(level, log);
      },
      output: {
        format: "es",
        entryFileNames: "openflume-bridge.mjs",
        codeSplitting: false,
      },
    },
  },
  ssr: {
    noExternal: true,
    target: "node",
  },
  plugins: [
    {
      // coolprop-wasm's Emscripten loader resolves
      // new URL("coolprop.wasm", import.meta.url) and reads it with fs, so the
      // wasm must sit next to the bundle under its original name.
      name: "openflume-copy-coolprop-wasm",
      apply: "build",
      writeBundle() {
        const wasm = join(
          dirname(require.resolve("coolprop-wasm")),
          "coolprop.wasm",
        );
        mkdirSync(outDir, { recursive: true });
        copyFileSync(wasm, join(outDir, "coolprop.wasm"));
        // hatchling needs the license inside the Python project root.
        copyFileSync(
          resolve(import.meta.dirname, "LICENSE"),
          resolve(import.meta.dirname, "python/LICENSE"),
        );
      },
    },
  ],
});
