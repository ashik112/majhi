import { expect, type Page, test } from "@playwright/test";
import type {
  Authority,
  AutonomyEvent,
  AutonomyStatus,
  BudgetAsk,
  CaptainAction,
  CaptainOrg,
  CaptainStatus,
  RoomItem,
  RoomServerMessage,
  Task,
} from "../packages/shared/src/index.ts";

/**
 * The Captain page (SPEC 5.16, 5.18): one place with Today, Chat, Log and Rules, the Autonomous
 * switch under Captain in the sidebar, the old /autonomous address landing on Today, and the Chats
 * list without ids. The server is the seeded one (`ui`); the captain's status, autonomous mode, its
 * log and its threads are stubbed in the browser.
 *
 * Screenshots go to SHOTS. Run: `pnpm exec playwright test -c playwright.captain.config.ts`.
 */
const SHOTS = process.env.SHOTS ?? "/private/tmp/claude-501/captain-shots";
const NOW = Date.now();
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
const DAY = "2026-10-04";
const LONG = "Northwind Traders International Holdings and Logistics Group";
const LONG_TASK =
  "Move every caller of the old synchronous export to the queued worker, with retries, progress events and a signed download link that expires after a day";

const CHORES = ["ship", "cards", "questions", "memory", "projects", "triage", "cleanup", "stuck"] as const;

const ROWS = (
  start: boolean,
  answers: boolean,
  upkeep: boolean,
  merge: boolean,
  push: boolean,
): Authority => ({
  start: start ? "decide" : "ask",
  questions: answers ? "decide" : "ask",
  approvals: answers ? "decide" : "ask",
  upkeep: upkeep ? "decide" : "ask",
  merge: merge ? "decide" : "ask",
  push: push ? "decide" : "ask",
});
const RUNS_ROWS = ROWS(true, true, true, false, false);
const TIDY_ROWS = ROWS(false, true, true, false, false);
const ASK_ROWS = ROWS(false, false, false, false, false);

