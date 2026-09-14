import eslint from "@eslint/js";
import prettier from "eslint-config-prettier";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "coverage/**",
      "node_modules/**",
      "playwright-report/**",
      "test-results/**",
      "validation/**",
      ".venv*/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-empty-object-type": "warn",
      "@typescript-eslint/no-unused-expressions": "warn",
      "no-control-regex": "warn",
      "no-loss-of-precision": "warn",
      "no-useless-escape": "warn",
      "prefer-const": "warn",
    },
  },
  {
    files: ["**/*.tsx"],
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
    },
  },
  // ── Layering (docs/architecture.md "Dependency direction") ─────────────
  // Dependencies point inward: core ← substrate ← ui. Enforced here so the
  // documented boundary cannot erode one import at a time.
  {
    files: ["src/core/**/*.{ts,tsx}"],
    ignores: ["src/core/__tests__/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/ui/**", "**/substrate/**", "**/validation/**"],
              message:
                "src/core must not depend on the UI, the text projection, or validation data (docs/architecture.md).",
            },
            {
              group: ["react", "react-dom", "zustand", "@xyflow/*"],
              message: "src/core must stay framework-free.",
            },
            {
              group: ["**/scripts/**"],
              message: "Runtime modules must not depend on scripts/.",
            },
          ],
        },
      ],
    },
  },
  {
    // Core tests may reach the substrate for text round-trips, but fixtures
    // that live in the UI (examples, thruster builders) make a test a UI
    // tier test — it belongs in src/ui/tests.
    files: ["src/core/__tests__/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/ui/**"],
              message:
                "Core tests must not import UI fixtures; move the test to src/ui/tests.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/substrate/**/*.ts", "src/validation/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/ui/**"],
              message: "The substrate and validation layers sit below the UI.",
            },
          ],
        },
      ],
    },
  },
  {
    // The UI consumes core through its public barrel. Deep imports bind the
    // UI to solver internals that the barrel header declares unstable.
    files: ["src/ui/**/*.{ts,tsx}", "src/App.tsx", "src/main.tsx"],
    ignores: ["src/ui/tests/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/core/*", "**/core/**/*", "!**/core/index"],
              message:
                "Import from the core barrel (src/core/index.ts). Add an export there if something is missing.",
            },
            {
              group: ["**/scripts/**", "**/validation/**"],
              message: "The UI must not depend on scripts/ or validation data.",
            },
          ],
        },
      ],
    },
  },
  {
    // Tests deliberately feed malformed shapes into decoders and validators
    // and reach into internals; `any` is the honest way to write those.
    files: ["**/__tests__/**", "**/tests/**", "e2e/**"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    files: ["scripts/**/*.{ts,js,mjs,cjs}", "*.config.{ts,js,mjs,cjs}"],
    languageOptions: {
      globals: globals.node,
    },
  },
  prettier,
);
