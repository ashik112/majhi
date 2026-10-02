import { expect, type Page, test, type WebSocketRoute } from "@playwright/test";
import type { RoomItem, RoomServerMessage, Task, TaskSummary } from "../packages/shared/src/index.ts";

/**
 * The Subtasks card of a parent task, and menus that stay open while the room streams. The server
 * is the seeded one (`ui`); the task list, the task and its room are stubbed in the browser, and the
 * room socket is kept so the test can push items into it as an agent would.
 *
 * Screenshots go to SHOTS. Run: `pnpm exec playwright test -c playwright.subtasks.config.ts`.
 */
const SHOTS = "/private/tmp/claude-501/subtasks-shots";
const NOW = Date.now();
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
const GLX = ["globex-lead", "globex-builder", "globex-reviewer"];

const summary = (
  id: string,
  title: string,
  status: TaskSummary["status"],
  extra: Partial<TaskSummary> = {},
): TaskSummary => ({
  id,
  title,
  kind: "code",
  org: "globex",
  status,
  team: GLX,
  mode: "lead",
  updatedAt: iso(10),
  repos: [{ project: "alpha-api", branch: `task/${id}` }],
  working: [],
  links: [],
  waitingOn: [],
  ...extra,
});

const childOf = (parent: string) => ({ links: [{ type: "parent" as const, task: parent }] });
const LONG =
  "Move every caller of the old synchronous export to the queued worker, with retries, progress events and a signed download link that expires after a day";

const FOUR: TaskSummary[] = [
  summary("GLX-430", "Queue the export job in a worker", "running", {
    ...childOf("GLX-418"),
    working: ["globex-builder"],
  }),
  summary("GLX-431", LONG, "inbox", { ...childOf("GLX-418"), waitingOn: ["GLX-430"] }),
  summary("GLX-432", "Signed download links", "ready", childOf("GLX-418")),
  summary("GLX-433", "Progress events over the socket", "paused", {
    ...childOf("GLX-418"),
    pausedReason: "limit",
  }),
];

const MANY: TaskSummary[] = [
  ...FOUR,
  summary("GLX-434", "Retry failed exports with backoff", "review", childOf("GLX-418")),
  summary("GLX-435", "Expire old download links after a day", "done", childOf("GLX-418")),
  summary("GLX-436", "Export progress bar in the web app", "mr", childOf("GLX-418")),
  summary("GLX-437", "Load test the worker with a 40 MB board", "inbox", childOf("GLX-418")),
  summary("GLX-438", "Document the export API", "running", childOf("GLX-418")),
  summary("GLX-439", "Remove the request-time export path", "inbox", {
    ...childOf("GLX-418"),
    waitingOn: ["GLX-430", "GLX-431", "GLX-432"],
  }),
  summary("GLX-440", "Alert when the export queue backs up", "ready", childOf("GLX-418")),
  summary("GLX-441", "Clean up temp files after each export", "done", childOf("GLX-418")),
];

function parent(
  children: TaskSummary[],
  waits: string[] = [],
  status: Task["status"] = "running",
): { full: Task; list: TaskSummary[] } {
  const links = waits.map((id) => ({ type: "depends-on" as const, task: id }));
  const done = children.filter((c) => c.status === "done").length;
  const full: Task = {
    id: "GLX-418",
    title: "Schematic export times out on large boards",
    brief: "x",
    kind: "code",
    org: "globex",
    status,
    folder: "/Users/owner/.majhi/tasks/GLX-418",
    mode: "lead",
    overrides: {},
    repos: [
      {
        project: "alpha-api",
        source: "/Users/owner/Work/alpha-api",
        base: "develop",
        branch: "task/GLX-418-export",
        worktree: "/Users/owner/.majhi/tasks/GLX-418/alpha-api",
        createdBranch: true,
      },
    ],
    team: ["globex-lead"],
    links,
    attachments: [],
    createdAt: iso(60),
    updatedAt: iso(1),
  } as Task;
  const others = waits.map((id) =>
    summary(id, `Upstream work ${id}`, "running", { working: ["globex-lead"] }),
  );
  const me = summary("GLX-418", full.title, status, {
    working: status === "running" ? ["globex-lead"] : [],
    links,
    waitingOn: waits,
    children: { total: children.length, done },
  });
  return { full, list: [me, ...children, ...others] };
}

