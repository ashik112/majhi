import { expect, type Page, test } from "@playwright/test";
import type {
  AutonomyEvent,
  AutonomyReport,
  AutonomyStatus,
  CaptainAction,
  CaptainStatus,
  OwnerDecision,
  SlotCapacity,
  TaskSummary,
} from "../packages/shared/src/index.ts";

/**
 * The Auto-pilot dashboard at 1440x900 dark and 1100x800 light, with no page scroll. The server is
 * the seeded one (`ui`); the status, report, tasks, decisions and log are stubbed in the browser at
 * three volumes: `heavy` (6 workspaces, long names, many tasks, a held cap), `quiet` (no activity at
 * all) and `normal`. Screenshots go to SHOTS.
 * Run: `pnpm exec playwright test -c playwright.dashboard.config.ts`.
 */
const SHOTS = process.env.SHOTS ?? "/private/tmp/claude-501/dashboard-shots";
const NOW = Date.now();
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
const DAY = "2026-10-04";
const TZ = "Europe/Berlin";

type Volume = "heavy" | "normal" | "quiet";

const WORKSPACES = [
  { id: "acme", name: "Acme" },
  { id: "globex", name: "Globex" },
  { id: "northwind", name: "Northwind Traders International Holdings and Logistics Group" },
  { id: "initech", name: "Initech" },
  { id: "umbrella", name: "Umbrella Community Fund" },
  { id: "hooli", name: "Hooli" },
];

const TITLES = [
  "Move every caller of the old synchronous export to the queued worker, with retries and a signed link",
  "Paginate the audit log endpoint",
  "Rotate refresh tokens on every auth call",
  "SSO callback returns 500 on expired state",
  "Dark mode for dashboard charts",
  "Schematic export times out on large boards",
  "Session expiry banner in the web app",
  "Explain how sessions are stored",
];

function spaces(v: Volume) {
  return v === "heavy" ? WORKSPACES : v === "normal" ? WORKSPACES.slice(0, 3) : WORKSPACES.slice(0, 2);
}

function tasks(v: Volume): TaskSummary[] {
  if (v === "quiet") return [];
  const out: TaskSummary[] = [];
  let n = 100;
  const add = (
    org: string,
    status: TaskSummary["status"],
    working: string[],
    extra: Partial<TaskSummary> = {},
  ) => {
    n += 1;
    const key = org.slice(0, 3).toUpperCase();
    out.push({
      id: `${key}-${n}`,
      title: TITLES[n % TITLES.length] as string,
      kind: "code",
      org,
      status,
      team: [`${org}-lead`, `${org}-builder`],
      mode: "lead",
      updatedAt: iso(20),
      repos: [],
      working,
      links: [],
      waitingOn: [],
      ...extra,
    });
  };
  for (const [i, w] of spaces(v).entries()) {
    add(w.id, "running", [`${w.id}-builder`]);
    if (i % 2 === 0) add(w.id, "running", [`${w.id}-lead`]);
    if (i % 2 === 1) add(w.id, "paused", [], { pausedReason: i === 1 ? "limit" : "owner" });
    add(w.id, "review", []);
    if (v === "heavy") {
      add(w.id, "inbox", []);
      add(w.id, "review", []);
    }
  }
  return out;
}

function decisions(v: Volume): OwnerDecision[] {
  if (v === "quiet") return [];
  const list = tasks(v).filter((t) => t.status === "review");
  return list.map((t, i) => ({
    id: `room:${t.id}:1`,
    kind: i % 3 === 2 ? ("approval" as const) : ("ship" as const),
    org: t.org as string,
    task: t.id,
    taskTitle: t.title,
    title: `${t.title} is ready`,
    options: [],
    at: iso(40 + i * 55),
    link: { kind: "task" as const, id: t.id },
  }));
}

