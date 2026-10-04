import { expect, type Page, test } from "@playwright/test";
import type {
  DecisionDetail,
  HandoffResult,
  HandoffState,
  OwnerDecision,
  RoomItem,
  RoomServerMessage,
  Task,
} from "../packages/shared/src/index.ts";

/**
 * The checked hand-off (SPEC 5.18): the evidence line and its steps on the Ship decision and on the
 * review card, green with notes, red with a failing test, three failed hand-offs, and a check that
 * is running. The server is the seeded one (`ui`); decisions, details, the room and `handoff.get` are
 * stubbed in the browser.
 *
 * Screenshots go to SHOTS. Run: `pnpm exec playwright test -c playwright.handoff.config.ts`.
 */
const SHOTS = process.env.SHOTS ?? "/private/tmp/claude-501/handoff-shots";
const NOW = Date.now();
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

const step = (id: HandoffResult["steps"][number]["id"], label: string, rest: object) =>
  ({ id, label, ...rest }) as HandoffResult["steps"][number];

const GREEN: HandoffResult = {
  task: "HOO-31",
  head: "hooli-shop@3f9a1c2d4e5b",
  at: ago(3),
  verdict: "green",
  steps: [
    step("ready", "Merge checks", {
      status: "pass",
      detail: "committed, merges cleanly into main, no card waits, no secret in the diff",
    }),
    step("tests", "Tests", { status: "pass", detail: "42 passed", ms: 31_000 }),
    step("build", "Build", { status: "pass", detail: "ok", ms: 8_000 }),
    step("lint", "Lint", { status: "pass", detail: "ok", ms: 2_000 }),
    step("acceptance", "Brief", {
      status: "note",
      detail: "1 of 3 lines with no evidence",
      items: [
        { text: "Orders are created once per payment", ok: true, note: "apps/shop/src/orders/create.ts" },
        { text: "The webhook looks the order up first", ok: true, note: "apps/shop/src/webhooks/payment.ts" },
        {
          text: "An alert fires when the same payment ref is seen twice",
          ok: false,
          note: "nothing in the diff matches it",
        },
      ],
    }),
    step("review", "Review", { status: "note", detail: "2 notes" }),
  ],
  review: {
    by: "model",
    notes: [
      "The error path of createOrder is not handled when the idempotency key store is down.",
      "A TODO was left in the change (apps/shop/src/orders/create.ts: // TODO handle rounding).",
    ],
    tokens: 1_640,
  },
  failures: [],
  held: [],
  ms: 44_000,
  cached: false,
  summary:
    "Checked: tests 42 passed (31 s), build ok (8 s), lint ok (2 s), brief: 1 of 3 lines with no evidence, review: 2 notes",
};

const TEST_OUTPUT = `FAIL  src/notes/export.test.ts > exports a board in the background
AssertionError: expected "queued" to be "done"
  - Expected
  + Received
  - done
  + queued
 ❯ src/notes/export.test.ts:41:23
 Test Files  1 failed | 11 passed (12)
      Tests  1 failed | 63 passed (64)`;

const RED: HandoffResult = {
  task: "UMB-8",
  head: "umbrella-notes@b81d77e0a9c4",
  at: ago(6),
  verdict: "red",
  steps: [
    step("ready", "Merge checks", {
      status: "pass",
      detail: "committed, merges cleanly into main, no card waits, no secret in the diff",
    }),
    step("tests", "Tests", {
      status: "fail",
      detail: "`pnpm test` failed (exit 1, 24 s, also on a retry)",
      ms: 48_000,
      output: TEST_OUTPUT,
    }),
    step("build", "Build", { status: "pass", detail: "ok", ms: 9_000 }),
    step("lint", "Lint", { status: "pass", detail: "ok", ms: 2_000 }),
    step("acceptance", "Brief", { status: "none", detail: "the brief has no checklist or done-when lines" }),
    step("review", "Review", { status: "skipped", detail: "the tests, build or lint did not pass" }),
  ],
  review: { by: "skipped", why: "the tests, build or lint did not pass", notes: [], tokens: 0 },
  failures: ["`pnpm test` failed (exit 1, 24 s, also on a retry)\n" + TEST_OUTPUT],
  held: [],
  ms: 60_000,
  cached: false,
  summary: "Checked: tests failed (48 s), build ok (9 s), lint ok (2 s), review not run",
};