function org(o: Partial<CaptainOrg> & Pick<CaptainOrg, "org" | "name" | "authority">): CaptainOrg {
  const asks = Object.values(o.authority).every((c) => c === "ask");
  return {
    thread: "idle",
    effective: o.authority,
    rules: { authority: o.authority },
    used: { tokens: 0, cost: 0 },
    summary: "",
    forYou: 0,
    chores: asks
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
    day: DAY,
    orgs: [
      org({
        org: "private",
        name: "Private",
        authority: RUNS_ROWS,
        budget: { cost: 20 },
        rules: { authority: RUNS_ROWS, cap: { cost: 20 } },
        used: { tokens: 812_000, cost: 6.4 },
        summary: "shipped 2, tidied 8 memories, 1 thing for you",
        forYou: 1,
        thread: "working",
        lane: "LOCAL-31",
      }),
      org({
        org: "globex",
        name: "Globex",
        authority: TIDY_ROWS,
        budget: { cost: 10 },
        used: { tokens: 3_000_000, cost: 8.9 },
        summary: "answered 5 cards, cleaned up 3 old tasks",
        thread: "waiting",
        lane: "GLX-512",
        chores: CHORES.map((chore) =>
          chore === "cleanup"
            ? {
                chore,
                today: 0,
                cap: 1,
                off: "2 failures in a row, the last: the worktree of GLX-498 could not be removed",
              }
            : { chore, today: chore === "cards" ? 40 : 0, cap: chore === "cards" ? 40 : 1 },
        ),
      }),
      org({
        org: "acme",
        name: "Acme",
        authority: ROWS(true, true, true, true, true),
        budget: { cost: 8 },
        used: { tokens: 120_000, cost: 1.15 },
        resting: "outside working hours (09:00 to 18:00)",
        lane: "ACM-120",
      }),
      org({ org: "northwind", name: LONG, authority: ASK_ROWS }),
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
    reason: "In Private the captain decides when work is merged",
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
    reason: "In Globex you decide when work is merged, so the captain asks before shipping",
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
    reason: "In Private the captain decides when work is merged and pushed",
    task: "PRV-11",
    outcome: "done",
    undo: "no",
    undoNote: "It was pushed, and a push cannot be undone",
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

const EVENTS: AutonomyEvent[] = [
  {
    seq: 90,
    at: iso(5),
    kind: "decision",
    org: "globex",
    text: `Start a task GLX-430: ${LONG_TASK}`,
    reason: "High priority and due tomorrow; the export times out for three customers",
    task: "GLX-430",
    outcome: "applied",
  },
  { seq: 89, at: iso(8), kind: "tick", text: "Woke the captain: GLX-429 is done" },
  {
    seq: 88,
    at: iso(20),
    kind: "task",
    org: "acme",
    text: "ACM-88 is ready for review: Add rate limits",
    task: "ACM-88",
    status: "review",
  },
  {
    seq: 87,
    at: iso(33),
    kind: "approval",
    org: "acme",
    text: "Left for the owner: Push task/ACM-88-rate-limits. Acme does not let the captain push",
    task: "ACM-88",
    outcome: "left",
  },
  {
    seq: 86,
    at: iso(50),
    kind: "cap",
    org: "globex",
    text: "Globex used its $10 for today. 3 tasks wait",
    reason: "The workspace budget is used up",
  },
  {
    seq: 85,
    at: iso(60),
    kind: "task",
    org: "private",
    text: "PRV-15 started: Signed download links for finished exports",
    task: "PRV-15",
    status: "running",
    reason: "Small and nothing else touches the repo",
  },
  { seq: 84, at: iso(95), kind: "mode", text: "Autonomous turned on" },
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
    raised: {},
    since: iso(95),
    by: "owner",
    boss: { id: "setup", chat: "LOCAL-31", working: true, nowDoing: "Reading the Private backlog" },
    lanes: [
      lane("private", "Private", { chat: "LOCAL-31", working: true, tasks: 2, backlog: 5 }),
      lane("globex", "Globex", { chat: "GLX-512", tasks: 1, backlog: 3 }),
      lane("acme", "Acme", { chat: "ACM-120", tasks: 1, backlog: 1 }),
    ],
    now: [
      {
        task: "GLX-430",
        title: LONG_TASK,
        org: "globex",
        status: "running",
        agents: [
          { id: "globex-builder", nowDoing: "Editing src/export/worker.ts and its tests" },
          { id: "globex-reviewer" },
        ],
        why: "High priority and due tomorrow; the export times out for three customers",
      },
      {
        task: "ACM-88",
        title: "Add rate limits to the public search endpoint",
        org: "acme",
        status: "review",
        agents: [{ id: "acme-builder" }],
        why: "Small and blocks the Acme release",
      },
    ],
    queue: [
      {
        title: "Signed download links for finished exports",
        task: "GLX-432",
        org: "globex",
        why: "Next child of the export work; it waits on nothing and the Globex account has 60% of its window left",
      },
      {
        title: "Document the export API for partners",
        task: "GLX-437",
        org: "globex",
        why: "Low priority filler for when the builders are idle",
      },
      {
        title: "Tidy the Acme README and the setup script",
        task: "ACM-91",
        org: "acme",
        why: "Small, cheap model, can run while Acme has room",
      },
    ],
    queuedAt: iso(4),
    backlog: [
      {
        task: "GLX-432",
        title: "Signed download links for finished exports",
        org: "globex",
        status: "ready",
        priority: "high",
        size: "small",
        sizeNote: "Laya rated it small (0.81)",
        noAutonomy: false,
      },
      {
        task: "GLX-431",
        title: LONG_TASK,
        org: "globex",
        status: "inbox",
        size: "large",
        sizeNote: "Laya rated it large (0.37)",
        noAutonomy: false,
      },
      {
        task: "ACM-95",
        title: "Migrate the billing tables to the new schema",
        org: "acme",
        status: "inbox",
        size: "large",
        sizeNote: "Laya rated it large (0.64)",
        noAutonomy: true,
        leftOut: "Marked as one to leave alone",
      },
      {
        task: "PRV-20",
        title: "Rotate the staging certificates",
        status: "ready",
        size: "small",
        sizeNote: "Laya rated it small (0.9)",
        noAutonomy: false,
      },
    ],
    holds: [],
    spend: {
      day: DAY,
      tz: "Europe/Berlin",
      resetsAt: new Date(NOW + 6 * 3600_000).toISOString(),
      total: { used: { tokens: 4_200_000, cost: 16.45 }, cap: { cost: 40 }, percent: 41, reached: false },
      orgs: [],
    },
    accounts: [],
    waiting: [],
    settings: {
      day: { cost: 40 },
      orgs: { private: { cap: { cost: 20 } }, globex: { cap: { cost: 10 } }, acme: { cap: { cost: 8 } } },
      floors: { window: 10, weekly: 5 },
      summary_at: "08:00",
      tz: "Europe/Berlin",
      instructions: [
        {
          id: "abcd1234",
          text: "Be careful in the Globex billing code; no product-specific fixes.",
          at: iso(3000),
        },
      ],
      pick: { size: "medium" },
    },
    summary: {
      day: "2026-10-03",
      from: iso(1500),
      to: iso(60),
      at: iso(55),
      shipped: [
        { task: "GLX-420", title: "Cache the board thumbnails", org: "globex", how: "mr-open" },
        { task: "ACM-80", title: "Fix the login redirect loop", org: "acme", how: "merged" },
      ],
      spent: {
        total: { used: { tokens: 9_000_000, cost: 14.1 }, cap: { cost: 40 }, percent: 35, reached: false },
        orgs: [],
      },
      unsure: [{ text: "Skipped NW-14: the certificates need the owner's VPN", task: "NW-14" }],
      waiting: [],
      decisions: 23,
    },
    lastTick: iso(4),
  };
}

const ASK: BudgetAsk = {
  scope: "globex",
  name: "Globex",
  day: DAY,
  cap: { cost: 10 },
  raiseTo: { cost: 20 },
  waiting: 3,
  text: "Globex used its $10 for today. 3 tasks are waiting. Raise it to $20 for today?",
  at: iso(10),
};

const thread: Task = {
  id: "LOCAL-31",
  title: "Private",
  brief: "Captain lane",
  kind: "chat",
  status: "running",
  folder: "/Users/owner/.majhi/tasks/LOCAL-31",
  repos: [],
  team: ["setup"],
  mode: "lead",
  overrides: {},
  links: [],
  attachments: [],
  createdAt: iso(5000),
  updatedAt: iso(1),
};

function conversation(chat: string): RoomItem[] {
  const out: RoomItem[] = [];
  for (let n = 1; n <= 6; n++) {
    out.push({
      id: `i${n}a`,
      task: chat,
      seq: n * 2,
      at: iso(200 - n * 20),
      type: "agent",
      agent: "setup",
      text: `Plan ${n}: GLX-430 runs with the builder. Next is **GLX-432**, then the docs. ACM-88 waits for your push approval, so I left it.`,
    } as RoomItem);
    if (n % 3 === 0)
      out.push({
        id: `i${n}b`,
        task: chat,
        seq: n * 2 + 1,
        at: iso(190 - n * 20),
        type: "owner",
        text: "Why only small tasks yesterday? Take the export rework too.",
        attachments: [],
        queued: false,
      } as RoomItem);
  }
  return out;
}

async function stub(page: Page, state: { asks: BudgetAsk[] }) {
  const answer = (name: string, json: () => unknown) =>
    page.route(`**/api/cmd/${name}`, (r) => r.fulfill({ json: json() }));
  await answer("captain.status", () => captain());
  await answer("captain.log", () => ({ actions: ACTIONS, runs: [] }));
  await answer("captain.asks", () => ({ asks: [], budgets: state.asks }));
  await answer("autonomy.status", () => autonomy());
  await answer("autonomy.events", () => ({ events: EVENTS }));
  await answer("boss.chat", () => ({ ...thread, id: "LOCAL-40", title: "Captain chat", team: ["setup"] }));
  await answer("tasks.get", () => thread);
  await answer("room.items", () => ({ items: conversation("LOCAL-31").reverse(), more: false }));
  await page.routeWebSocket(/\/api\/tasks\/([^/]+)\/room$/, (ws) => {
    const snapshot = {
      type: "snapshot",
      more: false,
      processes: [],
      agents: [{ agent: "setup", status: "idle", queued: 0, commands: [] }],
      items: conversation("LOCAL-31"),
    } as unknown as RoomServerMessage;
    ws.send(JSON.stringify(snapshot));
  });
}

const chat = (id: string, title: string, agent: string, minutesAgo: number, org?: string) => ({
  id,
  title,
  kind: "chat",
  status: "running",
  team: [agent],
  mode: "lead",
  updatedAt: iso(minutesAgo),
  repos: [],
  working: [],
  links: [],
  waitingOn: [],
  chat: true,
  ...(org === undefined ? {} : { org }),
});
const CHATS = [
  chat("LOCAL-12", "Chat", "setup", 3),
  chat("LOCAL-14", "Set up the MCP skills for the Globex repo", "setup", 90),
  chat("GLX-501", "Why does the export time out for large accounts?", "globex-lead", 25, "globex"),
  chat("GLX-509", "Chat", "globex-lead", 600, "globex"),
  chat("ACM-77", "Plan the rate limit rollout", "acme-lead", 2000, "acme"),
];

async function open(page: Page, path: string, w: number, h: number, theme: string) {
  await page.setViewportSize({ width: w, height: h });
  await stub(page, { asks: [ASK] });
  if (path === "/chats") await page.route("**/api/cmd/tasks.list", (r) => r.fulfill({ json: CHATS }));
  await page.goto(path);
  await page.evaluate((t) => {
    document.documentElement.dataset.theme = t;
  }, theme);
  await page.waitForTimeout(800);
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
    test(`today ${w} ${theme}`, async ({ page }) => {
      await open(page, "/captain?tab=today", w, h, theme);
      await expect(page.getByRole("region", { name: "Running now" })).toBeVisible();
      await expect(page.getByText("1 thing needs you")).toBeVisible();
      await page.screenshot({ path: `${SHOTS}/today-${w}-${theme}.png` });
      await noPageScroll(page);
    });
    test(`chat ${w} ${theme}`, async ({ page }) => {
      await open(page, "/captain?tab=chat", w, h, theme);
      await expect(page.getByRole("region", { name: "Captain chat" })).toBeVisible();
      await page.getByRole("tab", { name: "Private" }).click();
      await page.waitForTimeout(600);
      await page.screenshot({ path: `${SHOTS}/chat-${w}-${theme}.png` });
      await noPageScroll(page);
    });
    test(`log ${w} ${theme}`, async ({ page }) => {
      await open(page, "/captain?tab=log", w, h, theme);
      await expect(page.getByRole("region", { name: "Log" })).toBeVisible();
      await page.screenshot({ path: `${SHOTS}/log-${w}-${theme}.png` });
      await noPageScroll(page);
    });
    test(`rules ${w} ${theme}`, async ({ page }) => {
      await open(page, "/captain?tab=rules", w, h, theme);
      await expect(page.getByRole("region", { name: "Acme", exact: true })).toBeVisible();
      await page.screenshot({ path: `${SHOTS}/rules-${w}-${theme}.png` });
      await noPageScroll(page);
    });
    test(`rules with the leave-alone list open ${w} ${theme}`, async ({ page }) => {
      await open(page, "/captain?tab=rules", w, h, theme);
      const globex = page.getByRole("region", { name: "Globex", exact: true });
      await globex.getByRole("button", { name: /^Leave tasks alone/ }).click();
      await globex.scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${SHOTS}/rules-leave-alone-${w}-${theme}.png` });
      await noPageScroll(page);
    });
    test(`the long-named workspace in Rules ${w} ${theme}`, async ({ page }) => {
      await open(page, "/captain?tab=rules", w, h, theme);
      const long = page.getByRole("region", { name: /^Northwind Traders International/ });
      await long.scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${SHOTS}/rules-long-${w}-${theme}.png` });
      await noPageScroll(page);
    });
    test(`chats list ${w} ${theme}`, async ({ page }) => {
      await open(page, "/chats", w, h, theme);
      await page.screenshot({ path: `${SHOTS}/chats-${w}-${theme}.png` });
      await noPageScroll(page);
    });
    test(`autonomous address lands on Today ${w} ${theme}`, async ({ page }) => {
      await open(page, "/autonomous", w, h, theme);
      await expect(page).toHaveURL(/\/captain\?tab=today$/);
      await page.screenshot({ path: `${SHOTS}/autonomous-redirect-${w}-${theme}.png` });
    });
  }
}

