import { expect, type Page, test } from "@playwright/test";
import type { RoomItem, RoomServerMessage, Task, TaskSummary } from "../packages/shared/src/index.ts";

/** Screenshots of the board, tree, a task and the changes viewer with stubbed data. No tokens spent. */
const NOW = Date.now();
const iso = (m: number) => new Date(NOW - m * 60_000).toISOString();

const summary = (
  id: string,
  title: string,
  status: TaskSummary["status"],
  extra: Partial<TaskSummary> = {},
): TaskSummary => ({
  id,
  title,
  kind: "code",
  mode: "lead",
  org: "globex",
  status,
  team: ["globex-lead", "globex-builder"],
  updatedAt: iso(10),
  repos: [{ project: "alpha-api", branch: `task/${id}` }],
  working: [],
  links: [],
  waitingOn: [],
  ...extra,
});

const parentOf = (id: string): TaskSummary["links"] => [{ type: "parent", task: id }];
const TASKS: TaskSummary[] = [
  summary("GLX-410", "Export pipeline rework", "running", { children: { total: 3, done: 1 } }),
  summary("GLX-411", "Move the export into a queued job", "done", { links: parentOf("GLX-410") }),
  summary("GLX-412", "Return a download link and add a test", "running", {
    links: [...parentOf("GLX-410"), { type: "depends-on", task: "GLX-411" }],
    children: { total: 3, done: 0 },
  }),
  summary("GLX-413", "Retire the synchronous export path", "ready", {
    links: [...parentOf("GLX-410"), { type: "depends-on", task: "GLX-412" }],
    waitingOn: ["GLX-412"],
  }),
  summary(
    "GLX-420",
    "Schematic export times out on very large boards with many layers and the gateway gives up after thirty seconds which the owner sees as a blank page",
    "inbox",
  ),
  ...Array.from({ length: 12 }, (_, i) =>
    summary(`GLX-${430 + i}`, `Inbox item number ${i + 1} for the sample project`, "inbox"),
  ),
  summary("GLX-414", "Write the download link tests", "running", { links: parentOf("GLX-412") }),
  summary("GLX-415", "Document the new export flow", "inbox", { links: parentOf("GLX-412") }),
  summary("GLX-416", "Announce the change to support", "ready", { links: parentOf("GLX-412") }),
  summary("GLX-450", "Session expiry banner in the web app", "review"),
];

const FULL: Task = {
  id: "GLX-412",
  title: "Return a download link and add a test",
  brief:
    "Return a download link and add a test\n\nFollow SPEC.md and `docs/PROGRESS.md`. The brief for this wave is in docs/briefs/2b-wave2.md.\n\n- Edit `apps/web/src/export.ts`\n- Keep the API stable\n- Add a test\n- Update the docs\n- Check e.g. the limits\n- Run the suite\n- Then ship",
  kind: "code",
  org: "globex",
  status: "running",
  folder: "/Users/you/.majhi/tasks/GLX-412",
  mode: "lead",
  overrides: {},
  repos: [
    {
      project: "alpha-api",
      source: "/Users/you/Work/alpha-api",
      base: "develop",
      branch: "task/glx-412-return-a-download-link-and-add-a-test",
      worktree: "/Users/you/.majhi/tasks/GLX-412/alpha-api",
      createdBranch: true,
    },
  ],
  team: ["globex-lead"],
  links: [
    { type: "parent", task: "GLX-410" },
    { type: "depends-on", task: "GLX-411", when: "merged" },
  ],
  attachments: [],
  createdAt: iso(60),
  updatedAt: iso(1),
};

const item = (n: number, rest: Record<string, unknown>): RoomItem =>
  ({ id: `i${n}`, task: "GLX-412", seq: n, at: iso(30 - n), ...rest }) as RoomItem;

const ROOM: RoomServerMessage = {
  type: "snapshot",
  more: false,
  processes: [],
  agents: [{ agent: "globex-lead", status: "idle", queued: 0, model: "opus-5.5", commands: [] }],
  items: [
    item(1, { type: "agent", agent: "globex-lead", text: "Done. I changed `src/export.ts`." }),
    item(2, {
      type: "tool",
      agent: "globex-lead",
      toolCallId: "t1",
      title: "Edit src/export.ts",
      kind: "edit",
      status: "completed",
      locations: ["/Users/you/.majhi/tasks/GLX-412/alpha-api/src/export.ts"],
      content: [
        {
          type: "diff",
          path: "/Users/you/.majhi/tasks/GLX-412/alpha-api/src/export.ts",
          oldText: "export function run() {\n  return sync();\n}\n",
          newText: "export function run() {\n  return queue.add(job);\n}\n\nexport const link = () => url;\n",
        },
      ],
    }),
  ],
};

async function stub(page: Page): Promise<void> {
  await page.route("**/api/cmd/tasks.list", (route) => route.fulfill({ json: TASKS }));
  await page.route("**/api/cmd/tasks.get", (route) => route.fulfill({ json: FULL }));
  await page.route("**/api/tasks/GLX-412/**/files/**", (route) => {
    const url = route.request().url();
    if (url.includes("meta=1")) return route.fulfill({ json: { size: 80, modified: iso(2) } });
    return route.fulfill({
      status: 200,
      contentType: "text/plain",
      body: "export function run() {\n  return queue.add(job);\n}\n\nexport const link = () => url;\n",
    });
  });
  await page.routeWebSocket(/\/api\/tasks\/([^/]+)\/room$/, (ws) => ws.send(JSON.stringify(ROOM)));
}

/** The document never scrolls: only panes inside do. */
async function noPageScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollHeight - document.documentElement.clientHeight,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test("ux board and tree", async ({ page }) => {
  await stub(page);
  await page.goto("/");
  await expect(page.getByRole("link", { name: /GLX-410/ }).first()).toBeVisible();
  await page.waitForTimeout(900);
  await noPageScroll(page);
  await page.screenshot({ path: "e2e/screenshots/ux-board.png" });
  await page.getByRole("button", { name: "Tree" }).click();
  await expect(page).toHaveURL(/view=tree/);
  await expect(page.getByRole("button", { name: /^GLX-412/ })).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({ path: "e2e/screenshots/ux-tree.png" });
});

test("ux task and changes viewer", async ({ page }) => {
  await stub(page);
  await page.goto("/t/GLX-412");
  await expect(page.getByRole("heading", { name: FULL.title })).toBeVisible();
  await expect(page.getByRole("link", { name: "SPEC.md" })).toBeVisible();
  await page.waitForTimeout(700);
  await noPageScroll(page);
  await page.screenshot({ path: "e2e/screenshots/ux-task.png" });
  await page.screenshot({
    path: "e2e/screenshots/ux-task-header.png",
    clip: { x: 0, y: 0, width: 1440, height: 330 },
  });
  await page.getByRole("link", { name: "Show changes in src/export.ts" }).click();
  const viewer = page.getByRole("dialog", { name: "File alpha-api/src/export.ts" });
  await expect(viewer.getByText("queue.add(job)").first()).toBeVisible();
  await page.waitForTimeout(400);
  await page.screenshot({ path: "e2e/screenshots/ux-viewer-changes.png" });
});
