import { expect, type Page, test } from "@playwright/test";
import type { DecisionDetail, OrgView, OwnerDecision } from "../packages/shared/src/index.ts";

/**
 * The Decisions triage page (SPEC 5.18): a queue on the left and the selected decision in full on the
 * right, the bell's compact rows, keyboard flow and the narrow layout. Volume is modeled on a real
 * day: about a dozen decisions in four workspaces, one with a very long name. The server is the seeded
 * one (`ui`); decisions, details and workspaces are stubbed in the browser.
 *
 * Screenshots go to SHOTS. Run: `pnpm exec playwright test -c playwright.decisions.config.ts`.
 */
const SHOTS = process.env.SHOTS ?? "/private/tmp/claude-501/decisions-shots";
const NOW = Date.now();
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const LONG = "Ideeza Interactive Technologies and Retail Platforms Limited";

const ORGS: Record<string, { name: string; key: string; color: string }> = {
  pyzasoft: { name: "Pyzasoft", key: "PYZ", color: "#4f8fd9" },
  goama: { name: "Goama", key: "GOA", color: "#d98a4f" },
  ideeza: { name: LONG, key: "IDZ", color: "#4f9d8a" },
};

const SHIP_REASON =
  "In Pyzasoft you decide when work is merged. The change is small and committed, it merges cleanly into main, no card waits and the diff holds no secret. The two new tests fail without the fix and pass with it.";

