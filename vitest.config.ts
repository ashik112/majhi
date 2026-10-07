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
    // Most tests run real git and real processes, so a test's time is mostly CPU. More workers than
    // this only make every test slower when the machine has other work, and the slowest ones then run
    // out of their timeout. Total run time barely changes.
    maxWorkers: 4,
  },
});
