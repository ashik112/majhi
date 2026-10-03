import { expect, type Page, test } from "@playwright/test";
import type {
  AutonomyEvent,
  AutonomyStatus,
  RoomItem,
  RoomServerMessage,
  Task,
  TaskSummary,
} from "../packages/shared/src/index.ts";

/**
 * The Autonomous page: the status bar, Now and next with each why, the log, the Rules view, the
 * daily summary and the captain chat on the right. The server is the seeded one (`ui`, captain `setup`);
 * autonomous mode, its chat and its room are stubbed in the browser.
 *
 * Screenshots go to SHOTS. Run: `pnpm exec playwright test -c playwright.autonomy.config.ts`.
 */
const SHOTS = process.env.SHOTS ?? "/private/tmp/claude-501/auto-shots";
const NOW = Date.now();
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
const CHAT = "LOCAL-12";

const LONG =
  "Move every caller of the old synchronous export to the queued worker, with retries, progress events and a signed download link that expires after a day";

function status(mode: AutonomyStatus["mode"], extra: Partial<AutonomyStatus> = {}): AutonomyStatus {
  const busy = mode === "on";
  return {
    mode,
    stopped: [],
    ...(mode === "off" ? {} : { since: iso(95), by: "owner" as const }),
    boss: {
      id: "setup",
      chat: CHAT,
      working: busy,
      ...(busy ? { nowDoing: "Reading the Globex backlog to plan the next start" } : {}),
    },
    lanes: [
      {
        org: "globex",
        name: "Globex",
        chat: CHAT,
        working: busy,
        ...(busy ? { nowDoing: "Reading the Globex backlog to plan the next start" } : {}),
        spend: { used: { tokens: 3_000_000, cost: 5.2 }, cap: { cost: 10 }, percent: 52, reached: false },
        tasks: busy ? 1 : 0,
        backlog: 3,
      },
      {
        org: "acme",
        name: "Acme",
        working: false,
        spend: { used: { tokens: 1_200_000, cost: 2.22 }, percent: 0, reached: false },
        tasks: busy ? 1 : 0,
        backlog: 1,
      },
    ],
    now: busy
      ? [
          {
            task: "GLX-430",
            title: LONG,
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
            why: "Small and blocks the Acme release; Acme lets autonomous mode push",
          },
        ]
      : [],
    queue: busy
      ? [
          {
            title: "Signed download links for finished exports",
            task: "GLX-432",
            org: "globex",
            why: "Next child of the export work; it waits on nothing and the Globex account has 60% of its window left",
          },
          {
            title: LONG,
            task: "GLX-431",
            org: "globex",
            why: "Large, so it goes after the small ones; split into three steps once GLX-430 merges",
            after: new Date(NOW + 90 * 60_000).toISOString(),
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
            why: "Small, cheap model, can run while the Acme cap has room",
          },
          {
            title: "Check the Northwind backlog for anything due this week",
            why: "Nothing planned there yet",
          },
        ]
      : [],
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
        title: LONG,
        org: "globex",
        status: "inbox",
        size: "large",
        sizeNote: "Laya rated it large (0.37)",
        noAutonomy: false,
      },
      {
        task: "GLX-437",
        title: "Document the export API for partners",
        org: "globex",
        status: "inbox",
        priority: "low",
        size: "medium",
        sizeNote: "Laya rated it medium (0.55)",
        noAutonomy: false,
      },
      {
        task: "ACM-91",
        title: "Tidy the Acme README and the setup script",
        org: "acme",
        status: "inbox",
        size: "small",
        sizeNote: "Laya rated it small (0.92)",
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
        leftOut: "Marked Not for autonomous mode",
      },
      {
        task: "NW-14",
        title: "Rotate the staging certificates",
        org: "northwind",
        status: "ready",
        sizeNote: "Not rated yet",
        noAutonomy: false,
        leftOut: "Northwind is set to Only when I ask",
      },
    ],
    holds: [],
    spend: {
      day: "2026-10-02",
      tz: "Europe/Berlin",
      resetsAt: new Date(NOW + 6 * 3600_000).toISOString(),
      total: {
        used: { tokens: 4_200_000, cost: busy ? 7.42 : 3.1 },
        cap: { cost: 20 },
        percent: 37,
        reached: false,
      },
      orgs: [
        {
          org: "globex",
          used: { tokens: 3_000_000, cost: 5.2 },
          cap: { cost: 10 },
          percent: 52,
          reached: false,
        },
        { org: "acme", used: { tokens: 1_200_000, cost: 2.22 }, percent: 0, reached: false },
      ],
    },
    accounts: [
      {
        id: "claude-globex",
        org: "globex",
        tool: "claude",
        window: { usedPct: 41, resetsAt: new Date(NOW + 2 * 3600_000).toISOString() },
        weekly: { usedPct: 63 },
      },
      { id: "claude-acme", org: "acme", tool: "claude", window: { usedPct: 12 }, weekly: { usedPct: 30 } },
    ],
    waiting: busy
      ? [
          {
            task: "ACM-88",
            item: "approval:1",
            kind: "approval",
            text: "Push task/ACM-88-rate-limits to origin and open a merge request",
            why: "Acme does not let autonomous mode merge",
          },
        ]
      : [],
    settings: {
      day: { cost: 20 },
      orgs: { globex: { cap: { cost: 10 }, push: true, merge: false }, acme: { push: true, merge: false } },
      floors: { window: 10, weekly: 5 },
      summary_at: "08:00",
      instructions: [
        {
          id: "abcd1234",
          text: "Be careful in the Globex billing code; no product-specific fixes.",
          at: iso(3000),
        },
      ],
      pick: { size: "any" },
    },
    summary: {
      day: "2026-10-01",
      from: iso(1500),
      to: iso(60),
      at: iso(55),
      shipped: [
        { task: "GLX-420", title: "Cache the board thumbnails", org: "globex", how: "mr-open" },
        { task: "ACM-80", title: "Fix the login redirect loop", org: "acme", how: "merged" },
      ],
      spent: {
        total: { used: { tokens: 9_000_000, cost: 14.1 }, cap: { cost: 20 }, percent: 70, reached: false },
        orgs: [],
      },
      unsure: [{ text: "Skipped NW-14: the certificates need the owner's VPN", task: "NW-14" }],
      waiting: [],
      decisions: 23,
    },
    lastTick: iso(4),
    ...extra,
  };
}

