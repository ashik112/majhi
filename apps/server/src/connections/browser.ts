/**
 * The browser MCP servers a browser connection can run (SPEC 5.14), pinned. They are installed in the
 * runner image (Dockerfile): raise a version there and here together. Each connection keeps its own
 * browser profile, so each org's logins stay apart.
 */
export const BROWSER_SERVERS = {
  playwright: {
    label: "Playwright MCP",
    package: "@playwright/mcp",
    version: "0.0.83",
    /** The image's command and the arguments before the profile. */
    command: "playwright-mcp",
    args: (profile: string) => [
      "--headless",
      "--browser",
      "chromium",
      "--no-sandbox",
      "--user-data-dir",
      profile,
    ],
    /** Tools that only look at pages, so they run without asking. Clicking and typing ask. */
    reads: [
      "browser_navigate",
      "browser_navigate_back",
      "browser_snapshot",
      "browser_take_screenshot",
      "browser_console_messages",
      "browser_network_requests",
      "browser_wait_for",
    ],
  },
  "chrome-devtools": {
    label: "Chrome DevTools MCP",
    package: "chrome-devtools-mcp",
    version: "1.10.1",
    command: "chrome-devtools-mcp",
    args: (profile: string) => [
      "--headless",
      "--userDataDir",
      profile,
      "--executablePath",
      "/usr/local/bin/chromium",
    ],
    reads: ["navigate_page", "take_snapshot", "take_screenshot", "wait_for", "select_page"],
  },
} as const;

/** Where the runner image keeps Playwright's browsers (Dockerfile, PLAYWRIGHT_BROWSERS_PATH). */
export const RUNNER_BROWSERS_PATH = "/opt/ms-playwright";

export type BrowserServerId = keyof typeof BROWSER_SERVERS;
export type BrowserServer = (typeof BROWSER_SERVERS)[BrowserServerId];

export function browserServer(id: string | undefined): BrowserServer {
  return BROWSER_SERVERS[id as BrowserServerId] ?? BROWSER_SERVERS.playwright;
}
