import { realpathSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type APIRequestContext, expect, type Page, test } from "@playwright/test";

// better-sqlite3 belongs to the server package; the throwaway database is opened through it.
const Database = createRequire(join(process.cwd(), "apps/server/package.json"))("better-sqlite3") as new (
  path: string,
) => {
  prepare(sql: string): { run(...args: unknown[]): unknown };
  close(): void;
};

/**
 * The Watch page (SPEC 5.18, Ops watch): services by workspace with their lamps, the open incident with its
 * timeline, the latency line, majhi's own incident with its Fix, and the alerts and phone sheet with its QR
 * code. The server is the seeded one (`ui`); services point at a small local server this file runs, and the
 * 24 hour history is written straight into the throwaway database.
 *
 * Screenshots go to SHOTS. Run: `pnpm exec playwright test -c playwright.watch.config.ts`.
 */
const SHOTS = process.env.SHOTS ?? "/private/tmp/claude-501/watch-shots";
const PAGE_PORT = 7299;

const behaviour = new Map<string, { status: number; delayMs: number }>([
  ["/acme-api", { status: 200, delayMs: 40 }],
  ["/storefront", { status: 200, delayMs: 30 }],
  ["/checkout", { status: 503, delayMs: 20 }],
  ["/docs", { status: 200, delayMs: 60 }],
  ["/portal", { status: 200, delayMs: 90 }],
  ["/status", { status: 200, delayMs: 25 }],
]);

let server: Server;

async function cmd(request: APIRequestContext, name: string, data: unknown) {
  const res = await request.post(`/api/cmd/${name}`, { data });
  if (!res.ok()) throw new Error(`${name} failed: ${res.status()} ${await res.text()}`);
  return res.json();
}

const addr = (path: string) => `http://127.0.0.1:${PAGE_PORT}${path}`;

