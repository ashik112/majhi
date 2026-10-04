import { defineConfig, devices } from "@playwright/test";

/**
 * Walks Today at 1440 and 1100 wide, dark and
 * light, against a seeded home with realistic volume: `pnpm exec playwright test -c playwright.today.config.ts`.
 */
const PORT = 7078;

export default defineConfig({
  testDir: "e2e",
  testMatch: /shots.today.ts$/,
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: { baseURL: `http://127.0.0.1:${PORT}` },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
  ],
  webServer: {
    command: "pnpm --filter @majhi/web build && pnpm exec tsx e2e/start-server.ts",
    url: `http://127.0.0.1:${PORT}/health`,
    reuseExistingServer: true,
    timeout: 180_000,
    env: { MAJHI_E2E_SEED: "ui", MAJHI_E2E_PORT: String(PORT) },
  },
});