const STATES: Record<string, HandoffState> = {
  "HOO-31": {
    task: "HOO-31",
    current: GREEN,
    stale: false,
    history: [],
    strikes: 0,
    escalated: false,
    running: false,
    queued: false,
  },
  "UMB-8": {
    task: "UMB-8",
    current: RED,
    stale: false,
    history: [
      { head: RED.head, at: ago(6), verdict: "red", failures: RED.failures, action: "escalated" },
      {
        head: "umbrella-notes@9a02c5de1b73",
        at: ago(40),
        verdict: "red",
        failures: ["`pnpm test` failed"],
        action: "told",
      },
      {
        head: "umbrella-notes@41e8fd30c6a2",
        at: ago(75),
        verdict: "red",
        failures: ["`pnpm build` failed"],
        action: "told",
      },
    ],
    strikes: 3,
    escalated: true,
    running: false,
    queued: false,
  },
  "INI-12": {
    task: "INI-12",
    stale: false,
    history: [],
    strikes: 0,
    escalated: false,
    running: true,
    queued: false,
  },
};

const ship = (task: string, title: string, sentence: string, at: number): OwnerDecision => ({
  id: `room:${task}:rv`,
  kind: "ship",
  task,
  taskTitle: title,
  title: `Ready to ship: ${title}`,
  sentence,
  options: [
    { id: "merge", label: "Merge", primary: true },
    { id: "done", label: "Mark done" },
    { id: "changes", label: "Ask for changes", text: true },
  ],
  at: ago(at),
  link: { kind: "task", id: task, item: "rv" },
});

const DECISIONS: OwnerDecision[] = [
  ship(
    "HOO-31",
    "Shop orders created twice",
    '@hooli-claude finished "Shop orders created twice" and it is ready to merge.',
    18,
  ),
  ship(
    "UMB-8",
    "Move the notes export to a background job",
    '@umbrella-builder finished "Move the notes export to a background job" and waits for your review. Checks failed 3 times in a row, so the lead is not told again. The latest: `pnpm test` failed (exit 1, 24 s, also on a retry)',
    44,
  ),
  ship(
    "INI-12",
    "Update the onboarding docs",
    '@initech-writer finished "Update the onboarding docs" and waits for your review.',
    25,
  ),
];

const detail = (id: string, task: string): DecisionDetail => ({
  id,
  handback: {
    agent: "builder",
    text: "Done. The change is committed and the tests I ran pass.",
    at: ago(20),
  },
  diff: {
    files: 6,
    additions: 142,
    deletions: 17,
    top: [
      { path: "apps/shop/src/orders/create.ts", additions: 58, deletions: 9 },
      { path: "apps/shop/src/orders/create.test.ts", additions: 51, deletions: 0 },
    ],
    uncommitted: false,
  },
  repos: [{ project: task.toLowerCase(), branch: `majhi/${task}`, into: "main" }],
});

async function stubDecisions(page: Page, states = STATES) {
  await page.route("**/api/cmd/decisions.list", (r) => r.fulfill({ json: { decisions: DECISIONS } }));
  await page.route("**/api/cmd/decisions.detail", (r) => {
    const { id } = r.request().postDataJSON() as { id: string };
    return r.fulfill({ json: detail(id, id.split(":")[1] ?? "HOO-31") });
  });
  await page.route("**/api/cmd/handoff.get", (r) => {
    const { task } = r.request().postDataJSON() as { task: string };
    return r.fulfill({ json: states[task] ?? states["HOO-31"] });
  });
  await page.route("**/api/cmd/handoff.check", (r) => {
    const { task } = r.request().postDataJSON() as { task: string };
    return r.fulfill({ json: { ...(states[task] ?? states["HOO-31"]), running: true } });
  });
}

