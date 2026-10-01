import { defineConfig, devices } from "@playwright/test";

/**
 * Walks the Automations page at 1440x900 against a seeded home and saves screenshots: make a
 * schedule and a trigger, press Run now, open the history. The browser's clock is New York, so the
 * "your time" lines show against a Berlin schedule.
 * `pnpm exec playwright test -c playwright.automations.config.ts`.
 */
const PORT = 7077;

export default defineConfig({
  testDir: "e2e",
  testMatch: /shots\.automations\.ts$/,
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: { baseURL: `http://127.0.0.1:${PORT}`, timezoneId: "America/New_York" },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
  ],
  webServer: {
    command: "pnpm --filter @majhi/web build && pnpm exec tsx e2e/start-server.ts",
    url: `http://127.0.0.1:${PORT}/health`,
    reuseExistingServer: false,
    timeout: 180_000,
    env: { MAJHI_E2E_SEED: "ui", MAJHI_E2E_PORT: String(PORT) },
  },
});