const EVENTS: AutonomyEvent[] = Array.from({ length: 40 }, (_, i) => {
  const kinds: AutonomyEvent[] = [
    {
      seq: 0,
      at: "",
      kind: "decision",
      text: "Start a task GLX-430",
      reason: "High priority and due tomorrow; the export times out for three customers",
      task: "GLX-430",
      outcome: "applied",
    },
    {
      seq: 0,
      at: "",
      kind: "tick",
      text: "Woke the captain: GLX-429 is done: Queue the export job (and 2 more)",
    },
    {
      seq: 0,
      at: "",
      kind: "approval",
      text: "Left for the owner: Push task/ACM-88-rate-limits. Acme does not let autonomous mode merge",
      task: "ACM-88",
      outcome: "left",
    },
    {
      seq: 0,
      at: "",
      kind: "task",
      text: "ACM-88 is ready for review: Add rate limits",
      task: "ACM-88",
      status: "review",
    },
    {
      seq: 0,
      at: "",
      kind: "refused",
      text: "Start a task GLX-431: GLX-431 was not started: it is large, and the size rule is Up to medium",
      task: "GLX-431",
      outcome: "refused",
      reason: "It is next in the queue",
    },
  ];
  const base = kinds[i % kinds.length] as AutonomyEvent;
  return { ...base, seq: 100 - i, at: iso(i * 7 + 1) };
});

const chatTask: Task = {
  id: CHAT,
  title: "Autonomous mode",
  brief: "Autonomous mode",
  kind: "chat",
  status: "running",
  folder: "/Users/owner/.majhi/tasks/LOCAL-12",
  repos: [],
  team: ["setup"],
  mode: "lead",
  overrides: {},
  links: [],
  attachments: [],
  createdAt: iso(5000),
  updatedAt: iso(1),
};

const item = (n: number, rest: Record<string, unknown>): RoomItem =>
  ({ id: `i${n}`, task: CHAT, seq: n, at: iso(200 - n * 4), ...rest }) as RoomItem;