const DECISIONS: OwnerDecision[] = [
  {
    id: "room:PYZ-31:rv1",
    kind: "ship",
    org: "pyzasoft",
    task: "PYZ-31",
    taskTitle: "Shop orders created twice",
    title: "Ready to ship: Shop orders created twice",
    sentence: '@pyzasoft-claude finished "Shop orders created twice" and it is ready to merge.',
    options: [
      { id: "merge", label: "Merge", primary: true },
      { id: "done", label: "Mark done" },
      { id: "changes", label: "Ask for changes", text: true },
    ],
    suggestion: { option: "merge", reason: SHIP_REASON, by: "captain" },
    at: ago(18),
    link: { kind: "task", id: "PYZ-31", item: "rv1" },
  },
  {
    id: "room:IDZ-8:rv2",
    kind: "ship",
    org: "ideeza",
    task: "IDZ-8",
    taskTitle: "Move the notes export to a background job",
    title: "Ready to ship: Move the notes export to a background job",
    sentence:
      '@ideeza-builder finished "Move the notes export to a background job" and it is ready to merge.',
    options: [
      { id: "merge", label: "Merge", primary: true },
      { id: "done", label: "Mark done" },
      { id: "changes", label: "Ask for changes", text: true },
    ],
    suggestion: {
      option: "merge",
      reason:
        "Committed, merges cleanly into main, no card waits. In this workspace you decide when work is merged.",
      by: "captain",
    },
    at: ago(44),
    link: { kind: "task", id: "IDZ-8", item: "rv2" },
  },
  {
    id: "room:GOA-12:rv3",
    kind: "ship",
    org: "goama",
    task: "GOA-12",
    taskTitle: "Update the onboarding docs",
    title: "Ready to ship: Update the onboarding docs",
    sentence: '@goama-writer finished "Update the onboarding docs" and waits for your review.',
    options: [
      { id: "merge", label: "Merge", primary: true },
      { id: "done", label: "Mark done" },
      { id: "changes", label: "Ask for changes", text: true },
    ],
    at: ago(25),
    link: { kind: "task", id: "GOA-12", item: "rv3" },
  },
  {
    id: "room:PRV-4:rv4",
    kind: "ship",
    task: "PRV-4",
    taskTitle: "Tidy the invoice template",
    title: "Ready to ship: Tidy the invoice template",
    sentence: '@majhi-builder finished "Tidy the invoice template" and waits for your review.',
    options: [
      { id: "merge", label: "Merge", primary: true },
      { id: "done", label: "Mark done" },
      { id: "changes", label: "Ask for changes", text: true },
    ],
    at: ago(70),
    link: { kind: "task", id: "PRV-4", item: "rv4" },
  },
  {
    id: "room:PYZ-33:rv5",
    kind: "ship",
    org: "pyzasoft",
    task: "PYZ-33",
    taskTitle: "Rename the shipping zones",
    title: "Ready to ship: Rename the shipping zones",
    sentence: '@pyzasoft-claude finished "Rename the shipping zones" and waits for your review.',
    options: [
      { id: "merge", label: "Merge", primary: true },
      { id: "done", label: "Mark done" },
      { id: "changes", label: "Ask for changes", text: true },
    ],
    at: ago(12),
    link: { kind: "task", id: "PYZ-33", item: "rv5" },
  },
  {
    id: "budget:pyzasoft:2026-10-04",
    kind: "budget",
    org: "pyzasoft",
    title: "Pyzasoft used its $20 for today. 3 tasks are waiting. Raise it to $40 for today?",
    sentence: "Pyzasoft used its $20 for today. 3 tasks are waiting. Raise it to $40 for today?",
    options: [
      { id: "raise", label: "Raise to $40 for today", primary: true },
      { id: "leave", label: "Leave it" },
    ],
    at: ago(10),
    link: { kind: "limits" },
  },
  {
    id: "room:GOA-7:ask1",
    kind: "question",
    org: "goama",
    task: "GOA-7",
    taskTitle: "Export orders to CSV",
    title: "@goama-builder asks: Which queue should the export use?",
    sentence:
      "@goama-builder asks: Which queue should the export use? Orders can reach 40,000 rows on a busy day.",
    options: [
      { id: "sqs", label: "SQS", primary: true },
      { id: "redis", label: "Redis" },
      { id: "inline", label: "No queue, export inline" },
      { id: "reply", label: "Write an answer", text: true },
    ],
    suggestion: { option: "sqs", reason: "The agent's suggestion", by: "agent" },
    at: ago(95),
    link: { kind: "task", id: "GOA-7", item: "ask1" },
  },
  {
    id: "room:IDZ-5:paused1",
    kind: "paused",
    org: "ideeza",
    task: "IDZ-5",
    taskTitle: "Migrate the billing job",
    title: "Paused: the account hit its usage limit",
    sentence: '"Migrate the billing job" paused: the account hit its usage limit.',
    options: [{ id: "resume", label: "Resume", primary: true }],
    at: ago(130),
    link: { kind: "task", id: "IDZ-5", item: "paused1" },
  },
  {
    id: "room:PRV-9:perm1",
    kind: "approval",
    task: "PRV-9",
    taskTitle: "Upgrade the scanner firmware",
    title: "@majhi-builder needs approval: Run pnpm install in packages/scanner-firmware-updater",
    sentence: "@majhi-builder needs your approval: Run pnpm install in packages/scanner-firmware-updater",
    options: [
      { id: "allow", label: "Allow once", primary: true },
      { id: "reject", label: "Reject" },
    ],
    at: ago(42),
    link: { kind: "task", id: "PRV-9", item: "perm1" },
  },
  {
    id: "signin:claude-pyzasoft",
    kind: "sign-in",
    title: "Sign in claude-pyzasoft: its agents cannot run until you do",
    sentence: "claude-pyzasoft is signed out. Its agents cannot run until you sign in again.",
    options: [],
    at: ago(300),
    link: { kind: "account", id: "claude-pyzasoft" },
  },
];

const HANDBACK = `Fixed. The checkout handler posted the order twice when the payment webhook arrived before the redirect.

- Added an idempotency key on \`orders.create\`
- The webhook now looks the order up first
- Two tests cover the early webhook and the double click

I ran the order tests and the lint. Nothing outside \`apps/shop\` changed.

One thing to know: orders created twice before this fix stay as they are. A one-off cleanup script is in \`scripts/dedupe-orders.ts\`, not run.

Next steps if you want them: a unique index on \`orders.payment_ref\`, and an alert when the same ref is seen twice.`;

