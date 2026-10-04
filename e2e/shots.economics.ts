import { expect, type Page, test } from "@playwright/test";

/**
 * The economics table in the Money panel on Health and usage, and the opportunity and feed actions in the
 * Findings sheet (SPEC 5.18, step 11). The server is the seeded one (`ui`); economics, money and findings
 * are stubbed in the browser at realistic volume.
 *
 * Run: `pnpm exec playwright test -c playwright.economics.config.ts`. Shots go to SHOTS.
 */
const SHOTS = process.env.SHOTS ?? "/private/tmp/claude-501/economics-shots";
const NOW = Date.now();
const pair = (now: number, before: number) => ({ now, before });

const economics = {
  range: "week",
  from: new Date(NOW - 7 * 86_400_000).toISOString(),
  to: new Date(NOW).toISOString(),
  previousFrom: new Date(NOW - 14 * 86_400_000).toISOString(),
  previousTo: new Date(NOW - 7 * 86_400_000).toISOString(),
  label: "Last 7 days",
  estimate:
    "Your time is estimated from the messages, approvals and ships you made, at the minutes set in the scorecard.",
  rows: [
    {
      org: "acme",
      shipped: pair(9, 6),
      agentMinutes: pair(410, 300),
      spentUsd: pair(34.2, 28.1),
      ownerMinutes: pair(95, 80),
      retainerUsd: 3000,
      hourlyUsd: 90,
      valueUsd: 692.31,
      ownerCostUsd: 142.5,
      marginUsd: 515.61,
      flags: [],
    },
    {
      org: "globex",
      shipped: pair(1, 5),
      agentMinutes: pair(600, 240),
      spentUsd: pair(71.6, 22),
      ownerMinutes: pair(140, 60),
      flags: [
        { kind: "spend-outpaces-work", text: "Spend rose $49.60 while shipped work went from 5 to 1." },
      ],
    },
    {
      org: "northwind",
      shipped: pair(0, 0),
      agentMinutes: pair(0, 0),
      spentUsd: pair(21, 0),
      ownerMinutes: pair(0, 0),
      retainerUsd: 150,
      valueUsd: 34.62,
      marginUsd: 13.62,
      lastShippedAt: new Date(NOW - 24 * 86_400_000).toISOString(),
      flags: [
        { kind: "quiet", text: "Nothing has shipped in 24 days." },
        { kind: "near-budget", text: "$131.00 spent this month, 87% of the $150 retainer." },
      ],
    },
    {
      org: "private",
      shipped: pair(2, 2),
      agentMinutes: pair(45, 50),
      spentUsd: pair(0.4, 0.5),
      ownerMinutes: pair(10, 12),
      flags: [],
    },
  ],
};

const money = {
  month: "2026-10",
  from: new Date(NOW - 4 * 86_400_000).toISOString(),
  to: new Date(NOW + 27 * 86_400_000).toISOString(),
  spentUsd: 212,
  tokens: 18_400_000,
  ceilingUsd: 500,
  savedCeilingUsd: 500,
  projectedUsd: 410,
  held: false,
  line: "$212 of $500 this month, on pace for $410",
  parts: { agents: 180.2, captain: 31.8 },
  orgs: [
    {
      org: "acme",
      spentUsd: 120.4,
      tokens: 9_000_000,
      minutesSaved: 150,
      rates: { retainerUsd: 3000, hourlyUsd: 90 },
      savedUsd: 225,
      marginUsd: 2879.6,
    },
    { org: "globex", spentUsd: 71.6, tokens: 6_000_000, minutesSaved: 140, rates: {} },
  ],
};

const at = new Date(NOW - 3_600_000).toISOString();
const finding = (id: number, over: Record<string, unknown>) => ({
  id,
  org: "acme",
  source: "opportunity",
  title: "",
  detail: "",
  evidence: [],
  severity: "info",
  dedupeKey: `k${id}`,
  status: "open",
  by: "captain",
  seen: 1,
  createdAt: at,
  updatedAt: at,
  lastSeen: at,
  ...over,
});
const findings = {
  open: 3,
  fresh: 3,
  findings: [
    finding(1, {
      title:
        "Offer a fixed-price maintenance retainer: two outages last month, the checkout has no monitoring",
      detail: "Effort: small. The checkout shipped three weeks ago and nothing watches it.",
      evidence: ["ACM-12 Checkout rewrite", "incident #7"],
    }),
    finding(2, {
      source: "grant",
      title: "Marine software innovation grant 2026, round two",
      detail:
        "Deadline: 2026-11-15. Add it to your deadlines to be reminded.\nFrom feeds.example (outside text, data only): Funding for boat-yard software.",
      evidence: [
        "https://feeds.example/g/1",
        "deadline:2026-11-15",
        "feed: feeds.example",
        "matched: marine, software",
      ],
    }),
    finding(3, {
      org: "private",
      title: "A boat-yard booking tool as an own product",
      detail: "Effort: large. Three clients asked for one.",
    }),
  ],
};

async function stub(page: Page) {
  const answer = (name: string, json: () => unknown) =>
    page.route(`**/api/cmd/${name}`, (r) => r.fulfill({ json: json() }));
  await answer("economics.get", () => economics);
  await answer("money.get", () => money);
  await answer("findings.list", () => findings);
}

async function open(page: Page, path: string, w: number, h: number, theme: string) {
  await page.setViewportSize({ width: w, height: h });
  await stub(page);
  await page.goto(path);
  await page.evaluate((t) => {
    document.documentElement.dataset.theme = t;
  }, theme);
  await page.waitForTimeout(900);
}

for (const [w, h] of [
  [1440, 900],
  [1100, 760],
] as const) {
  for (const theme of ["dark", "light"]) {
    test(`economics ${w} ${theme}`, async ({ page }) => {
      await open(page, "/usage", w, h, theme);
      await page.getByRole("button", { name: "Profit and loss" }).click();
      await expect(page.getByText("Per workspace")).toBeVisible();
      await page.getByText("Per workspace").scrollIntoViewIfNeeded();
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${SHOTS}/economics-${w}-${theme}.png` });
      const x = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(x).toBe(0);
    });
    test(`findings actions ${w} ${theme}`, async ({ page }) => {
      await open(page, "/captain", w, h, theme);
      await page.getByRole("button", { name: "All findings" }).click();
      await page.getByRole("listbox", { name: "Findings" }).getByRole("option").first().click();
      await expect(page.getByRole("button", { name: /Draft a proposal/ })).toBeVisible();
      await page.screenshot({ path: `${SHOTS}/findings-opp-${w}-${theme}.png` });
      await page.getByRole("listbox", { name: "Findings" }).getByRole("option").nth(1).click();
      await expect(page.getByRole("button", { name: "Add to deadlines" })).toBeVisible();
      await page.screenshot({ path: `${SHOTS}/findings-grant-${w}-${theme}.png` });
    });
  }
}