function conversation(): RoomItem[] {
  const out: RoomItem[] = [];
  for (let n = 1; n <= 12; n++) {
    out.push(item(n * 3, { type: "system", level: "info", text: `Woke the captain: check ${n}` }));
    out.push(
      item(n * 3 + 1, {
        type: "agent",
        agent: "setup",
        text: `Plan ${n}: GLX-430 runs with the builder on the balanced model. Next is **GLX-432**, then the docs. ACM-88 waits for your push approval, so I left it. Spend is $${(n * 0.6).toFixed(2)} of $20.00.`,
      }),
    );
    if (n % 4 === 0)
      out.push(
        item(n * 3 + 2, {
          type: "owner",
          text: "Why only small tasks yesterday? Take the export rework too.",
          attachments: [],
          queued: false,
        }),
      );
  }
  return out;
}

const summaries = (list: TaskSummary[]) => list;
const CHAT_SUMMARY: TaskSummary = {
  id: CHAT,
  title: "Autonomous mode",
  kind: "chat",
  status: "running",
  team: ["setup"],
  mode: "lead",
  updatedAt: iso(1),
  repos: [],
  working: [],
  links: [],
  waitingOn: [],
  chat: true,
};

interface Scene {
  status: AutonomyStatus;
}

async function stub(page: Page, scene: Scene): Promise<{ calls: { name: string; body: unknown }[] }> {
  const calls: { name: string; body: unknown }[] = [];
  const answer = (name: string, json: unknown) =>
    page.route(`**/api/cmd/${name}`, (r) => {
      calls.push({ name, body: r.request().postDataJSON() });
      return r.fulfill({ json: typeof json === "function" ? (json as () => unknown)() : json });
    });
  await answer("autonomy.status", () => scene.status);
  await page.route("**/api/cmd/autonomy.events", (r) => {
    const body = r.request().postDataJSON() as { decisions?: boolean };
    const list = body.decisions
      ? EVENTS.filter((e) => ["decision", "approval", "refused"].includes(e.kind))
      : EVENTS;
    return r.fulfill({ json: { events: list } });
  });
  await answer("tasks.get", chatTask);
  await answer("tasks.list", summaries([CHAT_SUMMARY]));
  await answer("autonomy.guide", { chat: CHAT });
  await page.route("**/api/cmd/autonomy.configure", (r) => {
    const body = r.request().postDataJSON() as { pick?: { size?: "small" | "medium" | "any" } };
    calls.push({ name: "autonomy.configure", body });
    const pick = { ...scene.status.settings.pick, ...(body.pick?.size ? { size: body.pick.size } : {}) };
    scene.status = { ...scene.status, settings: { ...scene.status.settings, pick } };
    return r.fulfill({ json: scene.status });
  });
  await page.route("**/api/cmd/autonomy.stop", (r) => {
    calls.push({ name: "autonomy.stop", body: r.request().postDataJSON() });
    scene.status = status("off");
    return r.fulfill({ json: scene.status });
  });
  await page.route("**/api/cmd/autonomy.start", (r) => {
    calls.push({ name: "autonomy.start", body: null });
    scene.status = status("on");
    return r.fulfill({ json: scene.status });
  });
  await page.routeWebSocket(/\/api\/tasks\/([^/]+)\/room$/, (ws) => {
    const snapshot: RoomServerMessage = {
      type: "snapshot",
      more: false,
      processes: [],
      agents: [
        {
          agent: "setup",
          status: scene.status.mode === "on" ? "working" : "idle",
          queued: 0,
          commands: [],
        },
      ],
      items: conversation(),
    } as RoomServerMessage;
    ws.send(JSON.stringify(snapshot));
  });
  return { calls };
}

async function open(page: Page, w: number, h: number, theme: string, scene: Scene) {
  await page.setViewportSize({ width: w, height: h });
  const stubbed = await stub(page, scene);
  await page.goto("/autonomous");
  await page.evaluate((t) => {
    document.documentElement.dataset.theme = t;
  }, theme);
  await expect(page.getByRole("complementary", { name: "Captain chat" })).toBeVisible();
  await page.waitForTimeout(600);
  return stubbed;
}