const DETAILS: Record<string, DecisionDetail> = {
  "room:PYZ-31:rv1": {
    id: "room:PYZ-31:rv1",
    handback: { agent: "pyzasoft-claude", text: HANDBACK, at: ago(20) },
    diff: {
      files: 6,
      additions: 142,
      deletions: 17,
      top: [
        { path: "apps/shop/src/orders/create.ts", additions: 58, deletions: 9 },
        { path: "apps/shop/src/orders/create.test.ts", additions: 51, deletions: 0 },
        { path: "apps/shop/src/webhooks/payment.ts", additions: 22, deletions: 6 },
        { path: "scripts/dedupe-orders.ts", additions: 9, deletions: 0 },
        { path: "apps/shop/src/orders/index.ts", additions: 2, deletions: 2 },
      ],
      uncommitted: false,
    },
    repos: [{ project: "pyzasoft-shop", branch: "majhi/PYZ-31", into: "main" }],
    checks: "committed, merges cleanly into main, no card waits, no secret in the diff",
  },
  "room:IDZ-8:rv2": {
    id: "room:IDZ-8:rv2",
    handback: {
      agent: "ideeza-builder",
      text: "The export now runs as a background job and posts a link when it is done. Tests pass.",
      at: ago(50),
    },
    diff: {
      files: 3,
      additions: 64,
      deletions: 21,
      top: [{ path: "src/notes/export.ts", additions: 40, deletions: 18 }],
      uncommitted: false,
    },
    repos: [{ project: "ideeza-notes", branch: "majhi/IDZ-8", into: "main" }],
    checks: "committed, merges cleanly into main, no card waits",
  },
  "room:GOA-12:rv3": {
    id: "room:GOA-12:rv3",
    handback: {
      agent: "goama-writer",
      text: "I rewrote the first-day checklist and added a section on access requests. The screenshots are old; I left a note where each one needs replacing.",
      at: ago(30),
    },
    diff: {
      files: 4,
      additions: 96,
      deletions: 40,
      top: [
        { path: "docs/onboarding/first-day.md", additions: 60, deletions: 31 },
        { path: "docs/onboarding/access.md", additions: 36, deletions: 0 },
        { path: "docs/index.md", additions: 0, deletions: 9 },
      ],
      uncommitted: true,
    },
    repos: [{ project: "goama-docs", branch: "majhi/GOA-12", into: "main" }],
    blocked: { merge: "Some changes are not committed yet." },
  },
  "room:PRV-4:rv4": {
    id: "room:PRV-4:rv4",
    handback: { agent: "majhi-builder", text: "Spacing and fonts match the new brand sheet.", at: ago(75) },
    diff: {
      files: 1,
      additions: 12,
      deletions: 12,
      top: [{ path: "templates/invoice.html", additions: 12, deletions: 12 }],
      uncommitted: false,
    },
    repos: [{ project: "notes", branch: "majhi/PRV-4", into: "main" }],
  },
  "room:PYZ-33:rv5": {
    id: "room:PYZ-33:rv5",
    handback: {
      agent: "pyzasoft-claude",
      text: "Renamed the zones to the carrier's names. The old names stay as aliases for a release.",
      at: ago(14),
    },
    diff: {
      files: 2,
      additions: 30,
      deletions: 28,
      top: [{ path: "apps/shop/src/shipping/zones.ts", additions: 22, deletions: 20 }],
      uncommitted: false,
    },
    repos: [{ project: "pyzasoft-shop", branch: "majhi/PYZ-33", into: "main" }],
  },
  "room:GOA-7:ask1": {
    id: "room:GOA-7:ask1",
    handback: {
      agent: "goama-builder",
      text: "I measured the export on last week's data: 38,000 rows take 41 seconds inline, which times out behind the proxy. A queue fixes that. SQS is already in the stack for the invoices; Redis would be a new service to run.",
      at: ago(96),
    },
    questions: [
      {
        question: "Which queue should the export use?",
        options: ["SQS", "Redis", "No queue, export inline"],
        freeText: true,
      },
    ],
  },
  "room:IDZ-5:paused1": {
    id: "room:IDZ-5:paused1",
    handback: {
      agent: "ideeza-builder",
      text: "Stopped before the schema step. Nothing is half done.",
      at: ago(131),
    },
  },
};

