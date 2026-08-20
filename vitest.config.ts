import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 300000,
    hookTimeout: 120000,
    reporters: process.env.CI ? ["default"] : ["verbose"],
    exclude: ["node_modules", "dist", "e2e", "build", "coverage"],
  },
});
