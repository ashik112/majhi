import { expect, type Page, test } from "@playwright/test";
import type {
  AgentLive,
  ProcessInfo,
  RoomItem,
  RoomServerMessage,
  Task,
  TaskReceipt,
  TaskSummary,
} from "../packages/shared/src/index.ts";

/**
 * The board's priority and due chips, the task header's priority and due control, the compact
 * Processes card and the Context tab. The server is the seeded one (`ui`); the task list, the task,
 * its room, its receipt and TASK.md are stubbed in the browser, and `tasks.update` changes the
 * stubbed tasks so a save shows on the board.
 *
 * Screenshots go to SHOTS. Run: `pnpm exec playwright test -c playwright.taskpage.config.ts`.
 */
const SHOTS = process.env.SHOTS ?? "/private/tmp/claude-501/taskpage-shots";
const NOW = Date.now();
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
const day = (offset: number) => {
  const d = new Date(NOW);
  d.setDate(d.getDate() + offset);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const TEAM = ["globex-lead", "globex-builder", "globex-reviewer"];
const FOLDER = "/Users/owner/.majhi/tasks/GLX-418";

const LONG =
  "Move every caller of the old synchronous export to the queued worker, with retries, progress events and a signed download link that expires after a day";

const summary = (
  id: string,
  title: string,
  status: TaskSummary["status"],
  extra: Partial<TaskSummary> = {},
): TaskSummary => ({
  id,
  title,
  kind: "code",
  org: id.startsWith("ACM") ? "acme" : id.startsWith("NW") ? "northwind" : "globex",
  status,
  team: ["globex-lead"],
  mode: "lead",
  updatedAt: iso(42),
  repos: [{ project: "alpha-api", branch: `task/${id}` }],
  working: [],
  links: [],
  waitingOn: [],
  ...extra,
});

function boardTasks(): TaskSummary[] {
  return [
    summary("GLX-418", "Schematic export times out on large boards", "running", {
      priority: "high",
      due: day(-2),
      working: ["globex-lead"],
      team: TEAM,
      updatedAt: iso(3),
    }),
    summary("GLX-421", LONG, "inbox", { priority: "high", due: day(0), updatedAt: iso(60 * 5) }),
    summary("GLX-422", "Rename the billing webhook handler", "inbox", {
      priority: "low",
      due: day(1),
      updatedAt: iso(60 * 26),
    }),
    summary("GLX-423", "Signed download links", "ready", { updatedAt: iso(60 * 24 * 3) }),
    summary("GLX-424", "Retry failed exports with backoff", "review", {
      due: day(9),
      updatedAt: iso(12),
    }),
    summary("GLX-425", `${LONG} and a second long sentence about the export queue`, "running", {
      working: ["globex-builder"],
      links: [{ type: "parent", task: "GLX-418" }],
      updatedAt: iso(1),
    }),
    summary("ACM-12", "Audit log export for the admin console", "running", {
      priority: "low",
      working: ["globex-lead"],
      updatedAt: iso(30),
    }),
    summary("NW-7", "Northwind warehouse sync drops rows on retry", "paused", {
      priority: "high",
      pausedReason: "limit",
      due: day(-1),
      updatedAt: iso(60 * 3),
    }),
    summary("GLX-426", "Progress events over the socket", "mr", { due: day(4), updatedAt: iso(60 * 24 * 9) }),
  ];
}

function fullTask(list: TaskSummary[]): Task {
  const me = list.find((t) => t.id === "GLX-418");
  return {
    id: "GLX-418",
    title: "Schematic export times out on large boards",
    brief: "Schematic export times out on large boards\n\nBoards over 40 MB time out after 30 seconds.",
    kind: "code",
    org: "globex",
    status: "running",
    ...(me?.priority ? { priority: me.priority } : {}),
    ...(me?.due ? { due: me.due } : {}),
    folder: FOLDER,
    mode: "lead",
    overrides: {},
    repos: [
      {
        project: "alpha-api",
        source: "/Users/owner/Work/alpha-api",
        base: "develop",
        branch: "task/GLX-418-export",
        worktree: `${FOLDER}/alpha-api`,
        createdBranch: true,
      },
    ],
    team: TEAM,
    links: [],
    attachments: [
      {
        id: "a1",
        kind: "link",
        name: "Export spec",
        url: "https://docs.acme.example/export",
      },
    ],
    createdAt: iso(600),
    updatedAt: me?.updatedAt ?? iso(1),
  } as Task;
}

const live = (agent: string, used: number, extra: Partial<AgentLive> = {}): AgentLive => ({
  agent,
  status: "idle",
  queued: 0,
  usage: { used, size: 200_000 },
  model: "opus-5.5",
  commands: [{ name: "compact" }, { name: "review" }],
  turns: 6,
  ...extra,
});

const AGENTS: AgentLive[] = [
  live("globex-lead", 171_000, { status: "working", nowDoing: "Editing src/export/job.ts", turns: 14 }),
  live("globex-builder", 96_000, { model: "sonnet-5.5" }),
  live("globex-reviewer", 18_000, { model: "haiku-4.5", turns: 2 }),
];

const item = (n: number, rest: Record<string, unknown>): RoomItem =>
  ({ id: `i${n}`, task: "GLX-418", seq: n, at: iso(120 - n), ...rest }) as RoomItem;

const ITEMS: RoomItem[] = [
  item(1, { type: "owner", text: "Find why the export times out.", attachments: [], queued: false }),
  item(2, {
    type: "tool",
    agent: "globex-lead",
    toolCallId: "r0",
    title: "Read src/old.ts",
    kind: "read",
    status: "completed",
    locations: [`${FOLDER}/alpha-api/src/old.ts`],
    content: [],
  }),
  item(3, {
    type: "context",
    agent: "globex-lead",
    method: "handoff",
    before: 168_000,
    after: 9_000,
    note: ".handoffs/globex-lead-1.md",
  }),
  ...["src/export/job.ts", "src/export/queue.ts", "src/routes/export.ts", "test/export.test.ts"].map((p, i) =>
    item(10 + i, {
      type: "tool",
      agent: "globex-lead",
      toolCallId: `r${i + 1}`,
      title: `Read ${p}`,
      kind: "read",
      status: "completed",
      locations: [`${FOLDER}/alpha-api/${p}`],
      content: [],
    }),
  ),
  item(20, {
    type: "tool",
    agent: "globex-builder",
    toolCallId: "b1",
    title: "Read package.json",
    kind: "read",
    status: "completed",
    locations: [`${FOLDER}/alpha-api/package.json`],
    content: [],
  }),
  item(21, {
    type: "agent",
    agent: "globex-lead",
    text: "The export runs in the request. Moving it to a worker.",
  }),
  item(22, {
    type: "context",
    agent: "globex-builder",
    method: "native",
    before: 164_000,
    after: 61_000,
  }),
];

const RECEIPT: TaskReceipt = {
  task: "GLX-418",
  title: "Schematic export times out on large boards",
  context: { briefTokens: 1840, memoryTokens: 320, recallTokens: 900, recalls: 2, estimated: true },
  totals: {
    turns: 48,
    inputTokens: 210_000,
    outputTokens: 64_000,
    reasoningTokens: 12_000,
    cacheReadTokens: 1_900_000,
    cacheWriteTokens: 240_000,
    totalTokens: 2_414_000,
    costUsd: 6.42,
    estimatedUsd: 0,
    unpricedTurns: 0,
  },
  cacheHitRate: 0.9,
  agents: [],
  compactions: [
    {
      at: iso(120 - 22),
      agent: "globex-builder",
      method: "native",
      reason: "native",
      before: 164_000,
      after: 61_000,
    },
    {
      at: iso(120 - 3),
      agent: "globex-lead",
      method: "handoff",
      reason: "handoff",
      before: 168_000,
      after: 9_000,
    },
    {
      at: iso(400),
      agent: "globex-reviewer",
      method: "handoff",
      reason: "fresh",
      before: 40_000,
      after: 3_000,
    },
    { at: iso(900), agent: "globex-lead", method: "handoff", reason: "rotation", before: null, after: 7_500 },
  ],
  decisions: { replaced: 1, total: 3 },
};

const TASK_MD = `# GLX-418 Schematic export times out on large boards

Boards over 40 MB time out after 30 seconds.

## Memory

- The export worker lives in \`alpha-api/src/export\`.
- Large boards are in the fixtures folder.

## Team

- @globex-lead leads, @globex-builder builds, @globex-reviewer reviews.
`;

const proc = (n: number, extra: Partial<ProcessInfo> = {}): ProcessInfo => ({
  id: `p${n}`,
  task: "GLX-418",
  agent: "globex-builder",
  name: `process ${n}`,
  command: `pnpm run job-${n}`,
  cwd: `${FOLDER}/alpha-api`,
  wait: true,
  status: "exited",
  exitCode: 0,
  startedAt: iso(30 + n),
  endedAt: iso(20 + n),
  tail: ["line one", "line two", "done"],
  ...extra,
});

const PROCS: ProcessInfo[] = [
  proc(1, {
    name: "pnpm dev",
    command: "pnpm --filter web dev",
    status: "running",
    wait: false,
    port: 5173,
    exitCode: undefined,
    endedAt: undefined,
  }),
  proc(2, { name: "vitest run src/export", exitCode: 1 }),
  proc(3, { name: "export worker", status: "running", wait: false, exitCode: undefined, endedAt: undefined }),
  proc(4, { name: "pnpm typecheck" }),
  proc(5, { name: "redis", status: "stopped", exitCode: null, stoppedBy: "owner" }),
  proc(6, { name: "seed fixtures", exitCode: 0 }),
];

interface Scene {
  list: TaskSummary[];
  updates: Record<string, unknown>[];
}

async function stub(page: Page, processes: ProcessInfo[] = []): Promise<Scene> {
  const scene: Scene = { list: boardTasks(), updates: [] };
  await page.route("**/api/tasks/GLX-418/files/**", (r) =>
    r.fulfill({ body: TASK_MD, contentType: "text/markdown" }),
  );
  await page.route("**/api/cmd/tasks.list", (r) => r.fulfill({ json: scene.list }));
  await page.route("**/api/cmd/tasks.get", (r) => r.fulfill({ json: fullTask(scene.list) }));
  await page.route("**/api/cmd/tasks.diff", (r) => r.fulfill({ json: [] }));
  await page.route("**/api/cmd/usage.receipt", (r) => r.fulfill({ json: RECEIPT }));
  await page.route("**/api/cmd/tasks.update", (r) => {
    const input = JSON.parse(r.request().postData() ?? "{}") as {
      id: string;
      priority?: "high" | "low" | null;
      due?: string | null;
    };
    scene.updates.push(input);
    scene.list = scene.list.map((t) => {
      if (t.id !== input.id) return t;
      const next: TaskSummary = { ...t, updatedAt: new Date().toISOString() };
      if (input.priority === null) delete next.priority;
      else if (input.priority !== undefined) next.priority = input.priority;
      if (input.due === null) delete next.due;
      else if (input.due !== undefined) next.due = input.due;
      return next;
    });
    return r.fulfill({ json: fullTask(scene.list) });
  });
  await page.routeWebSocket(/\/api\/tasks\/([^/]+)\/room$/, (ws) => {
    const snapshot: RoomServerMessage = {
      type: "snapshot",
      more: false,
      processes,
      agents: AGENTS,
      items: ITEMS,
    };
    ws.send(JSON.stringify(snapshot));
  });
  return scene;
}

async function theme(page: Page, name: string) {
  await page.evaluate((t) => {
    document.documentElement.dataset.theme = t;
  }, name);
}

async function noPageScroll(page: Page) {
  const overflow = await page.evaluate(() => ({
    x: document.documentElement.scrollWidth - window.innerWidth,
    y: document.documentElement.scrollHeight - window.innerHeight,
  }));
  expect(overflow).toEqual({ x: 0, y: 0 });
}

const SIZES = [
  { w: 1440, h: 900 },
  { w: 1100, h: 700 },
];
const THEMES = ["dark", "light"];

for (const { w, h } of SIZES) {
  for (const t of THEMES) {
    test(`board ${w} ${t}`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: h });
      await stub(page);
      await page.goto("/");
      await theme(page, t);
      await expect(page.locator("#card-GLX-418")).toBeVisible();
      await page.waitForTimeout(600);
      await page.screenshot({ path: `${SHOTS}/board-${w}-${t}.png` });
      // A card's menu, open.
      await page.locator("#card-GLX-421").hover();
      await page.getByRole("button", { name: "Menu of GLX-421" }).click();
      await expect(page.getByRole("menu", { name: "Menu of GLX-421" })).toBeVisible();
      await page.screenshot({ path: `${SHOTS}/board-menu-${w}-${t}.png` });
      await noPageScroll(page);
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Tree" }).click();
      await expect(page.getByRole("list", { name: "Tasks" })).toBeVisible();
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${SHOTS}/tree-${w}-${t}.png` });
    });

    test(`header ${w} ${t}`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: h });
      await stub(page);
      await page.goto("/t/GLX-418");
      await theme(page, t);
      await page.getByRole("button", { name: /^Priority and due date/ }).click();
      await expect(page.getByRole("dialog", { name: /Priority and due date/ })).toBeVisible();
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${SHOTS}/header-${w}-${t}.png` });
      await noPageScroll(page);
    });

    for (const [name, procs] of [
      ["0", []],
      ["2", PROCS.slice(0, 2)],
      ["6", PROCS],
    ] as const) {
      test(`room ${name} processes ${w} ${t}`, async ({ page }) => {
        await page.setViewportSize({ width: w, height: h });
        await stub(page, [...procs]);
        await page.goto("/t/GLX-418");
        await theme(page, t);
        await expect(page.getByRole("log", { name: "Room messages" })).toBeVisible();
        await page.waitForTimeout(600);
        await page.screenshot({ path: `${SHOTS}/room-${name}-${w}-${t}.png` });
        if (name === "6") {
          await page.getByRole("button", { name: /Processes/ }).click();
          await page.waitForTimeout(200);
          await page.screenshot({ path: `${SHOTS}/room-6-open-${w}-${t}.png` });
        }
        await noPageScroll(page);
      });
    }

    test(`context ${w} ${t}`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: h });
      await stub(page);
      await page.goto("/t/GLX-418");
      await theme(page, t);
      await page.getByRole("tab", { name: "Context" }).click();
      await expect(page.getByRole("list", { name: "Context of each agent" })).toBeVisible();
      await page.waitForTimeout(700);
      await page.screenshot({ path: `${SHOTS}/context-${w}-${t}.png` });
      await page.getByRole("button", { name: "Show TASK.md" }).click();
      await expect(page.getByRole("heading", { name: /GLX-418 Schematic export/ })).toBeVisible();
      await page.screenshot({ path: `${SHOTS}/context-taskmd-${w}-${t}.png` });
      await noPageScroll(page);
    });
  }
}

