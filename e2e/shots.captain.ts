import { expect, type Page, test } from "@playwright/test";
import type {
  AutonomyStatus,
  CaptainAction,
  CaptainOrg,
  CaptainRun,
  CaptainStatus,
} from "../packages/shared/src/index.ts";

/**
 * The Captain page (SPEC 5.18): a card per workspace with how much the captain does there, the
 * budget next to "Runs it", "More rules", today's line and the log with Undo; and the Autonomous page
 * with a lane per "Runs it" workspace. The server is the seeded one (`ui`); the captain's status, its
 * log and autonomous mode are stubbed in the browser.
 *
 * Screenshots go to SHOTS. Run: `pnpm exec playwright test -c playwright.captain.config.ts`.
 */
const SHOTS = process.env.SHOTS ?? "/private/tmp/claude-501/captain-shots";
const NOW = Date.now();
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

const CHORES = ["ship", "cards", "questions", "memory", "projects", "triage", "cleanup", "stuck"] as const;

function org(o: Partial<CaptainOrg> & Pick<CaptainOrg, "org" | "name" | "level">): CaptainOrg {
  return {
    thread: "idle",
    effective: o.level,
    rules: { push: false, merge: false, ...(o.level === "ask" ? {} : { level: o.level }) },
    used: { tokens: 0, cost: 0 },
    summary: "",
    forYou: 0,
    chores:
      o.level === "ask"
        ? []
        : CHORES.map((chore) => ({ chore, today: 0, cap: chore === "ship" ? 5 : 1, lastRun: iso(20) })),
    ...o,
  };
}

function captain(extra: Partial<CaptainStatus> = {}): CaptainStatus {
  return {
    stopped: false,
    autonomy: "on",
    captain: "setup",
    day: "2026-10-03",
    orgs: [
      org({
        org: "private",
        name: "Private",
        level: "runs",
        rules: { level: "runs", push: false, merge: true, cap: { cost: 20 } },
        budget: { cost: 20 },
        used: { tokens: 812_000, cost: 6.4 },
        summary: "shipped 2, tidied 8 memories, 1 thing for you",
        forYou: 1,
        lane: "LOCAL-31",
      }),
      org({
        org: "globex",
        name: "Globex",
        level: "tidy",
        summary: "answered 5 cards, cleaned up 3 old tasks",
        lane: "GLX-512",
        chores: CHORES.map((chore) =>
          chore === "cleanup"
            ? {
                chore,
                today: 0,
                cap: 1,
                off: "2 failures in a row, the last: the worktree of GLX-498 could not be removed",
              }
            : { chore, today: chore === "cards" ? 5 : 0, cap: chore === "cards" ? 40 : 1 },
        ),
      }),
      org({
        org: "acme",
        name: "Acme",
        level: "runs",
        effective: "runs",
        rules: {
          level: "runs",
          push: true,
          merge: true,
          cap: { cost: 8 },
          hours: { from: "09:00", to: "18:00" },
          freeze: [{ from: "2026-12-24", to: "2026-12-26" }],
          branches: ["develop"],
          providers: ["claude"],
          tz: "Europe/Berlin",
        },
        budget: { cost: 8 },
        used: { tokens: 120_000, cost: 1.15 },
        resting: "outside working hours (09:00 to 18:00)",
      }),
      org({ org: "northwind", name: "Northwind Traders International", level: "ask" }),
    ],
    ...extra,
  };
}

const ACTIONS: CaptainAction[] = [
  {
    id: 41,
    at: iso(12),
    org: "private",
    chore: "ship",
    text: "Shipped PRV-14 to main: Move the notes export to the queued worker",
    reason: "Private is set to Runs it and lets the captain merge",
    evidence: "committed, merges cleanly into main, no card waits, no secret in the diff",
    task: "PRV-14",
    outcome: "done",
    undo: "yes",
  },
  {
    id: 40,
    at: iso(30),
    org: "globex",
    chore: "ship",
    text: "Asked you to ship GLX-505: Rate limits for the public search endpoint",
    reason: "Globex is set to Keeps things tidy, so the captain asks before shipping",
    evidence: "committed, merges cleanly into develop, no card waits, no secret in the diff",
    task: "GLX-505",
    outcome: "asked",
    undo: "no",
    undoNote: "A card for you: nothing to undo",
  },
  {
    id: 39,
    at: iso(44),
    org: "globex",
    chore: "cards",
    text: "Approved: Add the reviewer to GLX-501",
    reason: "A change within the limits",
    evidence: "@globex-builder asked to run team.add",
    task: "GLX-501",
    outcome: "done",
    undo: "yes",
  },
  {
    id: 38,
    at: iso(70),
    org: "private",
    chore: "memory",
    text: "Kept a memory: The notes service reads its config from NOTES_HOME, never from the cwd",
    reason: "Memories that wait are kept, merged or dropped once a day",
    outcome: "done",
    undo: "yes",
  },
  {
    id: 37,
    at: iso(95),
    org: "private",
    chore: "ship",
    text: "Shipped PRV-11 to main and pushed: Tidy the sync script",
    reason: "Private is set to Runs it and lets the captain merge and push",
    evidence: "committed, merges cleanly into main, no card waits, no secret in the diff",
    task: "PRV-11",
    outcome: "done",
    undo: "no",
    undoNote: "It was pushed, and a push cannot be undone. The captain pushes only after the checks pass",
  },
  {
    id: 36,
    at: iso(130),
    org: "globex",
    chore: "cleanup",
    text: "Cleanup stopped: turned off after 2 failures in a row",
    reason: "turned off after 2 failures in a row",
    outcome: "skipped",
  },
  {
    id: 35,
    at: iso(160),
    org: "private",
    chore: "triage",
    text: "Set PRV-9 to high priority: Renew the domain",
    reason: "It is due on 2026-10-04",
    task: "PRV-9",
    outcome: "done",
    undo: "done",
    undoneAt: iso(150),
  },
];

