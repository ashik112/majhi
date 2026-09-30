import { defineConfig, devices } from "@playwright/test";

/**
 * Walks the Memory screens at 1440x900 against a seeded home and saves screenshots. Start the server
 * and seed it first (see e2e/memory-seed.ts), or let this config start the server:
 * `pnpm exec playwright test -c playwright.memory.config.ts`.
 */
const PORT = 7075;

export default defineConfig({
  testDir: "e2e",
  testMatch: /shots\.memory\.ts$/,
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
    timeout: 120_000,
    env: { MAJHI_E2E_SEED: "ui", MAJHI_E2E_PORT: String(PORT) },
  },
});
