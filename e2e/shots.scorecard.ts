import { expect, type Page, test } from "@playwright/test";
import type { MoneyStatus, OwnerDecision, Scorecard, Tally } from "../packages/shared/src/index.ts";

/**
 * The scorecard strip and sheet on the Captain page, the money panel on Health and usage, and the
 * trust decision (SPEC 5.18). The server is the seeded one (`ui`); the scorecard, the money status and
 * the decisions are stubbed in the browser at the volume of a real week.
 *
 * Screenshots go to SHOTS. Run: `pnpm exec playwright test -c playwright.scorecard.config.ts`.
 */
const SHOTS = process.env.SHOTS ?? "/private/tmp/claude-501/scorecard-shots";
const NOW = Date.now();

/** `judged` outputs, `kept` of them kept, two more not judged yet. */
function tally(judged: number, kept: number, over: number, cost: number, minutes: number, tokens = 0): Tally {
  return {
    actions: judged + 2,
    judged,
    kept,
    overruled: over,
    bad: judged - kept,
    pending: 2,
    keptPct: Math.round((kept / judged) * 1000) / 10,
    overruledPct: Math.round((over / judged) * 1000) / 10,
    tokens: tokens || Math.round(cost * 90_000),
    costUsd: cost,
    minutesSaved: minutes,
  };
}

const card: Scorecard = {
  range: "week",
  from: new Date(NOW - 5 * 86_400_000).toISOString(),
  to: new Date(NOW + 86_400_000).toISOString(),
  window: 20,
  total: tally(110, 96, 6, 12.4, 385),
  orgs: [
    {
      org: "acme",
      tally: tally(50, 47, 2, 3.1, 150),
      findings: { filed: 14, accepted: 6, dismissed: 5, conversionPct: 54.5 },
      line: "Kept 47/50, $3.10, ~2.5 h saved",
    },
    {
      org: "globex",
      tally: tally(38, 31, 3, 6.2, 140),
      findings: { filed: 9, accepted: 2, dismissed: 6, conversionPct: 25 },
      line: "Kept 31/38, $6.20, ~2.3 h saved",
    },
    {
      org: "northwind",
      tally: tally(18, 18, 1, 3.1, 95),
      findings: { filed: 0, accepted: 0, dismissed: 0 },
      line: "Kept 18/18, $3.10, ~1.6 h saved",
    },
    {
      org: "private",
      tally: tally(4, 4, 0, 0.4, 20),
      findings: { filed: 1, accepted: 1, dismissed: 0, conversionPct: 100 },
      line: "Kept 4/4, $0.40, ~20 min saved",
    },
  ],
  rows: [
    { org: "acme", key: "merge", tally: tally(12, 11, 1, 1.2, 55), window: { judged: 12, kept: 11 } },
    { org: "acme", key: "upkeep", tally: tally(30, 28, 0, 0.8, 56), window: { judged: 20, kept: 19 } },
    { org: "acme", key: "outbound:email", tally: tally(10, 8, 1, 0.3, 64), window: { judged: 8, kept: 8 } },
    {
      org: "globex",
      key: "start",
      tally: tally(14, 8, 3, 4.1, 30),
      window: { judged: 12, kept: 8 },
      note: "Dropped to You by the trust ladder",
    },
    { org: "globex", key: "approvals", tally: tally(24, 23, 0, 0.9, 23), window: { judged: 20, kept: 20 } },
  ],
  playbooks: [
    {
      org: "acme",
      playbook: "followups",
      tally: tally(18, 17, 0, 0.9, 34),
      findings: { filed: 14, accepted: 6, dismissed: 5, conversionPct: 54.5 },
      muted: false,
      runs: 7,
    },
    {
      org: "globex",
      playbook: "dependency-check-for-the-whole-monorepo-and-its-workspaces",
      tally: tally(4, 3, 0, 0.7, 6),
      findings: { filed: 9, accepted: 2, dismissed: 6, conversionPct: 25 },
      muted: true,
      runs: 5,
    },
  ],
  minutes: {
    start: 10,
    questions: 3,
    approvals: 1,
    upkeep: 2,
    merge: 5,
    push: 3,
    own: 1,
    draft: 8,
    finding: 15,
  },
};

const money: MoneyStatus = {
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
    {
      org: "northwind",
      spentUsd: 20,
      tokens: 3_400_000,
      minutesSaved: 95,
      rates: { retainerUsd: 150 },
      marginUsd: 130,
    },
  ],
};

const trust: OwnerDecision = {
  id: "trust:1",
  kind: "trust",
  org: "globex",
  title: "Globex: Start work went back to You. Only 15 of the last 20 were kept (75%).",
  sentence:
    "Globex: Start work went back to You. Only 15 of the last 20 were kept (75%). Started GLX-12: Move the notes export (task failed); Started GLX-15: Fix the invoice total (task failed); and 3 more.",
  options: [
    { id: "ok", label: "Got it", primary: true },
    { id: "restore", label: "Give it back" },
  ],
  at: new Date(NOW - 3_600_000).toISOString(),
  link: { kind: "captain" },
};

async function stub(page: Page, held = false) {
  const answer = (name: string, json: () => unknown) =>
    page.route(`**/api/cmd/${name}`, (r) => r.fulfill({ json: json() }));
  await answer("scorecard.get", () => card);
  await answer("money.get", () =>
    held ? { ...money, spentUsd: 500, held: true, line: "$500 of $500 this month, new starts held" } : money,
  );
  await answer("decisions.list", () => ({ decisions: [trust] }));
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
    test(`captain strip ${w} ${theme}`, async ({ page }) => {
      await open(page, "/captain", w, h, theme);
      await expect(page.getByText("Kept 47/50, $3.10, ~2.5 h saved")).toBeVisible();
      await noPageScroll(page);
      await page.screenshot({ path: `${SHOTS}/captain-${w}-${theme}.png` });
    });
    test(`scorecard sheet ${w} ${theme}`, async ({ page }) => {
      await open(page, "/captain", w, h, theme);
      await page.getByRole("button", { name: "Scorecard" }).click();
      await expect(page.getByRole("heading", { name: "Playbooks" })).toBeVisible();
      await page.waitForTimeout(600);
      await page.screenshot({ path: `${SHOTS}/sheet-${w}-${theme}.png` });
    });
    test(`health money ${w} ${theme}`, async ({ page }) => {
      await open(page, "/usage", w, h, theme);
      await page.screenshot({ path: `${SHOTS}/health-closed-${w}-${theme}.png` });
      await page.getByRole("button", { name: "Profit and loss" }).click();
      await expect(page.getByText("Retainer less spend")).toBeVisible();
      await page.getByText("Retainer less spend").scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${SHOTS}/health-${w}-${theme}.png` });
    });
    test(`trust decision ${w} ${theme}`, async ({ page }) => {
      await open(page, "/decisions", w, h, theme);
      await expect(page.getByText("Start work went back to You").first()).toBeVisible();
      await noPageScroll(page);
      await page.screenshot({ path: `${SHOTS}/decisions-${w}-${theme}.png` });
    });
  }
}
