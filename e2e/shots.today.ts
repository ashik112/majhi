import { expect, type Page, test } from "@playwright/test";

/**
 * Today at realistic volume, at 1440 and 1100 wide, dark and light. The server is the seeded one: deadlines,
 * findings, an incident, follow-ups, goals and the brief are real. The browser adds forty more decisions to
 * the agenda response, which room cards would otherwise supply. Saved to TODAY_SHOTS.
 * Run: `pnpm exec playwright test -c playwright.today.config.ts`.
 */
const OUT = process.env.TODAY_SHOTS ?? "e2e/screenshots";

test.describe.configure({ mode: "serial" });

async function cmd(page: Page, name: string, body: unknown) {
  const res = await page.request.post(`/api/cmd/${name}`, { data: body });
  if (!res.ok()) throw new Error(`${name}: ${res.status()} ${await res.text()}`);
  return res.json();
}

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

async function seed(page: Page) {
  const dates: [string, string, string][] = [
    [
      "hackathon",
      "Final submission for the Spring Open Source Hackathon with a very long official name",
      "UTC",
    ],
    ["grant", "Hooli Grants Office: round two application", "America/Los_Angeles"],
    ["launch", "Product directory launch", "Europe/Berlin"],
    ["client", "Acme quarterly review", "Asia/Kolkata"],
    ["renewal", "Globex hosting renewal", "Pacific/Auckland"],
    ["other", "Northwind invoice run", "America/New_York"],
    ["client", "Initech security questionnaire", "UTC"],
    ["grant", "Umbrella community fund", "Europe/Berlin"],
  ];
  for (const [i, [kind, title, tz]] of dates.entries()) {
    await cmd(page, "deadlines.upsert", {
      kind,
      title,
      due: i % 2 === 0 ? day(i - 1) : `${day(i - 1)}T17:00`,
      tz,
      ...(i % 3 === 1 ? { org: "acme" } : {}),
    });
  }
  await cmd(page, "deadlines.upsert", { kind: "other", title: "Domain renewal", due: day(12), tz: "UTC" });
  const found: [string, string, string, string][] = [
    ["incident", "high", "Checkout API is returning 500 for 12% of requests", "Acme API uptime"],
    ["security", "high", "Outdated TLS setting on the staging proxy", "tls"],
    ["dependency", "high", "Known advisory in a pinned HTTP client", "dep"],
    ["ci", "medium", "Flaky export test on main", "ci"],
    ["follow-up", "low", "Write the migration notes", "fu"],
  ];
  for (const [source, severity, title, key] of found) {
    await cmd(page, "findings.report", {
      source,
      severity,
      title,
      detail: title,
      evidence: [],
      dedupeKey: key,
    });
  }
  await cmd(page, "goals.create", {
    title: "99.9% uptime for Acme",
    metric: "uptime",
    target: "99.9%",
  });
  await cmd(page, "goals.create", { title: "Launch on a product directory", due: day(20) });
}

/** Adds decisions to the agenda response, as room cards would. */
async function addDecisions(page: Page, count: number) {
  await page.route("**/api/cmd/agenda.today", async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    const t = body.data ?? body;
    const extra = Array.from({ length: count }, (_, i) => ({
      id: `decision:room:ACM-${i + 10}:rv`,
      kind: i % 7 === 0 ? "budget" : i % 5 === 0 ? "draft" : "decision",
      org: i % 3 === 0 ? "acme" : undefined,
      orgName: i % 3 === 0 ? "Acme" : i % 3 === 1 ? "Private" : "Umbrella Interactive Technologies",
      title:
        i % 4 === 0
          ? "Ready to ship: Move the notes export to a background job and retry the failed rows"
          : i % 4 === 1
            ? "Which currency should the invoice total use?"
            : i % 4 === 2
              ? "Allow npm run migrate in the sandbox?"
              : "Reply to Globex about the renewal",
      why: `Waiting ${i + 1} h`,
      action: i % 4 === 0 ? "Ship" : "Answer",
      target: { to: "decision", id: `room:ACM-${i + 10}:rv` },
      minutes: i % 4 === 0 ? 3 : i % 4 === 1 ? 2 : 1,
      weight: 50 - i * 0.1,
      must: false,
    }));
    const budget = t.budgetMinutes;
    let used = t.usedMinutes;
    const today = [...t.today];
    const later = [...t.later];
    for (const item of extra) {
      if (later.length === 0 && used + item.minutes <= budget) {
        today.push(item);
        used += item.minutes;
      } else later.push(item);
    }
    const laterMinutes = later.reduce((n: number, i: { minutes: number }) => n + i.minutes, 0);
    const out = { ...t, today, later, usedMinutes: used, laterMinutes, over: used > budget };
    await route.fulfill({ response: res, json: body.data === undefined ? out : { ...body, data: out } });
  });
}

async function shots(page: Page, name: string) {
  for (const scheme of ["dark", "light"] as const) {
    await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), scheme);
    for (const width of [1440, 1100]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(250);
      await page.screenshot({ path: `${OUT}/today-${name}-${scheme}-${width}.png` });
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
}

test("seed", async ({ page }) => {
  test.setTimeout(120_000);
  await seed(page);
  await cmd(page, "agenda.brief", { force: true });
});

test("Today with volume", async ({ page }) => {
  await addDecisions(page, 40);
  await page.goto("/today");
  await expect(page.getByRole("listbox", { name: "Agenda" }).getByRole("option").first()).toBeVisible();
  await shots(page, "volume");
  // Keys: j moves, Enter would open; check the selection moves.
  await page.keyboard.press("j");
  await shots(page, "volume-selected");
  await page.getByRole("button", { name: /^Later:/ }).click();
  await shots(page, "volume-later");
});

test("Today, empty day", async ({ page }) => {
  await page.route("**/api/cmd/agenda.today", async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    const t = body.data ?? body;
    const out = { ...t, today: [], later: [], usedMinutes: 0, laterMinutes: 0, over: false };
    await route.fulfill({ response: res, json: body.data === undefined ? out : { ...body, data: out } });
  });
  await page.goto("/today");
  await expect(page.getByText("Nothing on today's agenda.").first()).toBeVisible();
  await shots(page, "empty");
});
