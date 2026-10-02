import { defineConfig, devices } from "@playwright/test";

/**
 * The sidebar, the workspace switcher and the notifications bell on the seeded home (`e2e/ui-seed.ts`).
 * Run: SHOTS=/some/dir pnpm exec playwright test -c playwright.nav.config.ts
 */
const PORT = 7187;
export default defineConfig({
  testDir: "e2e",
  testMatch: /shots\.nav\.ts$/,
  workers: 1,
  reporter: "list",
  use: { baseURL: `http://127.0.0.1:${PORT}` },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "pnpm --filter @majhi/web build && pnpm exec tsx e2e/start-server.ts",
    url: `http://127.0.0.1:${PORT}/health`,
    reuseExistingServer: false,
    timeout: 180_000,
    env: { MAJHI_E2E_SEED: "ui", MAJHI_E2E_PORT: String(PORT) },
  },
});