const item = (n: number, rest: Record<string, unknown>): RoomItem =>
  ({ id: `i${n}`, task: "GLX-418", seq: n, at: iso(30 - n), ...rest }) as RoomItem;

const AGENT = {
  agent: "globex-lead",
  status: "working",
  nowDoing: "Editing src/export/job.ts",
  queued: 0,
  model: "opus-5.5",
  effort: "high",
  commands: [],
} as const;

const SNAPSHOT: RoomServerMessage = {
  type: "snapshot",
  more: false,
  processes: [],
  agents: [AGENT],
  items: [
    item(1, { type: "owner", text: "Split the export work into subtasks.", attachments: [], queued: false }),
    item(2, { type: "agent", agent: "globex-lead", text: "I split it into the subtasks on the right." }),
    item(3, { type: "agent", agent: "globex-lead", text: "The current flow:\n\n![flow chart](flow.png)" }),
  ],
};

/** A 1x1 PNG, for the room's image. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
const OK = { ok: true };

async function stub(
  page: Page,
  scene: { full: Task; list: TaskSummary[] },
): Promise<{ room: () => WebSocketRoute }> {
  let socket: WebSocketRoute | undefined;
  await page.route("**/api/tasks/GLX-418/files/**", (r) =>
    r.fulfill({ body: PNG, contentType: "image/png" }),
  );
  await page.route("**/api/cmd/tasks.shipOptions", (r) =>
    r.fulfill({
      json: {
        base: "develop",
        changed: [{ project: "alpha-api", base: "develop", branch: "task/GLX-418-export" }],
        unchanged: [],
        protected: [],
        merge: OK,
        mergePush: OK,
        push: OK,
        mr: OK,
        done: { ok: true, unshipped: [] },
      },
    }),
  );
  await page.route("**/api/cmd/tasks.list", (r) => r.fulfill({ json: scene.list }));
  await page.route("**/api/cmd/tasks.get", (r) => r.fulfill({ json: scene.full }));
  await page.route("**/api/cmd/tasks.diff", (r) => r.fulfill({ json: [] }));
  await page.route("**/api/cmd/accounts.models", (r) =>
    r.fulfill({
      json: {
        account: "claude-globex",
        models: [
          { id: "opus-5.5", name: "Opus 5.5" },
          { id: "sonnet-5", name: "Sonnet 5" },
        ],
        efforts: [
          { id: "low", name: "Low" },
          { id: "high", name: "High" },
        ],
        fetchedAt: iso(1),
      },
    }),
  );
  await page.routeWebSocket(/\/api\/tasks\/([^/]+)\/room$/, (ws) => {
    socket = ws;
    ws.send(JSON.stringify(SNAPSHOT));
  });
  return {
    room: () => {
      if (!socket) throw new Error("the room socket is not open");
      return socket;
    },
  };
}

/**
 * What a streaming turn sends: text that grows, tool calls, an agent status line, the task itself
 * (its `updatedAt` moves on), an image.
 */
async function stream(room: WebSocketRoute, page: Page, task: Task): Promise<void> {
  const send = (m: RoomServerMessage) => room.send(JSON.stringify(m));
  for (let n = 0; n < 6; n += 1) {
    send({ type: "task", task: { ...task, updatedAt: new Date(NOW + n * 1000).toISOString() } });
    const words = "The export now runs in a queued worker and the request returns a link. ".repeat(n + 1);
    send({ type: "item", item: item(20, { type: "agent", agent: "globex-lead", text: words }) });
    send({
      type: "item",
      item: item(30 + n, {
        type: "tool",
        agent: "globex-lead",
        toolCallId: `t${n}`,
        title: `Edit src/export/job-${n}.ts`,
        kind: "edit",
        status: "completed",
        locations: [],
        content: [],
      }),
    });
    send({ type: "agent", agent: { ...AGENT, nowDoing: `Editing src/export/job-${n}.ts` } });
    await page.waitForTimeout(120);
  }
  send({
    type: "item",
    item: item(40, {
      type: "agent",
      agent: "globex-lead",
      text: "Here is the new flow:\n\n![flow](https://example.invalid/flow.png)",
    }),
  });
  await page.waitForTimeout(300);
}