const RUNS: CaptainRun[] = [
  {
    id: 9,
    org: "private",
    chore: "ship",
    startedAt: iso(12),
    endedAt: iso(12),
    status: "done",
    trigger: "PRV-14 reached review",
    actions: 1,
    tokens: 0,
  },
];

function autonomy(): AutonomyStatus {
  const lane = (o: string, name: string, extra: Partial<AutonomyStatus["lanes"][number]>) => ({
    org: o,
    name,
    working: false,
    spend: { used: { tokens: 0, cost: 0 }, percent: 0, reached: false },
    tasks: 0,
    backlog: 0,
    ...extra,
  });
  return {
    mode: "on",
    stopped: [],
    since: iso(95),
    by: "owner",
    boss: { id: "setup", chat: "LOCAL-31", working: true, nowDoing: "Reading the Private backlog" },
    lanes: [
      lane("private", "Private", {
        chat: "LOCAL-31",
        working: true,
        nowDoing: "Reading the Private backlog to plan the next start",
        spend: { used: { tokens: 812_000, cost: 6.4 }, cap: { cost: 20 }, percent: 32, reached: false },
        tasks: 2,
        backlog: 5,
      }),
      lane("acme", "Acme", {
        chat: "ACM-120",
        spend: { used: { tokens: 120_000, cost: 1.15 }, cap: { cost: 8 }, percent: 14, reached: false },
        tasks: 1,
        backlog: 3,
        resting: "outside working hours (09:00 to 18:00)",
      }),
    ],
    now: [
      {
        task: "PRV-15",
        title: "Signed download links for finished exports",
        status: "running",
        agents: [{ id: "private-builder", nowDoing: "Editing src/export/links.ts" }],
        why: "High priority and due tomorrow",
      },
    ],
    queue: [
      { title: "Document the export API", task: "PRV-16", org: "private", why: "Next in the backlog, small" },
    ],
    queuedAt: iso(4),
    backlog: [],
    holds: [],
    spend: {
      day: "2026-10-03",
      tz: "Europe/Berlin",
      resetsAt: new Date(NOW + 6 * 3600_000).toISOString(),
      total: { used: { tokens: 932_000, cost: 7.55 }, cap: { cost: 20 }, percent: 38, reached: false },
      orgs: [],
    },
    accounts: [],
    waiting: [],
    settings: {
      day: { cost: 20 },
      orgs: {},
      floors: { window: 10, weekly: 5 },
      summary_at: "08:00",
      tz: "Europe/Berlin",
      instructions: [],
      pick: { size: "any" },
    },
    lastTick: iso(4),
  };
}

interface Scene {
  status: CaptainStatus;
}