function report(v: Volume): AutonomyReport {
  const start = new Date(NOW);
  start.setUTCHours(0, 0, 0, 0);
  const hours = Math.floor((NOW - start.getTime()) / 3_600_000) + 1;
  return {
    tz: TZ,
    today: DAY,
    hours: Array.from({ length: hours }, (_, i) => ({
      start: new Date(start.getTime() + i * 3_600_000).toISOString(),
      cost: v === "quiet" ? 0 : Math.round((1 + ((i * 7) % 9) * (v === "heavy" ? 2.4 : 0.6)) * 100) / 100,
      tokens: 100_000,
    })),
    days: Array.from({ length: 14 }, (_, i) => ({
      day: `2026-09-${String(21 + i).padStart(2, "0")}`,
      orgs: v === "quiet" ? [] : [{ org: "acme", count: 1 + ((i * 5) % (v === "heavy" ? 9 : 4)) }],
    })),
    stuck:
      v === "quiet"
        ? []
        : [
            {
              task: "GLO-103",
              title: TITLES[0] as string,
              org: "globex",
              kind: "loop",
              since: iso(310),
              text: "Same step 6 times: Woke the builder to retry the export test",
            },
            {
              task: "NOR-105",
              title: TITLES[2] as string,
              org: "northwind",
              kind: "waiting",
              since: iso(260),
              text: "Push to origin needs your approval",
              item: "i1",
            },
            {
              task: "ACM-101",
              title: TITLES[5] as string,
              org: "acme",
              kind: "idle",
              since: iso(190),
              text: "Running with no progress",
            },
            ...(v === "heavy"
              ? [
                  {
                    task: "UMB-109",
                    title: TITLES[3] as string,
                    org: "umbrella",
                    kind: "failures" as const,
                    since: iso(150),
                    text: "4 failed or refused calls in a day",
                  },
                  {
                    task: "HOO-112",
                    title: TITLES[6] as string,
                    org: "hooli",
                    kind: "waiting" as const,
                    since: iso(130),
                    text: "In review, not shipped",
                  },
                ]
              : []),
          ],
    machine: {
      cores: 10,
      load1: v === "heavy" ? 11.2 : 3.4,
      idleCpuPct: v === "heavy" ? 9 : 61,
      memFreePct: v === "heavy" ? 8 : 38,
      diskFreeGb: 212,
      containers: v === "quiet" ? 0 : 5,
      ...(v === "heavy" ? { busy: "the machine is busy: load 11.2 on 10 cores, 1.3 GB free" } : {}),
    },
  };
}

function status(v: Volume): AutonomyStatus {
  const heavy = v === "heavy";
  const used = v === "quiet" ? 0 : heavy ? 187.4 : 24.6;
  const accounts = (heavy ? 6 : v === "quiet" ? 1 : 3).valueOf();
  return {
    mode: "on",
    stopped: [],
    raised: {},
    since: iso(300),
    by: "owner",
    lastTick: iso(4),
    lanes: spaces(v).map((w, i) => ({
      org: w.id,
      name: w.name,
      working: i === 0 && v !== "quiet",
      spend: { used: { tokens: 0, cost: 0 }, percent: 0, reached: false },
      tasks: 2,
      backlog: 3,
      ...(heavy && i === 5 ? { resting: "Hooli reached its $50 budget for today" } : {}),
    })),
    now: tasks(v).map((t, i) => ({
      task: t.id,
      title: t.title,
      org: t.org as string,
      status: t.status,
      agents: [],
      since: iso(14 + i * 37),
    })),
    queue: [],
    backlog: [],
    holds: heavy
      ? [
          {
            kind: "day-cap",
            text: "Auto-pilot reached its $200.00 cap for today",
            until: new Date(NOW + 5 * 3_600_000).toISOString(),
          },
        ]
      : [],
    spend: {
      day: DAY,
      tz: TZ,
      resetsAt: new Date(NOW + 5 * 3_600_000).toISOString(),
      total: {
        used: { tokens: 1_000_000, cost: used },
        cap: { cost: 200 },
        percent: (used / 200) * 100,
        reached: false,
      },
      orgs: [],
    },
    accounts: Array.from({ length: accounts }, (_, i) => ({
      id: heavy && i === 2 ? "claude-northwind-international-1" : `claude-acme-${i + 1}`,
      org: "acme",
      tool: "claude" as const,
      window: { usedPct: 20 + i * 14, resetsAt: new Date(NOW + 3 * 3_600_000).toISOString() },
      weekly: { usedPct: 35 + i * 11, resetsAt: new Date(NOW + 2 * 86_400_000).toISOString() },
      ...(heavy && i === 4
        ? {
            blocked: {
              why: "Weekly usage is over the floor",
              until: new Date(NOW + 86_400_000).toISOString(),
            },
          }
        : {}),
    })),
    waiting: [],
    settings: {
      day: { cost: 200 },
      orgs: {},
      floors: { window: 10, weekly: 5 },
      summary_at: "08:00",
      tz: TZ,
      instructions: [],
      pick: {},
    },
  } as unknown as AutonomyStatus;
}

