import { expect, type Page, test } from "@playwright/test";
import type {
  Authority,
  AutonomyStatus,
  BudgetAsk,
  BudgetRow,
  CaptainOrg,
  CaptainStatus,
  CapUse,
} from "../packages/shared/src/index.ts";

/**
 * The Limits screen and the budget decisions (SPEC 5.18): the autonomous budget, a budget per
 * workspace with today's spend, Safety folded and open, and the question the captain asks when a
 * budget runs out, in the bell, on the Captain page and on the Limits screen. The server is the
 * seeded one (`ui`); the captain's status, autonomous mode and the questions are stubbed in the browser.
 *
 * Screenshots go to SHOTS. Run: `pnpm exec playwright test -c playwright.limits.config.ts`.
 */
const SHOTS = process.env.SHOTS ?? "/private/tmp/claude-501/limits-shots";
const NOW = Date.now();
const DAY = "2026-10-04";

const RUNS: Authority = {
  start: "decide",
  questions: "decide",
  approvals: "decide",
  upkeep: "decide",
  merge: "ask",
  push: "ask",
};
const LONG = "Northwind Traders International Holdings and Logistics Group";

function org(o: Partial<CaptainOrg> & Pick<CaptainOrg, "org" | "name">): CaptainOrg {
  return {
    thread: "idle",
    authority: RUNS,
    effective: RUNS,
    rules: { authority: RUNS },
    used: { tokens: 0, cost: 0 },
    summary: "",
    forYou: 0,
    chores: [],
    ...o,
  };
}

const use = (cost: number, cap?: number): CapUse => ({
  used: { tokens: cost * 40_000, cost },
  ...(cap === undefined ? {} : { cap: { cost: cap } }),
  percent: cap === undefined ? 0 : (cost / cap) * 100,
  reached: cap !== undefined && cost >= cap,
});

interface Scene {
  /** The autonomous budget is used up. */
  dayUp: boolean;
  asks: BudgetAsk[];
  raised: AutonomyStatus["raised"];
}

function captain(): CaptainStatus {
  return {
    stopped: false,
    autonomy: "on",
    captain: "setup",
    day: DAY,
    orgs: [
      org({ org: "private", name: "Private", budget: { cost: 10 }, used: { tokens: 160_000, cost: 4.2 } }),
      org({ org: "globex", name: "Globex", budget: { cost: 20 }, used: { tokens: 800_000, cost: 20 } }),
      org({ org: "acme", name: "Acme", budget: { cost: 8 }, used: { tokens: 120_000, cost: 1.15 } }),
      org({ org: "northwind", name: LONG, used: { tokens: 400_000, cost: 3.1 } }),
    ],
  };
}

function autonomy(scene: Scene): AutonomyStatus {
  const total = scene.dayUp ? use(60, 60) : use(28.45, 60);
  return {
    mode: "on",
    stopped: [],
    raised: scene.raised,
    since: new Date(NOW - 95 * 60_000).toISOString(),
    by: "owner",
    boss: { id: "setup", chat: "LOCAL-31", working: false },
    lanes: [],
    now: [],
    queue: [],
    backlog: [],
    holds: [],
    spend: {
      day: DAY,
      tz: "Europe/Berlin",
      resetsAt: new Date(NOW + 6 * 3600_000).toISOString(),
      total,
      orgs: [
        { org: "private", ...use(4.2, 10) },
        {
          org: "globex",
          ...(scene.raised.globex === undefined
            ? use(20, 20)
            : { ...use(20, scene.raised.globex.cost ?? 40) }),
        },
        { org: "acme", ...use(1.15, 8) },
        { org: "northwind", ...use(3.1) },
      ],
    },
    accounts: [],
    waiting: [],
    settings: {
      day: { cost: 60 },
      orgs: {
        private: { cap: { cost: 10 } },
        globex: { cap: { cost: 20 } },
        acme: { cap: { cost: 8 } },
      },
      floors: { window: 10, weekly: 5 },
      summary_at: "08:00",
      tz: "Europe/Berlin",
      instructions: [],
      pick: { size: "any" },
    },
    lastTick: new Date(NOW - 4 * 60_000).toISOString(),
  };
}