async function open(page: Page, path: string, w: number, h: number, theme: string) {
  await page.setViewportSize({ width: w, height: h });
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
    test(`ship decision, green with notes ${w} ${theme}`, async ({ page }) => {
      await stubDecisions(page);
      await open(page, "/decisions?id=room:HOO-31:rv", w, h, theme);
      const block = page.getByRole("region", { name: "Hand-off check" });
      await expect(block).toContainText("Checked: tests 42 passed (31 s)");
      await page.screenshot({ path: `${SHOTS}/decision-green-${w}-${theme}.png` });
      await block.getByRole("button", { expanded: false }).click();
      await expect(
        block.getByText("Free checks only").or(block.getByText("A model read the change")),
      ).toBeVisible();
      await page.waitForTimeout(250);
      await page.screenshot({ path: `${SHOTS}/decision-green-open-${w}-${theme}.png` });
      await noPageScroll(page);
    });
    test(`ship decision, three failed hand-offs ${w} ${theme}`, async ({ page }) => {
      await stubDecisions(page);
      await open(page, "/decisions?id=room:UMB-8:rv", w, h, theme);
      const block = page.getByRole("region", { name: "Hand-off check" });
      await expect(block).toContainText("Not ready.");
      await page.screenshot({ path: `${SHOTS}/decision-red-${w}-${theme}.png` });
      await block.getByRole("button", { expanded: false }).click();
      await expect(block.getByText("Failed 3 times in a row")).toBeVisible();
      await page.waitForTimeout(250);
      await page.screenshot({ path: `${SHOTS}/decision-red-open-${w}-${theme}.png` });
      await noPageScroll(page);
    });
    test(`ship decision, a check that is running ${w} ${theme}`, async ({ page }) => {
      await stubDecisions(page);
      await open(page, "/decisions?id=room:INI-12:rv", w, h, theme);
      await expect(page.getByRole("region", { name: "Hand-off check" })).toContainText("Checking it.");
      await page.screenshot({ path: `${SHOTS}/decision-running-${w}-${theme}.png` });
    });
  }
}

// The review card in a task's room.
const TASK = {
  id: "UMB-8",
  title: "Move the notes export to a background job",
  brief: "x",
  kind: "code",
  org: "globex",
  status: "review",
  folder: "/Users/owner/.majhi/tasks/UMB-8",
  mode: "lead",
  overrides: {},
  repos: [
    {
      project: "umbrella-notes",
      source: "/Users/owner/Work/umbrella-notes",
      base: "main",
      branch: "task/UMB-8-x",
      worktree: "/Users/owner/.majhi/tasks/UMB-8/umbrella-notes",
      createdBranch: true,
    },
  ],
  team: ["umbrella-builder"],
  links: [],
  attachments: [],
  createdAt: ago(120),
  updatedAt: ago(1),
} as unknown as Task;

const card = (rest: object): RoomItem =>
  ({
    id: "i2",
    task: "UMB-8",
    seq: 2,
    at: ago(1),
    type: "review",
    state: "pending",
    lead: "umbrella-builder",
    ...rest,
  }) as RoomItem;

async function stubRoom(page: Page, items: RoomItem[], state: HandoffState) {
  const room = {
    type: "snapshot",
    more: false,
    processes: [],
    agents: [],
    items,
  } as unknown as RoomServerMessage;
  await page.route("**/api/cmd/tasks.diff", (r) => r.fulfill({ json: [] }));
  await page.route("**/api/cmd/tasks.get", (r) => r.fulfill({ json: TASK }));
  await page.route("**/api/cmd/handoff.get", (r) => r.fulfill({ json: state }));
  await page.routeWebSocket(/\/api\/tasks\/([^/]+)\/room$/, (ws) => ws.send(JSON.stringify(room)));
}

const owner = {
  id: "i1",
  task: "UMB-8",
  seq: 1,
  at: ago(60),
  type: "owner",
  text: "Move the export to a job.",
  attachments: [],
  queued: false,
} as unknown as RoomItem;

for (const w of [1440, 1100]) {
  for (const theme of ["dark", "light"]) {
    test(`review card, ready ${w} ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: 900 });
      await stubRoom(
        page,
        [
          owner,
          card({
            ready:
              "Ready to ship to main: committed, merges cleanly into main; tests 42 passed (31 s), build ok, lint ok, review: 2 notes",
          }),
        ],
        { ...STATES["HOO-31"]!, task: "UMB-8" },
      );
      await page.goto("/t/UMB-8");
      await page.evaluate((t) => {
        document.documentElement.dataset.theme = t;
      }, theme);
      await page.waitForTimeout(900);
      await page.screenshot({ path: `${SHOTS}/card-ready-${w}-${theme}.png` });
    });
    test(`review card, checks failed ${w} ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: 900 });
      await stubRoom(
        page,
        [
          owner,
          card({
            why: "Checks failed 3 times in a row, so the lead is not told again. The latest: `pnpm test` failed (exit 1, 24 s, also on a retry)",
          }),
        ],
        STATES["UMB-8"]!,
      );
      await page.goto("/t/UMB-8");
      await page.evaluate((t) => {
        document.documentElement.dataset.theme = t;
      }, theme);
      await page.waitForTimeout(900);
      await page
        .getByRole("region", { name: "Hand-off check" })
        .getByRole("button", { expanded: false })
        .click();
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${SHOTS}/card-failed-${w}-${theme}.png` });
    });
  }
}