function slots(v: Volume): SlotCapacity {
  const n = v === "heavy" ? 6 : v === "quiet" ? 1 : 3;
  return {
    agents: { inUse: v === "quiet" ? 0 : n + 2, waiting: v === "heavy" ? 2 : 0, limit: 12, free: 4 },
    accounts: Array.from({ length: n }, (_, i) => ({
      account: v === "heavy" && i === 2 ? "claude-northwind-international-1" : `claude-acme-${i + 1}`,
      inUse: v === "quiet" ? 0 : i % 3,
      waiting: 0,
      limit: 3,
      free: 3 - (i % 3),
    })),
  };
}

function actions(v: Volume): CaptainAction[] {
  if (v === "quiet") return [];
  const verbs = [
    "Shipped {t} to main",
    "Asked you to ship {t}",
    "Resumed {t} after the account reset",
    "Started {t} on the cheapest account with room",
    "Answered a permission prompt in {t}",
  ];
  return Array.from({ length: v === "heavy" ? 40 : 12 }, (_, i) => {
    const w = spaces(v)[i % spaces(v).length] as { id: string };
    const task = `${w.id.slice(0, 3).toUpperCase()}-${101 + (i % 8)}`;
    return {
      id: 100 - i,
      at: iso(3 + i * 11),
      org: w.id,
      chore: "ship",
      text: (verbs[i % verbs.length] as string).replace("{t}", `${task}: ${TITLES[i % TITLES.length]}`),
      reason: "Rules allow it",
      task,
      outcome: "done",
    } as CaptainAction;
  });
}

async function stub(page: Page, v: Volume) {
  const answer = (name: string, json: unknown) =>
    page.route(`**/api/cmd/${name}`, (r) => r.fulfill({ json }));
  await answer("captain.status", {
    stopped: false,
    autonomy: "on",
    captain: "setup",
    day: DAY,
    orgs: [],
  } satisfies CaptainStatus);
  await answer("captain.log", { actions: actions(v), runs: [] });
  await answer("autonomy.status", status(v));
  await answer("autonomy.report", report(v));
  await answer("autonomy.events", { events: [] satisfies AutonomyEvent[] });
  await answer("tasks.list", tasks(v));
  await answer("tasks.slots", slots(v));
  await answer("decisions.list", { decisions: decisions(v) });
}

async function noPageScroll(page: Page) {
  const overflow = await page.evaluate(() => ({
    x: document.documentElement.scrollWidth - window.innerWidth,
    y: document.documentElement.scrollHeight - window.innerHeight,
  }));
  expect(overflow).toEqual({ x: 0, y: 0 });
}

for (const [w, h, theme] of [
  [1440, 900, "dark"],
  [1100, 800, "light"],
] as const) {
  for (const v of ["heavy", "normal", "quiet"] as const) {
    test(`dashboard ${v} ${w} ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: h });
      await stub(page, v);
      await page.goto("/captain");
      await page.evaluate((t) => {
        document.documentElement.dataset.theme = t;
      }, theme);
      await expect(page.getByRole("region", { name: "Auto-pilot dashboard" })).toBeVisible();
      await page.waitForTimeout(900);
      await page.screenshot({ path: `${SHOTS}/${v}-${w}-${theme}.png` });
      await noPageScroll(page);
    });
  }
}