const ASK_GLOBEX: BudgetAsk = {
  scope: "globex",
  name: "Globex",
  day: DAY,
  cap: { cost: 20 },
  raiseTo: { cost: 40 },
  waiting: 3,
  text: "Globex used its $20 for today. 3 tasks are waiting. Raise it to $40 for today?",
  at: new Date(NOW - 10 * 60_000).toISOString(),
};
const ASK_DAY: BudgetAsk = {
  scope: "day",
  name: "Autonomous work",
  day: DAY,
  cap: { cost: 60 },
  raiseTo: { cost: 120 },
  waiting: 5,
  text: "Autonomous work used its $60 for today. 5 tasks are waiting. Raise it to $120 for today?",
  at: new Date(NOW - 5 * 60_000).toISOString(),
};

const WEEKLY: BudgetRow[] = [
  {
    scope: "org",
    id: "globex",
    budget: { cost: 100 },
    used: { tokens: 3_000_000, cost: 84 },
    percent: 84,
    measure: "cost",
    weekStart: "2026-09-28",
    resetsAt: new Date(NOW + 3 * 86_400_000).toISOString(),
    alerts: [{ threshold: 80, at: new Date(NOW - 3600_000).toISOString() }],
    paused: false,
  },
];

async function stub(page: Page, scene: Scene) {
  const calls: { name: string; body: unknown }[] = [];
  const answer = (name: string, json: () => unknown) =>
    page.route(`**/api/cmd/${name}`, (r) => {
      calls.push({ name, body: r.request().postDataJSON() });
      return r.fulfill({ json: json() });
    });
  await answer("captain.status", () => captain());
  await answer("captain.log", () => ({ actions: [], runs: [] }));
  await answer("captain.asks", () => ({ asks: [], budgets: scene.asks }));
  await answer("autonomy.status", () => autonomy(scene));
  await answer("autonomy.events", () => ({ events: [] }));
  await answer("budgets.status", () => ({ tz: "Europe/Berlin", rows: WEEKLY }));
  await page.route("**/api/cmd/captain.answerBudget", (r) => {
    const body = r.request().postDataJSON() as { scope: string; answer: "raise" | "leave" };
    calls.push({ name: "captain.answerBudget", body });
    const ask = scene.asks.find((a) => a.scope === body.scope);
    if (ask !== undefined && body.answer === "raise")
      scene.raised = { ...scene.raised, [ask.scope]: ask.raiseTo };
    scene.asks = scene.asks.filter((a) => a.scope !== body.scope);
    return r.fulfill({ json: { asks: [], budgets: scene.asks } });
  });
  await page.route("**/api/cmd/autonomy.configure", (r) => {
    calls.push({ name: "autonomy.configure", body: r.request().postDataJSON() });
    return r.fulfill({ json: autonomy(scene) });
  });
  return { calls };
}

async function open(page: Page, path: string, w: number, h: number, theme: string, scene: Scene) {
  await page.setViewportSize({ width: w, height: h });
  const stubbed = await stub(page, scene);
  await page.goto(path);
  await page.evaluate((t) => {
    document.documentElement.dataset.theme = t;
  }, theme);
  await page.waitForTimeout(700);
  return stubbed;
}

async function noPageScroll(page: Page) {
  const overflow = await page.evaluate(() => ({
    x: document.documentElement.scrollWidth - window.innerWidth,
    y: document.documentElement.scrollHeight - window.innerHeight,
  }));
  expect(overflow).toEqual({ x: 0, y: 0 });
}

const scene = (over: Partial<Scene> = {}): Scene => ({
  dayUp: false,
  asks: [ASK_GLOBEX],
  raised: {},
  ...over,
});