async function stub(page: Page, scene: Scene): Promise<{ calls: { name: string; body: unknown }[] }> {
  const calls: { name: string; body: unknown }[] = [];
  const answer = (name: string, json: () => unknown) =>
    page.route(`**/api/cmd/${name}`, (r) => {
      calls.push({ name, body: r.request().postDataJSON() });
      return r.fulfill({ json: json() });
    });
  await answer("captain.status", () => scene.status);
  await answer("captain.log", () => ({ actions: ACTIONS, runs: RUNS }));
  await answer("autonomy.status", () => autonomy());
  await answer("autonomy.events", () => ({ events: [] }));
  await page.route("**/api/cmd/autonomy.configure", (r) => {
    const body = r.request().postDataJSON() as { orgs?: Record<string, Record<string, unknown>> };
    calls.push({ name: "autonomy.configure", body });
    for (const [id, change] of Object.entries(body.orgs ?? {})) {
      scene.status = {
        ...scene.status,
        orgs: scene.status.orgs.map((o) => {
          if (o.org !== id) return o;
          const level = (change.level as CaptainOrg["level"] | undefined) ?? o.level;
          const cap =
            change.cap === undefined ? o.budget : ((change.cap as CaptainOrg["budget"] | null) ?? undefined);
          return {
            ...o,
            level,
            effective: level,
            ...(cap === undefined ? { budget: undefined } : { budget: cap }),
            rules: { ...o.rules, level },
          };
        }),
      };
    }
    return r.fulfill({ json: autonomy() });
  });
  await page.route("**/api/cmd/captain.stop", (r) => {
    calls.push({ name: "captain.stop", body: null });
    scene.status = { ...scene.status, stopped: true, stoppedAt: new Date().toISOString(), autonomy: "off" };
    return r.fulfill({ json: scene.status });
  });
  await page.route("**/api/cmd/captain.resume", (r) => {
    calls.push({ name: "captain.resume", body: null });
    scene.status = { ...scene.status, stopped: false };
    return r.fulfill({ json: scene.status });
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

for (const [w, h] of [
  [1440, 900],
  [1100, 700],
] as const) {
  for (const theme of ["dark", "light"]) {
    test(`captain ${w} ${theme}`, async ({ page }) => {
      await open(page, "/captain", w, h, theme, { status: captain() });
      await expect(page.getByRole("region", { name: "Private", exact: true })).toBeVisible();
      await page.screenshot({ path: `${SHOTS}/captain-${w}-${theme}.png` });
      await noPageScroll(page);
    });
    test(`captain more rules ${w} ${theme}`, async ({ page }) => {
      await open(page, "/captain", w, h, theme, { status: captain() });
      const acme = page.getByRole("region", { name: "Acme", exact: true });
      await acme.getByRole("button", { name: "More rules" }).click();
      await expect(acme.getByRole("region", { name: "More rules for Acme" })).toBeVisible();
      await acme.scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${SHOTS}/captain-rules-${w}-${theme}.png` });
      await noPageScroll(page);
    });
    test(`autonomous lanes ${w} ${theme}`, async ({ page }) => {
      await open(page, "/autonomous", w, h, theme, { status: captain() });
      await expect(page.getByRole("button", { name: /Acme/ }).first()).toBeVisible();
      await page.screenshot({ path: `${SHOTS}/autonomous-lanes-${w}-${theme}.png` });
      await noPageScroll(page);
    });
  }
}

test("captain log at 1100", async ({ page }) => {
  await open(page, "/captain", 1100, 700, "dark", { status: captain() });
  await page.getByRole("group", { name: "View" }).getByRole("button", { name: "Log" }).click();
  await expect(page.getByRole("region", { name: "The captain's log" })).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/captain-log-1100-dark.png` });
  await noPageScroll(page);
});

test("changing a level and the budget saves them", async ({ page }) => {
  const { calls } = await open(page, "/captain", 1440, 900, "dark", { status: captain() });
  const globex = page.getByRole("region", { name: "Globex", exact: true });
  await globex.getByText("Runs it", { exact: true }).click();
  await expect
    .poll(() => calls.find((c) => c.name === "autonomy.configure")?.body)
    .toEqual({ orgs: { globex: { level: "runs" } } });
  // The budget field shows next to Runs it.
  const budget = globex.getByRole("textbox", { name: "Daily budget" });
  await expect(budget).toBeVisible();
  await expect(globex.getByRole("radio", { name: /Runs it/ })).toBeChecked();
  await budget.fill("12.50");
  await globex.getByRole("button", { name: "Save" }).click();
  await expect
    .poll(() => calls.filter((c) => c.name === "autonomy.configure").at(-1)?.body)
    .toEqual({ orgs: { globex: { cap: { cost: 12.5 } } } });
  await expect(globex.getByRole("button", { name: "Save" })).toBeHidden();
  await expect(budget).toHaveValue("12.5");
  await page.screenshot({ path: `${SHOTS}/captain-globex-runs.png` });
  // Back to Only when I ask: the budget goes away.
  await globex.getByText("Only when I ask", { exact: true }).click();
  await expect(budget).toBeHidden();
  await expect(globex.getByRole("radio", { name: /Only when I ask/ })).toBeChecked();
});

test("the Autonomous switch asks before turning off", async ({ page }) => {
  const { calls } = await open(page, "/captain", 1440, 900, "dark", { status: captain() });
  await page.getByRole("switch", { name: "Autonomous" }).first().click();
  await expect(page.getByRole("heading", { name: "Turn Autonomous off?" })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/captain-off-dialog.png` });
  await page.getByRole("button", { name: "Turn off and pause its tasks" }).click();
  await expect.poll(() => calls.find((c) => c.name === "autonomy.stop")?.body).toEqual({ how: "now" });
});

test("the sidebar Captain row opens the page, and its chat button still opens the captain chat", async ({
  page,
}) => {
  await open(page, "/", 1440, 900, "dark", { status: captain() });
  await page.getByRole("link", { name: "Captain", exact: true }).click();
  await expect(page).toHaveURL(/\/captain$/);
  await page.getByRole("button", { name: "Open the captain chat" }).click();
  await expect(page.getByRole("button", { name: "Open the captain chat" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});