async function noPageScroll(page: Page) {
  const overflow = await page.evaluate(() => ({
    x: document.documentElement.scrollWidth - window.innerWidth,
    y: document.documentElement.scrollHeight - window.innerHeight,
  }));
  expect(overflow).toEqual({ x: 0, y: 0 });
}

const STATES: Record<string, () => AutonomyStatus> = {
  on: () => status("on"),
  paused: () => status("paused"),
  off: () => status("off", { summary: undefined }),
};

for (const [name, make] of Object.entries(STATES)) {
  for (const [w, h] of [
    [1440, 900],
    [1100, 700],
  ] as const) {
    for (const theme of ["dark", "light"]) {
      test(`autonomous ${name} ${w} ${theme}`, async ({ page }) => {
        await open(page, w, h, theme, { status: make() });
        await page.screenshot({ path: `${SHOTS}/${name}-${w}-${theme}.png` });
        await noPageScroll(page);
      });
    }
  }
}

for (const [w, h] of [
  [1440, 900],
  [1100, 700],
] as const) {
  for (const theme of ["dark", "light"]) {
    test(`autonomous rules ${w} ${theme}`, async ({ page }) => {
      await open(page, w, h, theme, { status: status("on") });
      await page.getByRole("group", { name: "View" }).getByRole("button", { name: "Rules" }).click();
      await expect(page.getByRole("region", { name: "What it may pick" })).toBeVisible();
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${SHOTS}/rules-${w}-${theme}.png` });
      await noPageScroll(page);
    });
    test(`autonomous summary ${w} ${theme}`, async ({ page }) => {
      await open(page, w, h, theme, { status: status("on") });
      await page.getByRole("group", { name: "View" }).getByRole("button", { name: "Summary" }).click();
      await expect(page.getByRole("region", { name: "Daily summary" })).toBeVisible();
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${SHOTS}/summary-${w}-${theme}.png` });
      await noPageScroll(page);
    });
  }
}

test("the chat sends through autonomy.guide, kept as an instruction", async ({ page }) => {
  const { calls } = await open(page, 1440, 900, "dark", { status: status("on") });
  const chat = page.getByRole("complementary", { name: "Captain chat" });
  await expect(chat.getByText("Why only small tasks yesterday?").first()).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/chat-long-1440.png` });
  await chat.getByRole("textbox", { name: "Message to the captain" }).fill("Take GLX-431 next, split it.");
  await chat.getByRole("switch", { name: "Keep as standing instruction" }).click();
  await chat.getByRole("button", { name: "Send" }).click();
  await expect
    .poll(() => calls.find((c) => c.name === "autonomy.guide")?.body)
    .toEqual({
      text: "Take GLX-431 next, split it.",
      keep: true,
      org: "globex",
    });
  await expect(chat.getByRole("textbox", { name: "Message to the captain" })).toHaveValue("");
  await noPageScroll(page);
});

test("Rules saves the size rule", async ({ page }) => {
  const { calls } = await open(page, 1440, 900, "dark", { status: status("on") });
  await page.getByRole("group", { name: "View" }).getByRole("button", { name: "Rules" }).click();
  const card = page.getByRole("region", { name: "What it may pick" });
  await card.getByRole("button", { name: "Small only" }).click();
  await card.getByRole("button", { name: "Save" }).click();
  await expect
    .poll(() => calls.find((c) => c.name === "autonomy.configure")?.body)
    .toEqual({
      pick: { size: "small" },
    });
  await expect(card.getByRole("button", { name: "Save" })).toBeHidden();
  await expect(card.getByRole("button", { name: "Small only" })).toHaveAttribute("aria-pressed", "true");
});

test("turning Autonomous off offers pausing its tasks or letting them finish", async ({ page }) => {
  const { calls } = await open(page, 1440, 900, "dark", { status: status("on") });
  await page.getByRole("switch", { name: "Autonomous" }).first().click();
  await expect(page.getByRole("heading", { name: "Turn Autonomous off?" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Turn off and pause its tasks" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit budgets" })).toBeVisible();
  await page.getByRole("button", { name: "Turn off and pause its tasks" }).click();
  await expect.poll(() => calls.find((c) => c.name === "autonomy.stop")?.body).toEqual({ how: "now" });
});
