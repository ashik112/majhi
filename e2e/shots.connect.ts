import { expect, type Page, test } from "@playwright/test";
import {
  type ConnectFlowView,
  type ConnectionView,
  type ConnectStatus,
  SERVICE_CATALOG,
} from "../packages/shared/src/index.ts";

/**
 * Connect on the Connections page: the catalog, the waiting state, connected, needs reconnect and
 * insufficient scope. The server is the seeded one (`ui`); the connect commands and the connection
 * list are stubbed in the browser, with long names.
 *
 * Screenshots go to SHOTS. Run: `pnpm exec playwright test -c playwright.connect.config.ts`.
 */
const SHOTS = process.env.SHOTS ?? "/private/tmp/claude-501/connect-shots";

const ORG = "globex";

function view(id: string, name: string, over: Partial<ConnectionView> = {}): ConnectionView {
  const text = (value: string) => ({ kind: "text" as const, value, set: true });
  return {
    id,
    org: ORG,
    type: "mcp",
    name,
    description: "",
    fields: {
      transport: text("remote"),
      url: text("https://mcp.example.com/mcp"),
      protocol: text("http"),
      auth: text("oauth"),
    },
    vars: {},
    headers: {},
    env: {},
    allow: [],
    agents: [],
    problems: [],
    lastTest: {
      ok: true,
      detail: "14 tools: list_issues, get_issue",
      warnings: [],
      at: new Date().toISOString(),
      durationMs: 420,
    },
    ...over,
  };
}

const connections: ConnectionView[] = [
  view("linear", "Linear"),
  view("sentry", "Sentry"),
  view("stripe", "Stripe", {
    lastTest: {
      ok: false,
      detail: "Stripe needs more access (customer_write). Reconnect and allow it.",
      warnings: [],
      at: new Date().toISOString(),
      durationMs: 380,
    },
  }),
];

const READ = [{ access: "read" as const, sentence: "Read issues, projects, comments and teams." }];
const status = (
  over: Partial<ConnectStatus> & Pick<ConnectStatus, "connection" | "service" | "serviceName">,
): ConnectStatus => ({
  org: ORG,
  state: "connected",
  reason: "Connected.",
  account: "maria.fernandez-castellanos@globex-industrial.example",
  scopes: READ,
  missing: [],
  connectedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
  renews: true,
  revocable: true,
  ...over,
});

const statuses: ConnectStatus[] = [
  status({ connection: "linear", service: "linear", serviceName: "Linear" }),
  status({
    connection: "sentry",
    service: "sentry",
    serviceName: "Sentry",
    state: "needs-reconnect",
    reason: "Sentry no longer accepts majhi's sign-in. Reconnect it.",
    scopes: [{ access: "read", sentence: "Read organizations, projects, issues and events." }],
  }),
  status({
    connection: "stripe",
    service: "stripe",
    serviceName: "Stripe",
    state: "insufficient-scope",
    reason: "Stripe asks for more access than you gave (customer_write). Allow it to continue.",
    missing: ["customer_write"],
    scopes: [{ access: "read", sentence: "Read customers, payments, subscriptions and balances." }],
  }),
];

const flowBase: ConnectFlowView = {
  flow: "flow-0001-demo",
  org: ORG,
  service: "grafana",
  serviceName: "Grafana Cloud",
  state: "waiting",
  message: "Waiting for you in the browser. Approve Grafana Cloud there.",
  opened: true,
  scopes: [],
  expiresAt: new Date(Date.now() + 9 * 60_000).toISOString(),
};

let flow: ConnectFlowView = flowBase;

