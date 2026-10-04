import { type APIRequestContext, expect, type Page, test } from "@playwright/test";

/**
 * The Playbooks page (SPEC 5.18): the captain's standing work by pack, the selected playbook in full,
 * goals under the list and the sending sheet. The server is the seeded one (`ui`); the data is made
 * through the real commands (goals, findings from a playbook, a draft, uptime settings).
 *
 * Screenshots go to SHOTS. Run: `pnpm exec playwright test -c playwright.playbooks.config.ts`.
 */
const SHOTS = process.env.SHOTS ?? "/private/tmp/claude-501/playbooks-shots";

async function cmd(request: APIRequestContext, name: string, data: unknown) {
  const res = await request.post(`/api/cmd/${name}`, { data });
  if (!res.ok()) throw new Error(`${name} failed: ${res.status()} ${await res.text()}`);
  return res.json();
}

test.beforeAll(async ({ request }) => {
  const business = await cmd(request, "goals.create", {
    org: "business",
    title: "99.9% uptime across every client service this quarter",
    metric: "uptime",
    target: "99.9%",
    due: "2026-12-31",
  });
  await cmd(request, "goals.create", {
    org: "private",
    title: "Ship the invoicing rewrite by the end of November",
  });
  await cmd(request, "playbooks.update", {
    org: "private",
    id: "ops-uptime",
    enabled: true,
    goal: business.id,
  });
  await cmd(request, "playbooks.update", { org: "private", id: "upkeep-triage", enabled: false });
  for (let i = 1; i <= 4; i++) {
    await cmd(request, "findings.report", {
      org: "private",
      source: "follow-up",
      title: `A follow-up the captain found, number ${i}`,
      playbook: "upkeep-followups",
    });
  }
  await cmd(request, "outbound.setMode", { org: "private", channel: "email", mode: "batch" });
  await cmd(request, "outbound.submit", {
    org: "private",
    channel: "email",
    target: "support@vendor.example",
    subject: "Question about the 3.0 migration",
    body: "Hello, we are two majors behind and would like the upgrade notes. Thank you.",
    voice: "Plain and polite",
  });
  await cmd(request, "outbound.submit", {
    org: "private",
    channel: "post",
    target: "the product account",
    body: "Version 2.4 is out: faster boards, calmer notifications.",
  });
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
    test(`playbooks ${w} ${theme}`, async ({ page }) => {
      await open(page, "/playbooks", w, h, theme);
      await expect(page.getByRole("heading", { name: "Playbooks", level: 1 })).toBeVisible();
      await noPageScroll(page);
      await page.screenshot({ path: `${SHOTS}/list-${w}-${theme}.png` });
      await page.locator('[data-playbook="ops-uptime"]').click();
      await expect(page.getByRole("heading", { name: "Service watch", level: 2 })).toBeVisible();
      await page.waitForTimeout(300);
      await noPageScroll(page);
      await page.screenshot({ path: `${SHOTS}/uptime-${w}-${theme}.png` });
    });

    test(`sending sheet ${w} ${theme}`, async ({ page }) => {
      await open(page, "/playbooks", w, h, theme);
      await page.getByRole("button", { name: "Sending" }).click();
      await expect(page.getByText("Nothing leaves this machine without passing here")).toBeVisible();
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${SHOTS}/sending-${w}-${theme}.png` });
    });
  }
}

test("a draft waits in Decisions with its text", async ({ page }) => {
  await open(page, "/decisions", 1440, 900, "dark");
  await page.getByText("Social post to the product account").first().click();
  await expect(page.getByRole("region", { name: "To the product account" })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/decisions-1440-dark.png` });
});

test("narrow: the list, then the pane", async ({ page }) => {
  await open(page, "/playbooks", 760, 900, "dark");
  await page.screenshot({ path: `${SHOTS}/narrow-list.png` });
  await page.locator('[data-playbook="upkeep-memory"]').click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/narrow-pane.png` });
});
