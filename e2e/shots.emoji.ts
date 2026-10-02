import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import type { RoomItem, RoomServerMessage, Task, TaskSummary } from "../packages/shared/src/index.ts";

/**
 * Agent emojis: the picker on the agent page, and the emoji on avatars in the Agents list, a room and
 * the board. The server is the seeded one (`ui`); emojis are set through `agents.edit`, as the owner
 * would through the API. Tasks and the room are stubbed in the browser.
 *
 * Screenshots go to SHOTS. Run: `pnpm exec playwright test -c playwright.emoji.config.ts`.
 */
const SHOTS = process.env.SHOTS ?? "/private/tmp/claude-501/emoji-shots";
const NOW = Date.now();
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

/** globex-builder-2 has none, so the initial shows beside the emojis. */
const EMOJIS: Record<string, string> = {
  setup: "\u{1F9D1}‍✈️",
  "globex-lead": "\u{1F9ED}",
  "globex-builder": "\u{1F6E0}️",
  "globex-reviewer": "\u{1F50E}",
  housekeeper: "⚙️",
  dispatcher: "\u{1F4EE}",
};
const TEAM = ["globex-lead", "globex-builder", "globex-builder-2", "globex-reviewer"];

async function setEmoji(request: APIRequestContext, id: string, emoji: string | null): Promise<void> {
  const res = await request.post("/api/cmd/agents.edit", { data: { id, set: { emoji } } });
  expect(res.status(), await res.text()).toBe(200);
}

async function emojiOf(request: APIRequestContext, id: string): Promise<string | undefined> {
  const res = await request.post("/api/cmd/agents.list", { data: {} });
  const entries = (await res.json()) as {
    status: string;
    agent?: { frontmatter: { id: string; emoji?: string } };
  }[];
  return entries.find((e) => e.agent?.frontmatter.id === id)?.agent?.frontmatter.emoji;
}

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
  team: TEAM,
  mode: "lead",
  updatedAt: iso(10),
  repos: [{ project: "alpha-api", branch: `task/${id}` }],
  working: [],
  links: [],
  waitingOn: [],
  ...extra,
});

const TASKS: TaskSummary[] = [
  summary("GLX-418", "Schematic export times out on large boards", "running", {
    working: ["globex-lead", "globex-builder"],
  }),
  summary("GLX-419", "Signed download links that expire after a day", "review", {
    team: ["globex-reviewer", "globex-builder-2"],
  }),
  summary("GLX-420", "Progress events over the socket", "paused", {
    pausedReason: "limit",
    team: ["globex-builder", "globex-reviewer"],
  }),
  summary("GLX-421", "Retry failed exports with backoff", "ready", { team: ["setup", "globex-builder-2"] }),
  summary("GLX-422", "Document the export API", "done", { team: ["globex-lead"] }),
];

const FULL: Task = {
  id: "GLX-418",
  title: "Schematic export times out on large boards",
  brief: "x",
  kind: "code",
  org: "globex",
  status: "running",
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
  team: TEAM,
  links: [],
  attachments: [],
  createdAt: iso(60),
  updatedAt: iso(1),
} as Task;

const item = (n: number, rest: Record<string, unknown>): RoomItem =>
  ({ id: `i${n}`, task: "GLX-418", seq: n, at: iso(30 - n), ...rest }) as RoomItem;

const live = (agent: string, status: "working" | "idle", nowDoing?: string) => ({
  agent,
  status,
  ...(nowDoing ? { nowDoing } : {}),
  queued: 0,
  model: "opus-5.5",
  effort: "high",
  commands: [],
});

const SNAPSHOT = {
  type: "snapshot",
  more: false,
  processes: [],
  agents: [
    live("globex-lead", "working", "Planning the export worker"),
    live("globex-builder", "working", "Editing src/export/job.ts"),
    live("globex-builder-2", "idle"),
    live("globex-reviewer", "idle"),
  ],
  items: [
    item(1, { type: "owner", text: "Move the export into a queued worker.", attachments: [], queued: false }),
    item(2, {
      type: "agent",
      agent: "globex-lead",
      text: "On it. @globex-builder takes the worker, @globex-reviewer reviews when it is up.",
    }),
    item(3, { type: "agent", agent: "globex-builder", text: "The worker is in src/export/job.ts." }),
    item(4, { type: "agent", agent: "globex-builder-2", text: "I can take the retries next." }),
    item(5, { type: "agent", agent: "globex-reviewer", text: "Looks good. One note on the timeout." }),
  ],
} as unknown as RoomServerMessage;

async function stubTasks(page: Page): Promise<void> {
  await page.route("**/api/cmd/tasks.list", (r) => r.fulfill({ json: TASKS }));
  await page.route("**/api/cmd/tasks.get", (r) => r.fulfill({ json: FULL }));
  await page.route("**/api/cmd/tasks.diff", (r) => r.fulfill({ json: [] }));
  await page.routeWebSocket(/\/api\/tasks\/([^/]+)\/room$/, (ws) => {
    ws.send(JSON.stringify(SNAPSHOT));
  });
}