test("the old Autonomous views land on the matching tab", async ({ page }) => {
  await open(page, "/autonomous?tab=rules", 1440, 900, "dark");
  await expect(page).toHaveURL(/\/captain\?tab=rules$/);
  await page.goto("/autonomous?tab=log");
  await expect(page).toHaveURL(/\/captain\?tab=log$/);
  await page.goto("/autonomous?tab=summary");
  await expect(page).toHaveURL(/\/captain\?tab=today$/);
});

test("the tab is in the address and the sidebar has one Captain entry with the switch under it", async ({
  page,
}) => {
  await open(page, "/", 1440, 900, "dark");
  const nav = page.getByRole("navigation", { name: "Main" });
  await expect(nav.getByRole("link", { name: "Autonomous" })).toHaveCount(0);
  await expect(nav.getByRole("switch", { name: "Autonomous" })).toBeVisible();
  await nav.getByRole("link", { name: "Captain", exact: true }).click();
  await expect(page).toHaveURL(/\/captain$/);
  await page.getByRole("button", { name: "Log", exact: true }).click();
  await expect(page).toHaveURL(/\/captain\?tab=log$/);
  await page.screenshot({
    path: `${SHOTS}/sidebar-1440-dark.png`,
    clip: { x: 0, y: 0, width: 320, height: 520 },
  });
});

test("the log filters by kind and workspace", async ({ page }) => {
  await open(page, "/captain?tab=log", 1440, 900, "dark");
  await page.getByRole("button", { name: "Holds", exact: true }).click();
  await expect(page.getByText("Globex used its $10 for today. 3 tasks wait")).toBeVisible();
  await expect(page.getByText("Woke the captain")).toBeHidden();
  await page.getByRole("button", { name: "All", exact: true }).click();
  await page.getByRole("combobox", { name: "Workspace" }).selectOption("acme");
  await expect(page.getByText("ACM-88 is ready for review")).toBeVisible();
  await expect(page.getByText("Approved: Add the reviewer")).toBeHidden();
});