async function open(page: Page, w: number, h: number, theme: string) {
  await page.setViewportSize({ width: w, height: h });
  await page.route("**/api/cmd/connections.list", (r) => r.fulfill({ json: connections }));
  await page.route("**/api/cmd/connect.catalog", (r) =>
    r.fulfill({
      json: { services: SERVICE_CATALOG, redirect: "http://127.0.0.1:7070/oauth/callback", helper: true },
    }),
  );
  await page.route("**/api/cmd/connect.status", (r) => r.fulfill({ json: statuses }));
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

for (const [w, h] of [
  [1440, 900],
  [1100, 760],
] as const) {
  for (const theme of ["dark", "light"]) {
    test(`catalog ${w} ${theme}`, async ({ page }) => {
      await open(page, w, h, theme);
      await page.getByRole("button", { name: "Connect a service" }).click();
      await expect(page.getByRole("list", { name: "Services" })).toBeVisible();
      await shot(page, "catalog", w, theme);
    });

    test(`waiting ${w} ${theme}`, async ({ page }) => {
      flow = flowBase;
      await open(page, w, h, theme);
      await page.getByRole("button", { name: "Connect a service" }).click();
      await page.getByRole("button", { name: /Grafana Cloud/ }).click();
      await page.getByRole("button", { name: /^Connect Grafana Cloud to /i }).click();
      await expect(page.getByText("Waiting for you in the browser", { exact: true })).toBeVisible();
      await shot(page, "waiting", w, theme);
    });

    test(`waiting without the helper ${w} ${theme}`, async ({ page }) => {
      flow = {
        ...flowBase,
        opened: false,
        url: "https://mcp.grafana.com/authorize?response_type=code&client_id=client-1032e7c116e2&state=Zm9v",
      };
      await open(page, w, h, theme);
      await page.getByRole("button", { name: "Connect a service" }).click();
      await page.getByRole("button", { name: /Grafana Cloud/ }).click();
      await page.getByRole("button", { name: /^Connect Grafana Cloud to /i }).click();
      await expect(page.getByRole("link", { name: "Open the page" })).toBeVisible();
      await shot(page, "waiting-link", w, theme);
    });

    test(`connected ${w} ${theme}`, async ({ page }) => {
      flow = {
        ...flowBase,
        state: "connected",
        connection: "grafana",
        message: "Connected as maria.fernandez-castellanos@globex-industrial.example.",
        account: "maria.fernandez-castellanos@globex-industrial.example",
        scopes: [{ access: "read", sentence: "Read dashboards and alerts, and run queries." }],
        test: {
          ok: true,
          detail: "23 tools: search_dashboards, query_prometheus, list_alert_rules, ...",
          warnings: [],
          at: new Date().toISOString(),
          durationMs: 640,
        },
      };
      await open(page, w, h, theme);
      await page.getByRole("button", { name: "Connect a service" }).click();
      await page.getByRole("button", { name: /Grafana Cloud/ }).click();
      await page.getByRole("button", { name: /^Connect Grafana Cloud to /i }).click();
      await expect(page.getByText(/^Connected as maria/)).toBeVisible();
      await shot(page, "connected", w, theme);
    });

    test(`confirm account ${w} ${theme}`, async ({ page }) => {
      flow = {
        ...flowBase,
        state: "confirm-account",
        message:
          "This signed in as bob@globex.example, but Grafana Cloud here is maria.fernandez-castellanos@globex-industrial.example. Nothing changed.",
        account: "bob@globex.example",
        previousAccount: "maria.fernandez-castellanos@globex-industrial.example",
      };
      await open(page, w, h, theme);
      await page.getByRole("button", { name: "Connect a service" }).click();
      await page.getByRole("button", { name: /Grafana Cloud/ }).click();
      await page.getByRole("button", { name: /^Connect Grafana Cloud to /i }).click();
      await expect(page.getByRole("button", { name: /^Keep / })).toBeVisible();
      await shot(page, "confirm", w, theme);
    });

    test(`connected row ${w} ${theme}`, async ({ page }) => {
      await open(page, w, h, theme);
      await page.getByRole("button", { name: "Linear", exact: true }).first().click();
      await expect(page.getByRole("region", { name: "Sign-in" })).toBeVisible();
      await shot(page, "row-connected", w, theme);
    });

    test(`needs reconnect ${w} ${theme}`, async ({ page }) => {
      await open(page, w, h, theme);
      await page.getByRole("button", { name: "Sentry", exact: true }).first().click();
      await expect(page.getByText("Needs you to sign in again")).toBeVisible();
      await shot(page, "needs-reconnect", w, theme);
    });

    test(`insufficient scope ${w} ${theme}`, async ({ page }) => {
      await open(page, w, h, theme);
      await page.getByRole("button", { name: "Stripe", exact: true }).first().click();
      await expect(page.getByRole("button", { name: "Allow more access" })).toBeVisible();
      await shot(page, "insufficient-scope", w, theme);
    });
  }
}
