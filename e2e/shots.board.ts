import { expect, type Page, test } from "@playwright/test";
import type { RoomItem, RoomServerMessage, Task, TaskSummary } from "../packages/shared/src/index.ts";

/**
 * Design renders of the board, a task and the New task dialog. The server and its home are the
 * seeded one (orgs, agents, accounts, projects); the task list, one task and its room are stubbed
 * in the browser, because a busy board needs agents in every state and this run spends no tokens.
 */
const NOW = Date.now();
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

const summary = (
  id: string,
  title: string,
  org: string,
  status: TaskSummary["status"],
  repos: string[],
  team: string[],
  extra: Partial<TaskSummary> = {},
): TaskSummary => ({
  id,
  title,
  kind: repos.length > 0 ? "code" : "chat",
  org,
  status,
  team,
  mode: "lead",
  updatedAt: iso(10),
  repos: repos.map((project) => ({ project, branch: `task/${id}` })),
  working: [],
  links: [],
  waitingOn: [],
  ...extra,
});

const GLX = ["globex-lead", "globex-builder", "globex-reviewer"];
const ACM = ["acme-lead", "acme-builder"];
const NW = ["nw-lead", "nw-builder"];

const TASKS: TaskSummary[] = [
  summary("GLX-418", "Schematic export times out on large boards", "globex", "inbox", ["alpha-api"], GLX),
  summary("NW-236", "Paginate the audit log endpoint", "northwind", "inbox", ["gamma-infra"], NW.slice(0, 1)),
  summary("LOCAL-7", "Upgrade Next.js to the latest minor", "globex", "inbox", ["alpha-api"], GLX),
  summary("GLX-415", "Session expiry banner in the web app", "globex", "ready", ["alpha-api"], GLX),
  summary("ACM-88", "Move portal forms to the new validation lib", "acme", "running", ["beta-web"], ACM, {
    working: ["acme-lead"],
  }),
  summary("NW-231", "Dark mode for dashboard charts", "northwind", "paused", ["gamma-infra"], NW, {
    pausedReason: "limit",
  }),
  summary("GLX-421", "Explain how sessions are stored", "globex", "running", [], ["globex-lead"]),
  summary("GLX-412", "Rotate refresh tokens on every auth call", "globex", "review", ["alpha-api"], GLX),
  summary("ACM-91", "SSO callback returns 500 on expired state", "acme", "mr", ["beta-web"], ACM),
];

const FULL: Task = {
  id: "GLX-418",
  title: "Schematic export times out on large boards",
  brief:
    "Schematic export times out on large boards\n\nLarge exports hit the gateway timeout. Move export to a background job and return a download link. Work in alpha-api from develop.",
  kind: "code",
  org: "globex",
  status: "running",
  folder: "/Users/you/.majhi/tasks/GLX-418",
  mode: "lead",
  overrides: {},
  repos: [
    {
      project: "alpha-api",
      source: "/Users/you/Work/alpha-api",
      base: "develop",
      branch: "task/GLX-418-export-timeout",
      worktree: "/Users/you/.majhi/tasks/GLX-418/alpha-api",
      createdBranch: true,
    },
  ],
  team: ["globex-lead"],
  links: [],
  attachments: [],
  createdAt: iso(60),
  updatedAt: iso(1),
};

const item = (n: number, rest: Record<string, unknown>): RoomItem =>
  ({ id: `i${n}`, task: "GLX-418", seq: n, at: iso(30 - n), ...rest }) as RoomItem;

const ROOM: RoomServerMessage = {
  type: "snapshot",
  more: false,
  processes: [],
  agents: [
    {
      agent: "globex-lead",
      status: "working",
      nowDoing: "Editing src/export/job.ts",
      queued: 0,
      model: "opus-5.5",
      effort: "high",
      commands: [],
    },
  ],
  items: [
    item(1, {
      type: "owner",
      text: "Add a background job for the export and return a download link.",
      attachments: [],
      queued: false,
    }),
    item(2, {
      type: "plan",
      agent: "globex-lead",
      entries: [
        { content: "Read the export handler and the gateway timeout", status: "completed" },
        { content: "Move the export into a queued job", status: "in_progress" },
        { content: "Return a download link and add a test", status: "pending" },
      ],
    }),
    item(3, {
      type: "agent",
      agent: "globex-lead",
      text: "The export runs inside the request, so a large board hits the 30 s gateway limit. I will move it to a job and return `202` with a link.",
    }),
    item(4, {
      type: "tool",
      agent: "globex-lead",
      toolCallId: "t1",
      title: "Read src/export/handler.ts",
      kind: "read",
      status: "completed",
      locations: ["/Users/you/.majhi/tasks/GLX-418/alpha-api/src/export/handler.ts"],
      content: [],
    }),
    item(5, { type: "system", level: "info", text: "worktree ready at ~/.majhi/tasks/GLX-418/alpha-api" }),
  ],
};

