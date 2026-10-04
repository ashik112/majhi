import { expect, type Page, test } from "@playwright/test";
import {
  buildAppSetup,
  type ConnectFlowView,
  type ConnectionView,
  type ConnectStatus,
  SERVICE_CATALOG,
} from "../packages/shared/src/index.ts";

/**
 * Connect step 2 on the Connections page: the catalog with its Command-line tools group, the guided
 * app setup sheets (Google, Slack), a code sign-in, a tool's sign-in and a connected tool. The
 * server is the seeded one (`ui`); the connect commands are stubbed in the browser, with long names.
 *
 * Screenshots go to SHOTS. Run: `pnpm exec playwright test -c playwright.connectapps.config.ts`.
 */
const SHOTS = process.env.SHOTS ?? "/private/tmp/claude-501/connectapps-shots";
const ORG = "globex";
const REDIRECT = "http://127.0.0.1:7070/oauth/callback";

const text = (value: string) => ({ kind: "text" as const, value, set: true });
const cliView = (id: string, name: string, tool: string, account: string): ConnectionView => ({
  id,
  org: ORG,
  type: "cli",
  name,
  description: `${name}, signed in for this workspace only.`,
  fields: { tool: text(tool), account: text(account) },
  vars: {},
  headers: {},
  env: {},
  allow: [],
  agents: [],
  problems: [],
  lastTest: {
    ok: true,
    detail: `${name}: signed in as ${account}.`,
    warnings: [],
    at: new Date().toISOString(),
    durationMs: 900,
  },
});

const connections: ConnectionView[] = [
  cliView("wrangler", "Cloudflare (wrangler)", "wrangler", "platform-engineering@globex-industrial.example"),
];

const statuses: ConnectStatus[] = [
  {
    connection: "wrangler",
    org: ORG,
    service: "wrangler",
    serviceName: "Cloudflare (wrangler)",
    state: "connected",
    reason: "Signed in with the tool's own login.",
    account: "platform-engineering@globex-industrial.example",
    scopes: [
      {
        access: "write",
        sentence: "Whatever your Cloudflare account can do. Deploys and changes ask you first.",
      },
    ],
    missing: [],
    renews: false,
    revocable: true,
  },
];

let flow: ConnectFlowView | undefined;

async function open(page: Page, w: number, h: number, theme: string) {
  await page.setViewportSize({ width: w, height: h });
  await page.route("**/api/cmd/connections.list", (r) => r.fulfill({ json: connections }));
  await page.route("**/api/cmd/connect.catalog", (r) =>
    r.fulfill({ json: { services: SERVICE_CATALOG, redirect: REDIRECT, helper: true } }),
  );
  await page.route("**/api/cmd/connect.status", (r) => r.fulfill({ json: statuses }));
  await page.route("**/api/cmd/connect.appStatus", (r) =>
    r.fulfill({
      json: [
        { app: "google", saved: false, builtIn: false },
        { app: "slack", saved: false, builtIn: false },
        { app: "linear", saved: true, builtIn: false },
        { app: "github", saved: true, builtIn: false },
      ],
    }),
  );
  await page.route("**/api/cmd/connect.appSetup", (r) => {
    const input = r.request().postDataJSON() as { app: string; access: "read" | "readwrite" | "send" };
    const view = buildAppSetup(input.app, {
      orgName: "Globex Industrial Holdings",
      redirect: REDIRECT,
      access: input.access,
    });
    return r.fulfill({ json: { ...view, saved: false, builtIn: false } });
  });
  await page.route("**/api/cmd/connect.start", (r) => r.fulfill({ json: flow }));
  await page.route("**/api/cmd/connect.flow", (r) => r.fulfill({ json: flow }));
  await page.goto("/connections");
  await page.evaluate((t) => {
    document.documentElement.dataset.theme = t;
  }, theme);
  await page.waitForTimeout(500);
}

async function shot(page: Page, name: string, w: number, theme: string) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBe(0);
  await page.screenshot({ path: `${SHOTS}/${name}-${w}-${theme}.png` });
}

