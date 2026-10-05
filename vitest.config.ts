import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/*/src/**/*.test.ts",
      "packages/*/testing/**/*.test.ts",
      "apps/*/src/**/*.test.ts",
      "apps/*/src/**/*.test.tsx",
    ],
    environment: "node",
    globalSetup: ["./apps/server/src/testing/global-setup.ts"],
    // Keeps transformed modules between runs and between worker processes.
    fsModuleCache: true,
    testTimeout: 20_000,
  },
});