for (const [name, scene] of Object.entries({
  four: parent(FOUR),
  many: parent(MANY, ["GLX-401", "GLX-402", "GLX-403"]),
})) {
  for (const w of [1440, 1100]) {
    for (const theme of ["dark", "light"]) {
      test(`subtasks ${name} ${w} ${theme}`, async ({ page }) => {
        await page.setViewportSize({ width: w, height: 900 });
        await stub(page, scene);
        await page.goto("/t/GLX-418");
        await page.evaluate((t) => {
          document.documentElement.dataset.theme = t;
        }, theme);
        await expect(page.getByRole("region", { name: /Subtasks/ })).toBeVisible();
        await page.waitForTimeout(700);
        await page.screenshot({ path: `${SHOTS}/${name}-${w}-${theme}.png` });
        // Nothing runs off the window: the page itself never scrolls sideways or down.
        const overflow = await page.evaluate(() => ({
          x: document.documentElement.scrollWidth - window.innerWidth,
          y: document.documentElement.scrollHeight - window.innerHeight,
        }));
        expect(overflow).toEqual({ x: 0, y: 0 });
      });
    }
  }
}

test("the header summary brings the Subtasks card into view", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 700 });
  await stub(page, parent(MANY, ["GLX-401", "GLX-402", "GLX-403"]));
  await page.goto("/t/GLX-418");
  await page.getByRole("button", { name: /Subtasks .* done/ }).click();
  await expect(page.getByRole("region", { name: /Subtasks/ })).toBeInViewport();
  await page.screenshot({ path: `${SHOTS}/summary-click-1100.png` });
});

test("menus stay open while the room streams", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const scene = parent(FOUR);
  const { room } = await stub(page, scene);
  await page.goto("/t/GLX-418");
  await expect(page.getByRole("log", { name: "Room messages" })).toContainText("I split it");

  // The model picker in the composer.
  await page.getByRole("button", { name: /Model and effort/ }).click();
  const picker = page.getByRole("menu", { name: /Model and effort/ });
  await expect(picker).toBeVisible();
  await stream(room(), page, scene.full);
  await expect(picker).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/streaming-model-picker.png` });
  await page.keyboard.press("Escape");
  await expect(picker).toBeHidden();

  // The task's ... menu in the header.
  await page.getByRole("button", { name: "Task menu" }).click();
  const menu = page.getByRole("menu", { name: "Task menu" });
  await expect(menu).toBeVisible();
  await stream(room(), page, scene.full);
  await expect(menu).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/streaming-task-menu.png` });

  // A click outside still closes it.
  await page.getByRole("log", { name: "Room messages" }).click({ position: { x: 20, y: 20 } });
  await expect(menu).toBeHidden();

  // An image opened full size.
  await page.getByRole("button", { name: "View flow chart full size" }).click();
  const viewer = page.getByRole("dialog", { name: "flow chart" });
  await expect(viewer).toBeVisible();
  await stream(room(), page, scene.full);
  await expect(viewer).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(viewer).toBeHidden();
});

test("the Ship panel stays open while the room streams", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const scene = parent(FOUR, [], "review");
  const { room } = await stub(page, scene);
  await page.goto("/t/GLX-418");
  await page.getByRole("button", { name: "Ship" }).first().click();
  const panel = page.locator('[aria-haspopup="dialog"][aria-expanded="true"]');
  await expect(panel).toHaveCount(1);
  await stream(room(), page, scene.full);
  await expect(panel).toHaveCount(1);
  await page.screenshot({ path: `${SHOTS}/streaming-ship.png` });
});