for (const [w, h] of [
  [1440, 900],
  [1100, 760],
] as const) {
  for (const theme of ["dark", "light"]) {
    test(`limits ${w} ${theme}`, async ({ page }) => {
      await open(page, "/limits", w, h, theme, scene());
      await expect(page.getByRole("region", { name: "Autonomous budget per day" })).toBeVisible();
      await expect(page.getByText(ASK_GLOBEX.text)).toBeVisible();
      await page.screenshot({ path: `${SHOTS}/limits-${w}-${theme}.png` });
      await noPageScroll(page);
    });
    test(`limits with safety open ${w} ${theme}`, async ({ page }) => {
      await open(page, "/limits", w, h, theme, scene());
      await page.getByRole("button", { name: /^Safety/ }).click();
      await expect(page.getByLabel("Keep of each week, %")).toBeVisible();
      await page.getByRole("button", { name: /^Safety/ }).scrollIntoViewIfNeeded();
      await page
        .locator("main, [role=main]")
        .first()
        .evaluate((el) => el.scrollTo?.(0, 99999));
      await page.getByLabel("Keep of each week, %").scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${SHOTS}/limits-safety-${w}-${theme}.png` });
      await noPageScroll(page);
    });
    test(`autonomous budget used up ${w} ${theme}`, async ({ page }) => {
      await open(page, "/limits", w, h, theme, scene({ dayUp: true, asks: [ASK_DAY] }));
      await expect(page.getByText(ASK_DAY.text)).toBeVisible();
      await page.screenshot({ path: `${SHOTS}/limits-day-up-${w}-${theme}.png` });
      await noPageScroll(page);
    });
    test(`the question on the captain page ${w} ${theme}`, async ({ page }) => {
      await open(page, "/captain", w, h, theme, scene({ asks: [ASK_DAY, ASK_GLOBEX] }));
      await expect(page.getByText(ASK_DAY.text)).toBeVisible();
      await expect(page.getByText(ASK_GLOBEX.text)).toBeVisible();
      await page.screenshot({ path: `${SHOTS}/captain-budget-ask-${w}-${theme}.png` });
      await noPageScroll(page);
    });
    test(`the question in the bell ${w} ${theme}`, async ({ page }) => {
      await open(page, "/limits", w, h, theme, scene({ asks: [ASK_DAY, ASK_GLOBEX] }));
      await page.getByRole("button", { name: /^Notifications/ }).click();
      const panel = page.getByRole("dialog", { name: "Needs you" });
      await expect(panel.getByText(ASK_GLOBEX.text)).toBeVisible();
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${SHOTS}/bell-budget-ask-${w}-${theme}.png` });
    });
  }
}

test("raising from the bell asks the server and clears the question", async ({ page }) => {
  const { calls } = await open(page, "/limits", 1440, 900, "dark", scene());
  await page.getByRole("button", { name: /^Notifications/ }).click();
  const panel = page.getByRole("dialog", { name: "Needs you" });
  await panel.getByRole("button", { name: "Raise to $40 for today" }).click();
  await expect
    .poll(() => calls.find((c) => c.name === "captain.answerBudget")?.body)
    .toEqual({ scope: "globex", answer: "raise" });
  await expect(panel.getByText(ASK_GLOBEX.text)).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(page.getByText("Raised to $40 for today only")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/limits-after-raise-1440-dark.png` });
});

test("editing a workspace budget saves with Save, and shows Save only when something changed", async ({
  page,
}) => {
  const { calls } = await open(page, "/limits", 1440, 900, "dark", scene({ asks: [] }));
  await expect(page.getByRole("button", { name: "Save" })).toBeHidden();
  await page.getByLabel("Budget of Acme, dollars").fill("12");
  await page.getByRole("button", { name: "Save" }).click();
  await expect
    .poll(() => calls.find((c) => c.name === "autonomy.configure")?.body)
    .toMatchObject({ orgs: { acme: { cap: { cost: 12 } } } });
});

test("the old places still lead to the Limits screen", async ({ page }) => {
  await open(page, "/autonomous?tab=rules", 1440, 900, "dark", scene());
  await page.getByRole("link", { name: "Edit budgets" }).click();
  await expect(page).toHaveURL(/\/limits$/);
  await page.goto("/setup?section=context");
  await page.getByRole("link", { name: "Limits page" }).click();
  await expect(page).toHaveURL(/\/limits$/);
});
