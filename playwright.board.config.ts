import { defineConfig, devices } from "@playwright/test";

/**
 * Shell, board and New task on the seeded home (`e2e/ui-seed.ts`): `shots.board.ts` drives them,
 * `shots.board.ts` renders them at 1440x900 into e2e/screenshots/ui-*.png.
 * Run: pnpm exec playwright test -c playwright.board.config.ts
 */
const PORT = 7073;

export default defineConfig({
  testDir: "e2e",
  testMatch: /shots\.board\.ts$/,
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
    reuseExistingServer: false,
    timeout: 120_000,
    env: { MAJHI_E2E_SEED: "ui", MAJHI_E2E_PORT: String(PORT) },
  },
});