/** The paused task of the board, as `tasks.get` and its room answer for it. */
const PAUSED: Task = {
  ...FULL,
  id: "NW-231",
  title: "Dark mode for dashboard charts",
  brief: "Dark mode for dashboard charts",
  org: "northwind",
  status: "paused",
  pausedReason: "limit",
  team: ["nw-lead", "nw-builder"],
  repos: [
    {
      ...(FULL.repos[0] as NonNullable<Task["repos"][number]>),
      project: "gamma-infra",
      branch: "task/NW-231-dark-charts",
      base: "main",
    },
  ],
};
const PAUSED_ROOM: RoomServerMessage = {
  type: "snapshot",
  more: false,
  processes: [],
  agents: [
    { agent: "nw-lead", status: "idle", queued: 0, model: "opus-5.5", commands: [] },
    { agent: "nw-builder", status: "idle", queued: 0, model: "gpt-5.5", commands: [] },
  ],
  items: [
    {
      id: "n1",
      task: "NW-231",
      seq: 1,
      at: iso(20),
      type: "system",
      level: "warn",
      text: "claude-northwind hit its usage limit. The task is paused.",
    },
  ],
};

async function stub(page: Page, tasks: TaskSummary[] = TASKS): Promise<void> {
  await page.route("**/api/cmd/tasks.list", (route) => route.fulfill({ json: tasks }));
  await page.route("**/api/cmd/tasks.diff", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/cmd/tasks.get", (route) => {
    const id = (route.request().postDataJSON() as { id: string }).id;
    return route.fulfill({ json: id === "NW-231" ? PAUSED : FULL });
  });
  await page.routeWebSocket(/\/api\/tasks\/([^/]+)\/room$/, (ws) => {
    const paused = ws.url().includes("/NW-231/");
    ws.send(JSON.stringify(paused ? PAUSED_ROOM : ROOM));
  });
}

test("board", async ({ page }) => {
  await stub(page);
  await page.goto("/");
  await expect(page.getByText("GLX-418").first()).toBeVisible();
  await page.waitForTimeout(900);
  await page.screenshot({ path: "e2e/screenshots/ui-board.png" });
});

test("task", async ({ page }) => {
  await stub(page);
  await page.goto("/t/GLX-418");
  await expect(
    page.getByRole("heading", { name: "Schematic export times out on large boards" }),
  ).toBeVisible();
  await expect(page.getByText("Plan", { exact: false }).first()).toBeVisible();
  await page.waitForTimeout(900);
  await page.screenshot({ path: "e2e/screenshots/ui-task.png" });
});

test("new task", async ({ page }) => {
  await stub(page);
  await page.goto("/");
  await expect(page.getByText("GLX-418").first()).toBeVisible();
  await page.keyboard.press("n");
  const dialog = page.getByRole("dialog", { name: "New task" });
  await expect(dialog).toBeVisible();
  await page.waitForTimeout(500);
  await page.screenshot({ path: "e2e/screenshots/ui-new-task.png" });
});

test("paused task and empty board", async ({ page }) => {
  await stub(page);
  await page.goto("/t/NW-231");
  await expect(page.getByRole("heading", { name: "Dark mode for dashboard charts" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Resume" })).toBeVisible();
  await page.waitForTimeout(500);
  await page.screenshot({ path: "e2e/screenshots/ui-task-paused.png" });

  await stub(page, []);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Nothing on the board yet" })).toBeVisible();
  await page.waitForTimeout(500);
  await page.screenshot({ path: "e2e/screenshots/ui-board-empty.png" });
});

const SCRATCH = process.env.MAJHI_SHOT_DIR;

test("states for review", async ({ page }) => {
  test.skip(!SCRATCH, "set MAJHI_SHOT_DIR to render the review states");
  await stub(page);
  await page.goto("/");
  await expect(page.getByText("GLX-418").first()).toBeVisible();
  await page.keyboard.press("j");
  await page.keyboard.press("l");
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SCRATCH}/focus.png` });

  await page.keyboard.press("n");
  const dialog = page.getByRole("dialog", { name: "New task" });
  await dialog
    .getByRole("textbox", { name: "Title" })
    .fill("Fix the login redirect in alpha-api from develop");
  await dialog
    .getByRole("textbox", { name: "Details for the team" })
    .fill("The redirect loses the query string after sign in.");
  await dialog.getByRole("button", { name: "beta-web", exact: true }).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SCRATCH}/dialog-filled.png` });
  await page.keyboard.press("Escape");
  await page.keyboard.press("?");
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SCRATCH}/shortcuts.png` });
});
