import { expect, type Page, test } from "@playwright/test";
import type {
  Authority,
  AutonomyEvent,
  AutonomyStatus,
  CaptainAction,
  CaptainOrg,
  CaptainStatus,
  OwnerDecision,
  RoomItem,
  RoomServerMessage,
  Task,
} from "../packages/shared/src/index.ts";

/**
 * The Captain page (SPEC 5.18): one screen with the Autonomous switch, one status sentence, the
 * conversation on the left and the Now column on the right. Delegation, the log and the summary open
 * in sheets. The server is the seeded one (`ui`); the captain's status, Autonomous, the log, the
 * decisions and the threads are stubbed in the browser, at the volume of a real day: 4 workspaces,
 * 30 tasks shipped, 9 notes, 5 decisions, 120 log events, a turn with 40 tool calls, one workspace
 * over its budget. A second set has 6 workspaces, one with a very long name.
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

type Mode = "on" | "off";
interface Scenario {
  /** `real`: 4 workspaces at the volume of a real day. `many`: 6 workspaces, one with a long name. */
  set: "real" | "many";
  mode: Mode;
}

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

function orgs(set: Scenario["set"]): CaptainOrg[] {
  const real = [
    org({
      org: "private",
      name: "Private",
      authority: RUNS_ROWS,
      budget: { cost: 100 },
      rules: { authority: RUNS_ROWS, cap: { cost: 100 } },
      used: { tokens: 8_120_000, cost: 31.04 },
      thread: "waiting",
      forYou: 2,
      lane: "LOCAL-31",
    }),
    org({
      org: "pyzasoft",
      name: "Pyzasoft",
      authority: ROWS(true, true, true, true, false),
      budget: { cost: 50 },
      rules: { authority: ROWS(true, true, true, true, false), cap: { cost: 50 } },
      used: { tokens: 19_000_000, cost: 80.56 },
      thread: "working",
      lane: "PYZ-2",
      resting: "its budget of $50 for today is used up",
    }),
    org({
      org: "goama",
      name: "Goama",
      authority: TIDY_ROWS,
      used: { tokens: 6_000_000, cost: 29.1 },
      lane: "GOA-9",
    }),
    org({
      org: "ideeza",
      name: "Ideeza",
      authority: ASK_ROWS,
      used: { tokens: 900_000, cost: 4.2 },
      lane: "IDZ-4",
    }),
  ];
  if (set === "real") return real;
  return [
    ...real.slice(0, 3),
    org({ org: "acme", name: "Acme", authority: ROWS(true, true, true, true, true), budget: { cost: 8 } }),
    org({ org: "globex", name: "Globex", authority: TIDY_ROWS, used: { tokens: 3_000_000, cost: 8.9 } }),
    org({ org: "northwind", name: LONG, authority: ASK_ROWS, lane: "NW-3" }),
  ];
}