test("setting priority and due from the header shows on the board", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const scene = await stub(page);
  await page.goto("/t/GLX-418");
  await page.getByRole("button", { name: /^Priority and due date/ }).click();
  const panel = page.getByRole("dialog", { name: /Priority and due date/ });
  await panel.getByRole("button", { name: "Low" }).click();
  await expect.poll(() => scene.updates.at(-1)).toEqual({ id: "GLX-418", priority: "low" });
  await panel.getByRole("button", { name: "Tomorrow" }).click();
  await expect.poll(() => scene.updates.at(-1)).toEqual({ id: "GLX-418", due: day(1) });
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(page.getByRole("button", { name: /^Priority and due date/ })).toContainText("Due tomorrow");
  await page.getByRole("link", { name: "Back to board" }).click();
  const card = page.locator("#card-GLX-418");
  await expect(card).toContainText("Low");
  await expect(card).toContainText("Due tomorrow");
  await page.screenshot({ path: `${SHOTS}/click-header-saved.png` });
});

test("setting priority and due from the card menu shows on the board", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 700 });
  const scene = await stub(page);
  await page.goto("/");
  const card = page.locator("#card-GLX-423");
  await expect(card).not.toContainText("High");
  await card.hover();
  await page.getByRole("button", { name: "Menu of GLX-423" }).click();
  await page.getByRole("menuitemradio", { name: "High" }).click();
  await expect.poll(() => scene.updates.at(-1)).toEqual({ id: "GLX-423", priority: "high" });
  await expect(card).toContainText("High");
  await card.hover();
  await page.getByRole("button", { name: "Menu of GLX-423" }).click();
  await page.getByRole("menuitemradio", { name: /^Today/ }).click();
  await expect(card).toContainText("Due today");
  // Any other day, from the date field.
  await card.hover();
  await page.getByRole("button", { name: "Menu of GLX-423" }).click();
  await page.getByRole("menuitemradio", { name: "Pick a date" }).click();
  const field = page.getByRole("dialog", { name: /Priority and due date of GLX-423/ }).getByLabel("Due date");
  await expect(field).toBeFocused();
  await field.fill(day(-3));
  await expect(card).toContainText("Overdue 3 days");
  const picker = page.getByRole("dialog", { name: /Priority and due date of GLX-423/ });
  await expect(picker.getByRole("button", { name: "Today" })).toHaveAttribute("aria-pressed", "false");
  await page.screenshot({ path: `${SHOTS}/click-card-saved.png` });
  await page.keyboard.press("Escape");
  // Clear both again.
  await card.hover();
  await page.getByRole("button", { name: "Menu of GLX-423" }).click();
  await page.getByRole("menuitemradio", { name: "Normal" }).click();
  await card.hover();
  await page.getByRole("button", { name: "Menu of GLX-423" }).click();
  await page.getByRole("menuitemradio", { name: "No due date" }).click();
  await expect(card).not.toContainText("High");
  await expect(card).not.toContainText("Overdue");
});