async function stub(page: Page, decisions: OwnerDecision[]) {
  const calls: { name: string; body: unknown }[] = [];
  let left = decisions;
  await page.route("**/api/cmd/decisions.list", (r) => r.fulfill({ json: { decisions: left } }));
  await page.route("**/api/cmd/decisions.detail", (r) => {
    const { id } = r.request().postDataJSON() as { id: string };
    return r.fulfill({ json: DETAILS[id] ?? { id } });
  });
  await page.route("**/api/cmd/decisions.answer", (r) => {
    const body = r.request().postDataJSON() as { id: string };
    calls.push({ name: "decisions.answer", body });
    left = left.filter((d) => d.id !== body.id);
    return r.fulfill({ json: { decisions: left } });
  });
  await page.route("**/api/cmd/orgs.list", async (r) => {
    const real = (await (await r.fetch()).json()) as OrgView[];
    const extra = Object.entries(ORGS).map(
      ([id, o]) => ({ ...real[0], id, name: o.name, key: o.key, color: o.color }) as OrgView,
    );
    return r.fulfill({ json: [...real.filter((o) => !(o.id in ORGS)), ...extra] });
  });
  return { calls };
}

async function open(page: Page, path: string, w: number, h: number, theme: string, decisions = DECISIONS) {
  await page.setViewportSize({ width: w, height: h });
  const stubbed = await stub(page, decisions);
  await page.addInitScript(() => localStorage.removeItem("majhi.org"));
  await page.goto(path);
  await page.evaluate((t) => {
    document.documentElement.dataset.theme = t;
  }, theme);
  await page.waitForTimeout(700);
  return stubbed;
}

async function noPageScroll(page: Page) {
  const overflow = await page.evaluate(() => ({
    x: document.documentElement.scrollWidth - window.innerWidth,
    y: document.documentElement.scrollHeight - window.innerHeight,
  }));
  expect(overflow).toEqual({ x: 0, y: 0 });
}

const SIZES = [
  [1440, 900],
  [1280, 720],
  [1100, 760],
] as const;

for (const [w, h] of SIZES) {
  for (const theme of ["dark", "light"]) {
    test(`the queue with a selection ${w} ${theme}`, async ({ page }) => {
      await open(page, "/decisions?id=room:PYZ-31:rv1", w, h, theme);
      await expect(page.getByRole("heading", { name: "Shop orders created twice" })).toBeVisible();
      await expect(page.getByText("What @pyzasoft-claude said last")).toBeVisible();
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${SHOTS}/queue-${w}x${h}-${theme}.png` });
      await noPageScroll(page);
    });
    test(`the bell ${w} ${theme}`, async ({ page }) => {
      await open(page, "/", w, h, theme);
      await page.getByRole("button", { name: /^Decisions/ }).click();
      const panel = page.getByRole("dialog", { name: "Decisions" });
      await expect(panel.getByText("Shop orders created twice").first()).toBeVisible();
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${SHOTS}/bell-${w}x${h}-${theme}.png` });
      expect(await panel.evaluate((el) => el.scrollWidth - el.clientWidth)).toBe(0);
    });
  }
}

const KINDS: [string, string][] = [
  ["ship-ready", "room:PYZ-31:rv1"],
  ["ship-long-name", "room:IDZ-8:rv2"],
  ["review-blocked", "room:GOA-12:rv3"],
  ["review", "room:PYZ-33:rv5"],
  ["question", "room:GOA-7:ask1"],
  ["budget", "budget:pyzasoft:2026-10-04"],
  ["paused", "room:IDZ-5:paused1"],
  ["approval", "room:PRV-9:perm1"],
  ["sign-in", "signin:claude-pyzasoft"],
];

for (const theme of ["dark", "light"]) {
  test(`each kind's detail ${theme}`, async ({ page }) => {
    await open(page, "/decisions", 1440, 900, theme);
    for (const [name, id] of KINDS) {
      await page.locator(`[data-decision="${id}"]`).click();
      await page.waitForTimeout(350);
      await page.screenshot({ path: `${SHOTS}/kind-${name}-1440-${theme}.png` });
      await noPageScroll(page);
    }
  });
}