async function look(page: Page, w: number, theme: string): Promise<void> {
  await page.setViewportSize({ width: w, height: 900 });
  await page.evaluate((t) => {
    document.documentElement.dataset.theme = t;
  }, theme);
}

async function noPageScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => ({
    x: document.documentElement.scrollWidth - window.innerWidth,
    y: document.documentElement.scrollHeight - window.innerHeight,
  }));
  expect(overflow).toEqual({ x: 0, y: 0 });
}

test.beforeAll(async ({ request }) => {
  for (const [id, emoji] of Object.entries(EMOJIS)) await setEmoji(request, id, emoji);
  await setEmoji(request, "globex-builder-2", null);
});

for (const w of [1440, 1100]) {
  for (const theme of ["dark", "light"]) {
    test(`emoji ${w} ${theme}`, async ({ page }) => {
      await stubTasks(page);
      await page.setViewportSize({ width: w, height: 900 });

      await page.goto("/agents?agent=globex-lead");
      await look(page, w, theme);
      const avatar = page.getByRole("button", { name: "Change the emoji of @globex-lead" });
      await expect(avatar).toContainText(EMOJIS["globex-lead"] ?? "");
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${SHOTS}/agents-${w}-${theme}.png` });
      await noPageScroll(page);

      await avatar.click();
      const picker = page.getByRole("dialog", { name: "Emoji for @globex-lead" });
      await expect(picker.getByRole("gridcell").first()).toBeVisible();
      await expect(picker).toBeInViewport({ ratio: 1 });
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${SHOTS}/picker-${w}-${theme}.png` });
      await picker.getByRole("searchbox", { name: "Search emoji" }).fill("rocket");
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${SHOTS}/picker-search-${w}-${theme}.png` });
      await page.keyboard.press("Escape");
      await expect(picker).toBeHidden();

      await page.goto("/t/GLX-418");
      await look(page, w, theme);
      await expect(page.getByRole("log", { name: "Room messages" })).toContainText("Looks good");
      await page.waitForTimeout(500);
      await page.screenshot({ path: `${SHOTS}/room-${w}-${theme}.png` });
      await noPageScroll(page);

      await page.goto("/");
      await look(page, w, theme);
      await expect(page.getByText("Signed download links").first()).toBeVisible();
      await page.waitForTimeout(500);
      await page.screenshot({ path: `${SHOTS}/board-${w}-${theme}.png` });
      await noPageScroll(page);
    });
  }
}

test("new agent form picks an emoji before the agent exists", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/agents");
  await page.getByRole("button", { name: "New agent in Globex" }).click();
  const form = page.getByRole("form", { name: "New agent" });
  await form.getByRole("button", { name: /Pick an emoji for @/ }).click();
  const picker = page.getByRole("dialog", { name: /Emoji for @/ });
  await picker.getByRole("searchbox", { name: "Search emoji" }).fill("robot");
  await picker.getByRole("gridcell", { name: "Robot" }).click();
  await expect(picker).toBeHidden();
  await expect(form.getByRole("button", { name: /Change the emoji of @/ })).toContainText("\u{1F916}");
  await page.screenshot({ path: `${SHOTS}/new-agent-1440-dark.png` });
});

test("pick an emoji, see it in the room and on the board, then remove it", async ({ page, request }) => {
  await stubTasks(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/agents?agent=globex-builder-2");

  await page.getByRole("button", { name: "Pick an emoji for @globex-builder-2" }).click();
  const picker = page.getByRole("dialog", { name: "Emoji for @globex-builder-2" });
  await picker.getByRole("searchbox", { name: "Search emoji" }).fill("robot");
  await picker.getByRole("gridcell", { name: "Robot" }).click();
  await expect(picker).toBeHidden();
  const button = page.getByRole("button", { name: "Change the emoji of @globex-builder-2" });
  await expect(button).toContainText("\u{1F916}");
  await expect.poll(() => emojiOf(request, "globex-builder-2")).toBe("\u{1F916}");

  // The Agents list row, the room and the board read it from the agents list.
  await expect(page.getByRole("button", { name: /@globex-builder-2/ }).first()).toContainText("\u{1F916}");
  await page.goto("/t/GLX-418");
  await expect(page.getByRole("log", { name: "Room messages" })).toContainText("I can take the retries");
  await expect(page.getByRole("log", { name: "Room messages" })).toContainText("\u{1F916}");
  await expect(page.getByRole("img", { name: /^globex-builder-2/ }).first()).toContainText("\u{1F916}");
  await page.goto("/");
  await expect(page.getByRole("img", { name: "globex-builder-2" }).first()).toContainText("\u{1F916}");
  await page.screenshot({ path: `${SHOTS}/click-board-1440-dark.png` });

  // Remove it again: the initial comes back and the file has no emoji.
  await page.goto("/agents?agent=globex-builder-2");
  await button.click();
  await picker.getByRole("button", { name: "Remove emoji" }).click();
  await expect(picker).toBeHidden();
  await expect(page.getByRole("button", { name: "Pick an emoji for @globex-builder-2" })).toContainText("2");
  await expect.poll(() => emojiOf(request, "globex-builder-2")).toBeUndefined();
});
