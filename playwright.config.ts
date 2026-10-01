import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  testMatch: /\.spec\.ts$/,
  // The web app is built once; every worker then starts its own server with its own home and port
  // (`e2e/fixture.ts`). Spec files run side by side. Inside a file, tests run in order unless the
  // file opts into parallel mode.
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  // Several servers, browsers and fake agents share the machine, so a step can take a moment longer.
  expect: { timeout: 10_000 },
  reporter: "list",
  use: {
    // DOM snapshots only: a screencast for every test costs more CPU than the tests themselves.
    trace: { mode: "retain-on-failure", screenshots: false },
    // No looping motion (the working lamp's sweep, shimmers): headless Chromium paints it in software,
    // and a few pages doing that at once starve the servers.
    reducedMotion: "reduce",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
        permissions: ["clipboard-read", "clipboard-write"],
      },
    },
  ],
});