test.beforeAll(async ({ request }) => {
  server = createServer((req, res) => {
    const b = behaviour.get(req.url ?? "") ?? { status: 404, delayMs: 0 };
    setTimeout(() => {
      res.statusCode = b.status;
      res.end("ok");
    }, b.delayMs);
  });
  await new Promise<void>((resolve) => server.listen(PAGE_PORT, "127.0.0.1", resolve));

  const made: Record<string, string> = {};
  const add = async (org: string, name: string, path: string, extra: Record<string, unknown> = {}) => {
    const out = await cmd(request, "ops.serviceSave", {
      org,
      name,
      url: addr(path),
      impact: "medium",
      tls: false,
      dns: false,
      ...extra,
    });
    made[name] = out.id as string;
  };
  await add("acme", "Acme API", "/acme-api", { impact: "high", maxLatencyMs: 800 });
  await add("acme", "Acme storefront", "/storefront", { impact: "high", keyword: "ok" });
  await add("acme", "Acme checkout", "/checkout", { impact: "high" });
  await add("globex", "Globex documentation", "/docs", { impact: "low" });
  await add("globex", "Globex customer portal with a long name that gets cut in the list", "/portal");
  await add("northwind", "Northwind status page", "/status", { impact: "low" });
  for (const id of Object.values(made)) await cmd(request, "ops.checkNow", { id }).catch(() => undefined);

  // Twenty-four hours of history for each service, written straight into the throwaway database.
  // The server runs on its own, so its home is named after its port (paths.ts), not after this worker.
  const home = join(
    realpathSync(tmpdir()),
    `majhi-e2e-${process.env.MAJHI_E2E_PORT ?? 7204}`,
    "home",
    ".majhi",
  );
  const db = new Database(join(home, "majhi.db"));
  const now = Date.now();
  const insert = db.prepare("INSERT INTO ops_samples (service, at, ok, ms) VALUES (?, ?, ?, ?)");
  let seed = 7;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (const [name, id] of Object.entries(made)) {
    for (let i = 288; i > 1; i--) {
      const at = new Date(now - i * 5 * 60_000).toISOString();
      const down = name === "Acme checkout" && i < 40 && i > 12;
      const base = name === "Acme API" ? 90 : name === "Northwind status page" ? 30 : 160;
      const ms = down ? null : Math.round(base + rand() * base * (rand() > 0.93 ? 6 : 0.6));
      insert.run(id, at, down ? 0 : 1, ms);
    }
  }
  // majhi's own incident (a nearly full disk, with the fix Health offers) and a resolved one.
  const stamp = (min: number) => new Date(now - min * 60_000).toISOString();
  const insertIncident = db.prepare(
    `INSERT INTO ops_incidents (org, service, key, title, severity, status, opened_at, resolved_at, flaps, fix, timeline)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertIncident.run(
    "private",
    null,
    "self:disk",
    "majhi: Disk space is failing",
    "medium",
    "open",
    stamp(35),
    null,
    0,
    JSON.stringify({ check: "disk", label: "Create folder" }),
    JSON.stringify([
      {
        at: stamp(35),
        kind: "opened",
        text: "Disk space: 0.8 GB free for ~/Work/.majhi. Delete finished tasks or free space on that disk.",
      },
      { at: stamp(35), kind: "alerted", text: "Alerted you" },
    ]),
  );
  insertIncident.run(
    "acme",
    made["Acme storefront"] ?? null,
    "ops:resolved-storefront",
    "Acme storefront is slow",
    "high",
    "resolved",
    stamp(60 * 20),
    stamp(60 * 19),
    1,
    null,
    JSON.stringify([
      { at: stamp(60 * 20), kind: "opened", text: `${addr("/storefront")}: slow: 4210 ms, limit 1500 ms` },
      { at: stamp(60 * 20), kind: "alerted", text: "Alerted you" },
      { at: stamp(60 * 20 - 11), kind: "escalated", text: "Not acknowledged: alerted again" },
      { at: stamp(60 * 20 - 14), kind: "acked", text: "You acknowledged it" },
      { at: stamp(60 * 20 - 21), kind: "action", text: "Fix task proposed: ACM-14" },
      { at: stamp(60 * 19), kind: "resolved", text: "All checks green for 10 min. Open for 1 h." },
    ]),
  );
  db.close();

  // The checkout is down: two failing runs open one high incident that waits in Decisions.
  await cmd(request, "ops.checkNow", { id: made["Acme checkout"] });
  await cmd(request, "ops.checkNow", { id: made["Acme checkout"] });
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function open(page: Page, path: string, w: number, h: number, theme: string) {
  await page.setViewportSize({ width: w, height: h });
  await page.goto(path);
  await page.evaluate((t) => {
    document.documentElement.dataset.theme = t;
  }, theme);
  await page.waitForTimeout(900);
}

async function noPageScroll(page: Page) {
  const overflow = await page.evaluate(() => ({
    x: document.documentElement.scrollWidth - window.innerWidth,
    y: document.documentElement.scrollHeight - window.innerHeight,
  }));
  expect(overflow).toEqual({ x: 0, y: 0 });
}

for (const [w, h] of [
  [1440, 900],
  [1100, 760],
] as const) {
  for (const theme of ["dark", "light"]) {
    test(`watch ${w} ${theme}`, async ({ page }) => {
      await open(page, "/watch", w, h, theme);
      await expect(page.getByRole("heading", { name: "Watch", level: 1 })).toBeVisible();
      await expect(page.locator("[data-incident]").first()).toBeVisible();
      await noPageScroll(page);
      await page.screenshot({ path: `${SHOTS}/incident-${w}-${theme}.png` });
      await page.locator("[data-service]", { hasText: "Acme API" }).click();
      await expect(page.getByRole("heading", { name: "Acme API", level: 2 })).toBeVisible();
      await page.waitForTimeout(300);
      await noPageScroll(page);
      await page.screenshot({ path: `${SHOTS}/service-${w}-${theme}.png` });
      await page.locator("[data-incident]", { hasText: "Disk space" }).click();
      await expect(page.getByRole("button", { name: "Create folder" })).toBeVisible();
      await page.screenshot({ path: `${SHOTS}/self-${w}-${theme}.png` });
    });

    test(`alerts and phone ${w} ${theme}`, async ({ page }) => {
      await open(page, "/watch", w, h, theme);
      await page.getByRole("button", { name: "Alerts and phone" }).click();
      await expect(page.getByText("Use my own ntfy server")).toBeVisible();
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${SHOTS}/alerts-off-${w}-${theme}.png` });
    });
  }
}

test("phone setup shows the QR once", async ({ page }) => {
  await open(page, "/watch", 1440, 900, "dark");
  await page.getByRole("button", { name: "Alerts and phone" }).click();
  await page.getByRole("button", { name: "Set up phone" }).click();
  await expect(page.getByRole("img", { name: /QR code/ })).toBeVisible();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/alerts-qr-1440-dark.png` });
  await page.getByRole("button", { name: "I scanned it" }).click();
  await expect(page.getByRole("img", { name: /QR code/ })).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/alerts-on-1440-dark.png` });
  // The topic is never shown again.
  await page.reload();
  await page.getByRole("button", { name: "Alerts and phone" }).click();
  await expect(page.getByText(/majhi-[A-Za-z0-9_-]{24}/)).toHaveCount(0);
});

test("the incident waits in Decisions and one click acknowledges it", async ({ page }) => {
  await open(page, "/decisions", 1440, 900, "dark");
  await page.screenshot({ path: `${SHOTS}/decisions-1440-dark.png` });
  await page.getByRole("button", { name: "Acknowledge" }).first().click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SHOTS}/decisions-acked-1440-dark.png` });
});

test("add a service form", async ({ page }) => {
  await open(page, "/watch", 1440, 900, "dark");
  await page.getByRole("button", { name: "Watch a service" }).first().click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/form-1440-dark.png` });
});

test("narrow: the list, then the pane", async ({ page }) => {
  await open(page, "/watch", 760, 900, "dark");
  await page.screenshot({ path: `${SHOTS}/narrow-list.png` });
  await page.locator("[data-service]", { hasText: "Northwind" }).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/narrow-pane.png` });
});