function captain(s: Scenario): CaptainStatus {
  return {
    stopped: false,
    autonomy: s.mode,
    captain: "setup",
    day: DAY,
    orgs: orgs(s.set),
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
    org: "pyzasoft",
    chore: "ship",
    text: "Asked you to ship PYZ-505: Shop orders created twice",
    reason: "In Pyzasoft you decide when work is pushed, so the captain asks before shipping",
    task: "PYZ-505",
    outcome: "asked",
    undo: "no",
    undoNote: "A card for you: nothing to undo",
  },
  {
    id: 39,
    at: iso(44),
    org: "goama",
    chore: "cards",
    text: "Approved: Add the reviewer to GOA-501",
    reason: "A change within the limits",
    evidence: "@goama-builder asked to run team.add",
    task: "GOA-501",
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

const TITLES: Record<string, string> = {
  "PRV-14": "Move the notes export to the queued worker",
  "PYZ-505": "Shop orders created twice",
  "PYZ-430": "Phase 7: Resilience",
  "PYZ-432": "Resilience and health",
  "GOA-501": "Add the reviewer to the Goama agents",
  "PRV-11": "Tidy the sync script",
  "PRV-9": "Renew the domain",
  "GOA-88": "Add rate limits to the public search endpoint",
  "IDZ-12": LONG_TASK,
};

function events(): AutonomyEvent[] {
  const out: AutonomyEvent[] = [
    {
      seq: 400,
      at: iso(3),
      kind: "task",
      org: "pyzasoft",
      text: "PYZ-430 paused (owner): Phase 7: Resilience",
      task: "PYZ-430",
      status: "paused",
    },
    {
      seq: 399,
      at: iso(4),
      kind: "task",
      org: "private",
      text: "LOCAL-16 is running: Private",
      task: "LOCAL-16",
      status: "running",
    },
    {
      seq: 398,
      at: iso(6),
      kind: "task",
      org: "pyzasoft",
      text: "PYZ-2 is done: Pyzasoft",
      task: "PYZ-2",
      status: "done",
    },
    {
      seq: 397,
      at: iso(8),
      kind: "decision",
      org: "pyzasoft",
      text: "Start a task PYZ-432: Resilience and health",
      reason: "Top of the backlog",
      task: "PYZ-432",
      outcome: "applied",
    },
    { seq: 396, at: iso(9), kind: "tick", text: "Woke the captain: PYZ-429 is done" },
    {
      seq: 395,
      at: iso(14),
      kind: "approval",
      org: "goama",
      text: "Left for the owner: Push task/GOA-88-rate-limits. Goama does not let the captain push",
      task: "GOA-88",
      outcome: "left",
    },
    {
      seq: 394,
      at: iso(20),
      kind: "cap",
      org: "pyzasoft",
      text: "Pyzasoft used its $50 for today. 3 tasks wait",
      reason: "The workspace budget is used up",
    },
    { seq: 393, at: iso(25), kind: "mode", text: "Autonomous turned off" },
  ];
  for (let i = 0; i < 112; i++) {
    out.push({
      seq: 392 - i,
      at: iso(30 + i * 9),
      kind: i % 3 === 0 ? "decision" : i % 3 === 1 ? "approval" : "answer",
      org: ["private", "pyzasoft", "goama", "ideeza"][i % 4] as string,
      text: `Answered a question in IDZ-12: use the queued worker (${i})`,
      reason: "The brief settles it",
      task: "IDZ-12",
      outcome: "applied",
    });
  }
  return out;
}

function autonomy(s: Scenario): AutonomyStatus {
  const lane = (o: string, name: string, extra: Partial<AutonomyStatus["lanes"][number]>) => ({
    org: o,
    name,
    working: false,
    spend: { used: { tokens: 0, cost: 0 }, percent: 0, reached: false },
    tasks: 0,
    backlog: 0,
    ...extra,
  });
  const shipped = Array.from({ length: 30 }, (_, i) => ({
    task: `PYZ-${300 + i}`,
    title:
      i % 7 === 0
        ? LONG_TASK
        : `Ship the ${["export", "billing", "search", "notes", "sync"][i % 5]} change number ${i + 1}`,
    org: ["private", "pyzasoft", "goama", "ideeza"][i % 4] as string,
    how: (["merged", "pushed", "mr-open", "review"] as const)[i % 4] as "merged",
  }));
  return {
    mode: s.mode,
    stopped: [],
    raised: {},
    since: iso(95),
    by: "owner",
    boss: {
      id: "setup",
      chat: "LOCAL-31",
      working: s.mode === "on",
      nowDoing: "Reading the Private backlog",
    },
    lanes: [
      lane("private", "Private", { chat: "LOCAL-31", working: true, tasks: 2, backlog: 5 }),
      lane("pyzasoft", "Pyzasoft", { chat: "PYZ-2", tasks: 1, backlog: 3 }),
    ],
    now:
      s.mode === "off"
        ? []
        : [
            {
              task: "PYZ-432",
              title: "Resilience and health",
              org: "pyzasoft",
              status: "running",
              agents: [{ id: "pyz-builder", nowDoing: "Editing src/export/worker.ts and its tests" }],
              why: "Top of the backlog; the export times out for three customers",
            },
            {
              task: "IDZ-12",
              title: LONG_TASK,
              org: "ideeza",
              status: "review",
              agents: [{ id: "idz-builder" }],
              why: "Small and blocks the Ideeza release",
            },
          ],
    queue:
      s.mode === "off"
        ? []
        : [
            {
              title: "Signed download links for finished exports",
              task: "GOA-432",
              org: "goama",
              why: "Next child of the export work; it waits on nothing and the Goama account has 60% of its window left",
            },
            {
              title: "Document the export API for partners",
              task: "GOA-437",
              org: "goama",
              why: "Low priority filler for when the builders are idle",
            },
            {
              title: "Tidy the README and the setup script",
              task: "PRV-91",
              org: "private",
              why: "Small, cheap model, can run while Private has room",
            },
          ],
    queuedAt: iso(4),
    backlog: [
      {
        task: "GOA-432",
        title: "Signed download links for finished exports",
        org: "goama",
        status: "ready",
        priority: "high",
        size: "small",
        sizeNote: "Laya rated it small (0.81)",
        noAutonomy: false,
      },
      {
        task: "PYZ-95",
        title: "Migrate the billing tables to the new schema",
        org: "pyzasoft",
        status: "inbox",
        size: "large",
        sizeNote: "Laya rated it large (0.64)",
        noAutonomy: true,
        leftOut: "Marked as one to leave alone",
      },
    ],
    holds: [],
    spend: {
      day: DAY,
      tz: "Europe/Berlin",
      resetsAt: new Date(NOW + 6 * 3600_000).toISOString(),
      total: { used: { tokens: 34_000_000, cost: 144.9 }, cap: { cost: 200 }, percent: 72, reached: false },
      orgs: [],
    },
    accounts: [],
    waiting: [],
    settings: {
      day: { cost: 200 },
      orgs: { private: { cap: { cost: 100 } }, pyzasoft: { cap: { cost: 50 } } },
      floors: { window: 10, weekly: 5 },
      summary_at: "08:00",
      tz: "Europe/Berlin",
      instructions: [
        {
          id: "abcd1234",
          text: "Be careful in the Pyzasoft billing code; no product-specific fixes.",
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
      shipped,
      spent: {
        total: { used: { tokens: 19_000_000, cost: 80.56 }, cap: { cost: 50 }, percent: 161, reached: true },
        orgs: [],
      },
      unsure: Array.from({ length: 9 }, (_, i) => ({
        text: `Skipped PYZ-${50 + i}: the certificates need the owner's VPN`,
        task: `PYZ-${50 + i}`,
      })),
      waiting: [],
      decisions: 23,
    },
    lastTick: iso(4),
  };
}

function decisions(): OwnerDecision[] {
  const ship = (id: string, task: string, org: string, title: string, why: string): OwnerDecision => ({
    id: `room:${task}:1`,
    kind: "ship",
    org,
    task,
    taskTitle: title,
    title: `Ready to ship. ${title}`,
    options: [
      { id: "merge", label: "Merge", primary: true },
      { id: "mergePush", label: "Merge and push" },
    ],
    suggestion: { option: "merge", reason: why, by: "captain" },
    at: iso(40),
    link: { kind: "task", id: task },
  });
  const review = (task: string, org: string, title: string): OwnerDecision => ({
    id: `room:${task}:2`,
    kind: "approval",
    org,
    task,
    taskTitle: title,
    title: `${title} is ready for review`,
    options: [],
    at: iso(90),
    link: { kind: "task", id: task },
  });
  return [
    ship("a", "PYZ-505", "pyzasoft", "Shop orders created twice", "Checks pass and the diff is small"),
    ship("b", "PRV-14", "private", "Move the notes export to the queued worker", "Merges cleanly into main"),
    review("GOA-88", "goama", "Add rate limits to the public search endpoint"),
    review("IDZ-12", "ideeza", LONG_TASK),
    review("PYZ-430", "pyzasoft", "Phase 7: Resilience"),
  ];
}

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

/** A long chat: messages, with a turn of 40 tool calls and approvals in the middle. */
function conversation(chat: string): RoomItem[] {
  const out: RoomItem[] = [];
  let seq = 1;
  const base = (id: string, minutesAgo: number) => ({ id, task: chat, seq: seq++, at: iso(minutesAgo) });
  out.push({
    ...base("o1", 120),
    type: "owner",
    text: "Why only small tasks yesterday? Take the export rework too.",
    attachments: [],
    queued: false,
  } as RoomItem);
  for (let n = 0; n < 40; n++) {
    out.push({
      ...base(`t${n}`, 110 - n),
      type: "tool",
      agent: "setup",
      toolCallId: `call${n}`,
      title:
        n % 3 === 0
          ? "Read apps/server/src/export/worker.ts"
          : n % 3 === 1
            ? "grep -rn queueExport"
            : "cd /Users/owner/Work/shop && git log",
      kind: n % 3 === 0 ? "read" : n % 3 === 1 ? "search" : "execute",
      status: "completed",
      locations: [],
      content: [],
    } as RoomItem);
    if (n % 5 === 0)
      out.push({
        ...base(`p${n}`, 110 - n),
        type: "permission",
        agent: "setup",
        title: "cd /Users/owner/Work/shop && git log",
        options: [],
        state: "auto",
        chosen: "Allowed by rule",
      } as RoomItem);
  }
  out.push({
    ...base("a1", 60),
    type: "agent",
    agent: "setup",
    text: "Yesterday the export rework was rated large, so I left it. **PYZ-432** is running now, and the export rework comes after it. Two ship questions wait for you in Decisions.",
  } as RoomItem);
  out.push({
    ...base("o2", 40),
    type: "owner",
    text: "Fine. Keep Pyzasoft under its budget today.",
    attachments: [],
    queued: false,
  } as RoomItem);
  out.push({
    ...base("a2", 38),
    type: "agent",
    agent: "setup",
    text: "Pyzasoft is over its $50 for today, so I stopped starting work there. I will pick it up tomorrow.",
  } as RoomItem);
  return out;
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
const taskRow = (id: string, title: string, org?: string) => ({
  id,
  title,
  kind: "code",
  status: "running",
  team: ["setup"],
  mode: "lead",
  updatedAt: iso(30),
  repos: [],
  working: [],
  links: [],
  waitingOn: [],
  ...(org === undefined ? {} : { org }),
});
const CHATS = [
  chat("LOCAL-12", "Chat", "setup", 3),
  chat("LOCAL-16", "Private", "setup", 4),
  chat("PYZ-2", "Pyzasoft", "setup", 6, "pyzasoft"),
];

async function stub(page: Page, s: Scenario, state: { decisions: OwnerDecision[] }) {
  const answer = (name: string, json: () => unknown) =>
    page.route(`**/api/cmd/${name}`, (r) => r.fulfill({ json: json() }));
  await answer("captain.status", () => captain(s));
  await answer("captain.log", () => ({ actions: ACTIONS, runs: [] }));
  await answer("captain.asks", () => ({ asks: [], budgets: [] }));
  await answer("autonomy.status", () => autonomy(s));
  await answer("autonomy.events", () => ({ events: events().slice(0, 50) }));
  await answer("decisions.list", () => ({ decisions: state.decisions }));
  await answer("tasks.list", () => [
    ...CHATS,
    ...Object.entries(TITLES).map(([id, title]) => taskRow(id, title)),
  ]);
  await answer("boss.chat", () => ({ ...thread, id: "LOCAL-40", title: "Captain chat", team: ["setup"] }));
  await answer("tasks.get", () => thread);
  await answer("room.items", () => ({ items: conversation("LOCAL-31").reverse(), more: false }));
  await page.route("**/api/cmd/decisions.answer", async (r) => {
    const id = (r.request().postDataJSON() as { id?: string } | null)?.id;
    state.decisions = state.decisions.filter((d) => d.id !== id);
    await r.fulfill({ json: { decisions: state.decisions } });
  });
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

async function open(page: Page, path: string, w: number, h: number, theme: string, s: Scenario) {
  await page.setViewportSize({ width: w, height: h });
  await stub(page, s, { decisions: decisions() });
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

const REAL_ON: Scenario = { set: "real", mode: "on" };
const REAL_OFF: Scenario = { set: "real", mode: "off" };
const MANY_ON: Scenario = { set: "many", mode: "on" };

for (const [w, h] of [
  [1440, 900],
  [1100, 760],
] as const) {
  for (const theme of ["dark", "light"]) {
    test(`on ${w} ${theme}`, async ({ page }) => {
      await open(page, "/captain", w, h, theme, REAL_ON);
      await expect(page.getByRole("region", { name: "Needs you" })).toBeVisible();
      await expect(page.getByText("On: 2 running, 3 next. 5 decisions wait for you.")).toBeVisible();
      await expect(page.getByRole("tab")).toHaveCount(0);
      await page.screenshot({ path: `${SHOTS}/on-${w}-${theme}.png` });
      await noPageScroll(page);
    });
    test(`off ${w} ${theme}`, async ({ page }) => {
      await open(page, "/captain", w, h, theme, REAL_OFF);
      await expect(
        page.getByText(/^Off: it only answers when you ask, and keeps memory and cleanup going\./),
      ).toBeVisible();
      await page.screenshot({ path: `${SHOTS}/off-${w}-${theme}.png` });
      await noPageScroll(page);
    });
    test(`many workspaces ${w} ${theme}`, async ({ page }) => {
      await open(page, "/captain", w, h, theme, MANY_ON);
      await page.getByRole("button", { name: LONG }).first().click();
      await page.waitForTimeout(500);
      await page.screenshot({ path: `${SHOTS}/many-${w}-${theme}.png` });
      await noPageScroll(page);
    });
    test(`workspace thread ${w} ${theme}`, async ({ page }) => {
      await open(page, "/captain", w, h, theme, REAL_ON);
      await page
        .getByRole("button", { name: /^Private/ })
        .first()
        .click();
      await page.waitForTimeout(600);
      await page.screenshot({ path: `${SHOTS}/thread-${w}-${theme}.png` });
      await noPageScroll(page);
    });
    test(`delegation ${w} ${theme}`, async ({ page }) => {
      await open(page, "/captain", w, h, theme, REAL_ON);
      await page.getByRole("button", { name: "Delegation" }).click();
      await expect(page.getByRole("dialog", { name: "Delegation" })).toBeVisible();
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${SHOTS}/delegation-${w}-${theme}.png` });
    });
    test(`delegation with six workspaces ${w} ${theme}`, async ({ page }) => {
      await open(page, "/captain?tab=rules", w, h, theme, MANY_ON);
      await expect(page.getByRole("dialog", { name: "Delegation" })).toBeVisible();
      await page.getByRole("button", { name: /^Standing instructions/ }).click();
      await page.getByRole("button", { name: /^Leave alone/ }).click();
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${SHOTS}/delegation-many-${w}-${theme}.png` });
    });
    test(`log sheet ${w} ${theme}`, async ({ page }) => {
      await open(page, "/captain", w, h, theme, REAL_ON);
      await page.getByRole("button", { name: "See all" }).click();
      await expect(page.getByRole("dialog", { name: "Log" })).toBeVisible();
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${SHOTS}/log-${w}-${theme}.png` });
    });
    test(`summary sheet ${w} ${theme}`, async ({ page }) => {
      await open(page, "/captain", w, h, theme, REAL_ON);
      await page.getByRole("button", { name: /^Yesterday: shipped 30/ }).click();
      await expect(page.getByRole("dialog", { name: "Daily summary" })).toBeVisible();
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${SHOTS}/summary-${w}-${theme}.png` });
    });
  }
}

test("the header says what is true, and the summary is one line", async ({ page }) => {
  await open(page, "/captain", 1440, 900, "dark", REAL_ON);
  await expect(
    page.getByRole("button", { name: /^Yesterday: shipped 30, spent \$80\.56 of \$50 \(over\), 9 notes/ }),
  ).toBeVisible();
  await expect(page.locator("#main").getByRole("switch", { name: "Autonomous" })).toBeChecked();
  const header = page.locator("header").first();
  await expect(header.getByText("Pyzasoft")).toBeVisible();
});

test("Needs you shows two whole rows and links to the rest, answered inline", async ({ page }) => {
  await open(page, "/captain", 1440, 900, "dark", REAL_ON);
  const box = page.getByRole("region", { name: "Needs you" });
  await expect(box.locator("[data-decision]")).toHaveCount(2);
  await expect(box.getByRole("link", { name: "All 5 in Decisions" })).toBeVisible();
  await box.locator("[data-decision]").first().getByRole("button", { name: "Merge", exact: true }).click();
  await expect(box.locator("[data-decision]")).toHaveCount(2);
  await expect(page.getByText("4 decisions wait for you.")).toBeVisible();
});

test("the turn with 40 tool calls folds into one line", async ({ page }) => {
  await open(page, "/captain", 1440, 900, "dark", REAL_ON);
  const steps = page.getByRole("button", { name: /steps it took/ });
  await expect(steps).toHaveCount(1);
  await expect(steps).toHaveText(/40 steps it took/);
  await expect(page.getByText("Allowed by rule")).toHaveCount(0);
  await steps.click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/steps-open-1440-dark.png` });
});

test("the log has no ids and no old wording", async ({ page }) => {
  await open(page, "/captain", 1440, 900, "dark", REAL_ON);
  const recent = page.getByRole("region", { name: "Did recently" });
  await expect(
    recent.getByText("Shipped 'Move the notes export to the queued worker' to main"),
  ).toBeVisible();
  await expect(recent.getByText("Paused 'Phase 7: Resilience'")).toBeVisible();
  await expect(recent.getByText("Started 'Resilience and health'")).toBeVisible();
  await expect(recent.getByText("Asked you to ship 'Shop orders created twice'")).toBeVisible();
  await expect(recent.getByText(/LOCAL-16|Decision: applied|\(owner\)/)).toHaveCount(0);
});

test("old ways in still land on the same screen", async ({ page }) => {
  await open(page, "/autonomous", 1440, 900, "dark", REAL_ON);
  await expect(page).toHaveURL(/\/captain$/);
  await page.goto("/autonomous?tab=rules");
  await expect(page).toHaveURL(/\/captain\?tab=rules$/);
  await expect(page.getByRole("dialog", { name: "Delegation" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/\/captain$/);
  await page.goto("/captain?tab=log");
  await expect(page.getByRole("dialog", { name: "Log" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.goto("/captain?tab=chat");
  await expect(page.getByRole("region", { name: "Conversation" })).toBeVisible();
});

test("the sidebar row and Cmd J open the conversation", async ({ page }) => {
  await open(page, "/", 1440, 900, "dark", REAL_ON);
  const nav = page.getByRole("navigation", { name: "Main" });
  await expect(nav.getByRole("switch", { name: "Autonomous" })).toBeVisible();
  await nav.getByRole("link", { name: "Captain", exact: true }).click();
  await expect(page).toHaveURL(/\/captain$/);
  await page.goto("/chats");
  await page.waitForTimeout(900);
  await page.keyboard.press("ControlOrMeta+j");
  const drawer = page.getByRole("complementary", { name: "Captain" });
  await expect(drawer.getByRole("button", { name: "All", exact: true })).toBeVisible();
  await expect(drawer.getByRole("button", { name: /^Private/ })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/drawer-1440-dark.png` });
});

test("the delegation grid toggles a cell and takes a budget", async ({ page }) => {
  await open(page, "/captain", 1440, 900, "dark", REAL_ON);
  await page.route("**/api/cmd/autonomy.configure", (r) => r.fulfill({ json: autonomy(REAL_ON) }));
  await page.getByRole("button", { name: "Delegation" }).click();
  const sheet = page.getByRole("dialog", { name: "Delegation" });
  const posted = page.waitForRequest("**/api/cmd/autonomy.configure");
  await sheet.getByRole("button", { name: /^Push in Private/ }).click();
  expect((await posted).postDataJSON()).toMatchObject({
    orgs: { private: { authority: { push: "decide" } } },
  });
  const budget = sheet.getByRole("textbox", { name: "Daily budget of Goama in dollars" });
  await expect(budget).toHaveAttribute("placeholder", "shared");
  const saved = page.waitForRequest("**/api/cmd/autonomy.configure");
  await budget.fill("25");
  await budget.blur();
  expect((await saved).postDataJSON()).toMatchObject({ orgs: { goama: { cap: { cost: 25 } } } });
});

test("the Now column scrolls as one panel down to Did recently", async ({ page }) => {
  for (const [w, h] of [
    [1100, 760],
    [1280, 720],
  ] as const) {
    await open(page, "/captain", w, h, "dark", REAL_ON);
    const panel = page.getByLabel("Now", { exact: true });
    const recent = page.getByRole("region", { name: "Did recently" });
    await panel.evaluate((el) => el.scrollTo(0, el.scrollHeight));
    await expect(recent.locator("li").last()).toBeInViewport();
    await recent.getByRole("heading", { name: "Did recently" }).scrollIntoViewIfNeeded();
    await expect(recent.getByRole("heading", { name: "Did recently" })).toBeInViewport();
    await page.screenshot({ path: `${SHOTS}/now-scrolled-${w}-dark.png` });
    await noPageScroll(page);
  }
});