test("the reply box, the filters and the empty state", async ({ page }) => {
  await open(page, "/decisions?id=room:GOA-12:rv3", 1440, 900, "dark");
  await page.getByRole("button", { name: /Ask for changes/ }).click();
  await page.getByRole("textbox", { name: "Ask for changes" }).fill("Replace the old screenshots first.");
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/reply-1440-dark.png` });
  await page.getByRole("button", { name: /^Pyzasoft \d/ }).click();
  await page.getByRole("button", { name: /^Ship \d/ }).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/filtered-1440-dark.png` });
  await open(page, "/decisions", 1440, 900, "dark", []);
  await expect(page.getByText("Nothing needs you.")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/empty-1440-dark.png` });
});

test("the narrow layout: the queue, then one decision, then back", async ({ page }) => {
  await open(page, "/decisions", 900, 760, "dark");
  await expect(page.locator('[data-decision="room:PYZ-31:rv1"]')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/narrow-queue-900-dark.png` });
  await page.locator('[data-decision="room:PYZ-31:rv1"]').click();
  await expect(page.getByRole("heading", { name: "Shop orders created twice" })).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/narrow-detail-900-dark.png` });
  await noPageScroll(page);
  await page.getByRole("button", { name: "All decisions" }).click();
  await expect(page.locator('[data-decision="room:GOA-7:ask1"]')).toBeVisible();
});

test("keys move, pick an answer and the next decision is selected after it", async ({ page }) => {
  const { calls } = await open(page, "/decisions", 1440, 900, "dark");
  const current = () => page.locator('[data-decision][aria-current="true"]').getAttribute("data-decision");
  // The first of the queue is selected; the server sorted ship first.
  const first = await current();
  await page.keyboard.press("j");
  const second = await current();
  expect(second).not.toBe(first);
  await page.keyboard.press("k");
  expect(await current()).toBe(first);
  // Enter takes the main action of the first one, which is a merge.
  await page.keyboard.press("Enter");
  await expect.poll(() => calls.at(-1)?.body).toMatchObject({ id: first, option: "merge" });
  // The next decision of the queue is now selected.
  await expect.poll(current).toBe(second);
  // 2 picks the second answer: Mark done on a review, or the second option of another kind.
  await expect(page.getByRole("button", { name: /^Mark done/ })).toBeEnabled();
  await page.keyboard.press("2");
  await expect.poll(() => (calls.at(-1)?.body as { id?: string } | undefined)?.id).toBe(second);
  // R opens the reply box on a decision that takes words, and Esc closes it.
  await page.locator('[data-decision="room:GOA-7:ask1"]').click();
  await page.keyboard.press("r");
  await expect(page.getByRole("textbox", { name: "Write an answer" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("textbox", { name: "Write an answer" })).toBeHidden();
  // Ask for changes sends the words.
  await page.locator('[data-decision="room:GOA-12:rv3"]').click();
  await page.keyboard.press("r");
  await page.getByRole("textbox", { name: "Ask for changes" }).fill("Replace the old screenshots first.");
  await page.keyboard.press("Meta+Enter");
  await expect
    .poll(() => calls.at(-1)?.body)
    .toEqual({ id: "room:GOA-12:rv3", option: "changes", text: "Replace the old screenshots first." });
});

test("a bell row opens its decision on the page, and Open task still opens the task", async ({ page }) => {
  await open(page, "/", 1440, 900, "dark");
  await page.getByRole("button", { name: /^Decisions/ }).click();
  const panel = page.getByRole("dialog", { name: "Decisions" });
  await panel
    .locator('[data-decision="room:GOA-7:ask1"]')
    .getByRole("button", { name: "Export orders to CSV" })
    .or(panel.locator('[data-decision="room:GOA-7:ask1"]').getByRole("button", { name: /Which queue/ }))
    .click();
  await expect(page).toHaveURL(/\/decisions\?id=room(%3A|:)GOA-7(%3A|:)ask1/);
  await expect(page.locator('[data-decision="room:GOA-7:ask1"][aria-current="true"]')).toBeVisible();
  await page.getByRole("button", { name: /^Open task/ }).click();
  await expect(page).toHaveURL(/\/t\/GOA-7/);
});
