import { defineConfig, devices } from "@playwright/test";

/**
 * The health checks, the update banner and the protected folder warning, on their own server and
 * throwaway home (port 7083), so they do not depend on the phase specs.
 * Run: pnpm exec playwright test -c playwright.ops.config.ts
 */
const PORT = 7083;

export default defineConfig({
  testDir: "e2e",
  testMatch: /phase2b-ops\.spec\.ts$/,
  outputDir: "test-results-ops",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: "retain-on-failure" },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
  ],
  webServer: {
    command: "pnpm --filter @majhi/web build && pnpm exec tsx e2e/start-server.ts",
    url: `http://127.0.0.1:${PORT}/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { MAJHI_E2E_PORT: String(PORT) },
  },
});
