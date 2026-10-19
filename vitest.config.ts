import { defineConfig } from "vitest/config";
import { QUIET_GIT } from "./apps/server/src/testing/quiet-git.ts";

export default defineConfig({
  test: {
    include: [
      "packages/*/src/**/*.test.ts",
      "packages/*/testing/**/*.test.ts",
      "apps/*/src/**/*.test.ts",
      "apps/*/src/**/*.test.tsx",
    ],
    environment: "node",
    env: QUIET_GIT,
    globalSetup: ["./apps/server/src/testing/global-setup.ts"],
    // Keeps transformed modules between runs and between worker processes.
    fsModuleCache: true,
    // A world test spawns node processes that read the repo's TypeScript. When the repo sits on a shared
    // mount (a task worktree on the host's disk), those reads queue across workers: a test of 3 s alone
    // takes over 20 s next to three others while the CPU stays idle. The budget still catches a hang.
    // Hooks build worlds too (a `beforeEach` with agent options builds a template the first time), so
    // they get the same budget instead of vitest's 10 s.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Most tests run real git and real processes, so a test's time is mostly CPU. More workers than
    // this only make every test slower when the machine has other work, and the slowest ones then run
    // out of their timeout. Total run time barely changes.
    maxWorkers: 4,
  },
});