const base = (over: Partial<ConnectFlowView>): ConnectFlowView => ({
  flow: "flow-0002-demo",
  org: ORG,
  service: "github",
  serviceName: "GitHub",
  state: "waiting",
  message: "",
  opened: false,
  scopes: [],
  expiresAt: new Date(Date.now() + 9 * 60_000).toISOString(),
  ...over,
});

for (const [w, h] of [
  [1440, 900],
  [1100, 760],
] as const) {
  for (const theme of ["dark", "light"]) {
    test(`catalog ${w} ${theme}`, async ({ page }) => {
      await open(page, w, h, theme);
      await page.getByRole("button", { name: "Connect a service" }).click();
      await expect(page.getByRole("list", { name: "Command-line tools" })).toBeVisible();
      await page.getByRole("list", { name: "Command-line tools" }).scrollIntoViewIfNeeded();
      await shot(page, "catalog", w, theme);
    });

    test(`google setup ${w} ${theme}`, async ({ page }) => {
      await open(page, w, h, theme);
      await page.getByRole("button", { name: "Connect a service" }).click();
      await page.getByRole("button", { name: /Gmail/ }).click();
      await expect(page.getByRole("list", { name: "Steps" })).toBeVisible();
      await shot(page, "google-setup", w, theme);
      await page.getByText("Drop the JSON file here").scrollIntoViewIfNeeded();
      await shot(page, "google-setup-drop", w, theme);
    });

    test(`slack setup ${w} ${theme}`, async ({ page }) => {
      await open(page, w, h, theme);
      await page.getByRole("button", { name: "Connect a service" }).click();
      await page.getByRole("button", { name: /Slack/ }).click();
      await expect(page.getByRole("link", { name: "Create from manifest" })).toBeVisible();
      await shot(page, "slack-setup", w, theme);
    });

    test(`consent with send ${w} ${theme}`, async ({ page }) => {
      await open(page, w, h, theme);
      await page.getByRole("button", { name: "Connect a service" }).click();
      await page.getByRole("button", { name: /Linear \(API\)/ }).click();
      await expect(page.getByRole("button", { name: "Connect Linear (API)" })).toBeVisible();
      await shot(page, "consent", w, theme);
    });

    test(`device code ${w} ${theme}`, async ({ page }) => {
      flow = base({
        message: "Enter the code WDJB-MJHT on the GitHub page.",
        code: "WDJB-MJHT",
        url: "https://github.com/login/device",
      });
      await open(page, w, h, theme);
      await page.getByRole("button", { name: "Connect a service" }).click();
      await page.getByRole("button", { name: /^GitHub/ }).click();
      await page.getByRole("button", { name: "Connect GitHub" }).click();
      await expect(page.getByText("WDJB-MJHT", { exact: true })).toBeVisible();
      await shot(page, "device-code", w, theme);
    });

    test(`tool sign-in ${w} ${theme}`, async ({ page }) => {
      flow = base({
        service: "vercel-cli",
        serviceName: "Vercel CLI",
        message: "Enter the code ABCD-EFGH on the Vercel CLI page.",
        code: "ABCD-EFGH",
        url: "https://vercel.com/oauth/device?user_code=ABCD-EFGH",
      });
      await open(page, w, h, theme);
      await page.getByRole("button", { name: "Connect a service" }).click();
      await page.getByRole("button", { name: /Vercel CLI/ }).click();
      await page.getByRole("button", { name: "Sign in with Vercel CLI" }).click();
      await expect(page.getByText("ABCD-EFGH", { exact: true })).toBeVisible();
      await shot(page, "tool-signin", w, theme);
    });

    test(`connected tool ${w} ${theme}`, async ({ page }) => {
      await open(page, w, h, theme);
      await page
        .getByRole("button", { name: /Cloudflare \(wrangler\)/ })
        .first()
        .click();
      await expect(page.getByRole("region", { name: "Sign-in" })).toBeVisible();
      await shot(page, "tool-connected", w, theme);
    });
  }
}
