import { defineConfig, devices } from "@playwright/test";

/**
 * The org page's Tracker section on the seeded home (`e2e/ui-seed.ts`).
 * Run: SHOTS=/some/dir pnpm exec playwright test -c playwright.trackers.config.ts
 */
const PORT = 7189;
export default defineConfig({
  testDir: "e2e",
  testMatch: /shots\.trackers\.ts$/,
  workers: 1,
  reporter: "list",
  use: { baseURL: `http://127.0.0.1:${PORT}` },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
        // CHROMIUM points at an installed build when it differs from the one Playwright expects.
        ...(process.env.CHROMIUM ? { launchOptions: { executablePath: process.env.CHROMIUM } } : {}),
      },
    },
  ],
  webServer: {
    command: "pnpm --filter @majhi/web build && pnpm exec tsx e2e/start-server.ts",
    url: `http://127.0.0.1:${PORT}/health`,
    reuseExistingServer: false,
    timeout: 180_000,
    env: { MAJHI_E2E_SEED: "ui", MAJHI_E2E_PORT: String(PORT) },
  },
});
