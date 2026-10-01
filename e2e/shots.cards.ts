import { test, type Page } from "@playwright/test";
import type { RoomItem, RoomServerMessage, Task } from "../packages/shared/src/index.ts";

const NOW = Date.now();
const iso = (m: number) => new Date(NOW - m * 60_000).toISOString();
const item = (n: number, rest: Record<string, unknown>): RoomItem =>
  ({ id: `i${n}`, task: "GLX-418", seq: n, at: iso(30 - n), ...rest }) as RoomItem;

const TASK: Task = {
  id: "GLX-418", title: "Schematic export times out on large boards", brief: "x", kind: "code", org: "globex",
  status: "review", folder: "/Users/you/.majhi/tasks/GLX-418", mode: "lead", overrides: {},
  repos: [{ project: "alpha-api", source: "/Users/you/Work/alpha-api", base: "develop", branch: "task/GLX-418-x", worktree: "/Users/you/.majhi/tasks/GLX-418/alpha-api", createdBranch: true }],
  team: ["globex-lead"], links: [], attachments: [], createdAt: iso(60), updatedAt: iso(1),
} as Task;

const LONG = "Rebuild the whole export pipeline around a queued worker with retries, progress events and a signed download link that expires after a day, then migrate every existing caller to it";
const single = item(10, {
  type: "ask", agent: "globex-lead", state: "pending", at: iso(2),
  questions: [{ id: "q1", question: "How should I build the export job?", freeText: true, default: "a", options: [
    { id: "a", label: "Recommended: a queued worker with a download link, returning 202 right away" },
    { id: "b", label: "Cheaper: stream the file in the request and raise the gateway timeout" },
    { id: "c", label: LONG },
    { id: "d", label: "Report only" },
  ] }],
});
const multi = item(11, {
  type: "ask", agent: "globex-lead", state: "pending", at: iso(2),
  questions: [
    { id: "q1", question: "How should I build the export job?", freeText: true, default: "a", options: [
      { id: "a", label: "Recommended: a queued worker" }, { id: "b", label: LONG } ] },
    { id: "q2", question: "Which branch should the work target?", freeText: false, options: [
      { id: "a", label: "develop" }, { id: "b", label: "main" } ] },
  ],
});
const review = item(12, { type: "review", state: "pending", lead: "globex-lead", at: iso(1) });
const base = [
  item(1, { type: "owner", text: "Add a background job for the export.", attachments: [], queued: false }),
  item(2, { type: "agent", agent: "globex-lead", text: "The export runs in the request, so large boards time out." }),
];
const SCENES: Record<string, RoomItem[]> = {
  single: [...base, single],
  multi: [...base, multi],
  "ask-review": [...base, review, single],
  review: [...base, review],
};

async function stub(page: Page, items: RoomItem[]) {
  const room: RoomServerMessage = { type: "snapshot", more: false, processes: [], agents: [], items } as RoomServerMessage;
  await page.route("**/api/cmd/tasks.diff", (r) => r.fulfill({ json: [] }));
  await page.route("**/api/cmd/tasks.get", (r) => r.fulfill({ json: TASK }));
  await page.routeWebSocket(/\/api\/tasks\/([^/]+)\/room$/, (ws) => ws.send(JSON.stringify(room)));
}

for (const [name, items] of Object.entries(SCENES)) {
  for (const w of [1440, 1100]) {
    for (const theme of ["dark", "light"]) {
      test(`${name} ${w} ${theme}`, async ({ page }) => {
        await page.setViewportSize({ width: w, height: 900 });
        await stub(page, items);
        await page.goto("/t/GLX-418");
        await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
        await page.waitForTimeout(900);
        await page.screenshot({ path: `/private/tmp/claude-501/cards-shots/${name}-${w}-${theme}.png` });
      });
    }
  }
}
test("single interactions", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 700 });
  await stub(page, SCENES.single!);
  await page.goto("/t/GLX-418");
  await page.waitForTimeout(700);
  await page.getByRole("button", { name: /Cheaper/ }).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: "/private/tmp/claude-501/cards-shots/single-pending.png" });
  await page.getByRole("button", { name: "Undo" }).click();
  await page.getByRole("button", { name: "Something else" }).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: "/private/tmp/claude-501/cards-shots/single-text.png" });
});
