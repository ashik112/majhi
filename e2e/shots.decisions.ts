import { expect, type Page, test } from "@playwright/test";
import type { OrgView, OwnerDecision } from "../packages/shared/src/index.ts";

/**
 * The Decisions inbox (SPEC 5.18): the bell's popover and the /decisions page, with every kind of
 * decision, several workspaces, a long workspace name and a captain recommendation. The server is the
 * seeded one (`ui`); the decisions and the extra workspace are stubbed in the browser.
 *
 * Screenshots go to SHOTS. Run: `pnpm exec playwright test -c playwright.decisions.config.ts`.
 */
const SHOTS = process.env.SHOTS ?? "/private/tmp/claude-501/decisions-shots";
const NOW = Date.now();
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const LONG = "Northwind Traders International Holdings and Logistics Group";

const DECISIONS: OwnerDecision[] = [
  {
    id: "room:ACM-12:review-1",
    kind: "ship",
    org: "acme",
    task: "ACM-12",
    taskTitle: "Add a health endpoint to the API",
    title: "Ready to ship",
    options: [{ id: "merge", label: "Merge", primary: true }],
    suggestion: {
      option: "merge",
      reason: "Checks pass, 3 files changed, nothing outside the API folder.",
      by: "captain",
    },
    at: ago(18),
    link: { kind: "task", id: "ACM-12", item: "review-1" },
  },
  {
    id: "budget:globex:2026-10-04",
    kind: "budget",
    org: "globex",
    title: "Globex used its $20 for today. 3 tasks are waiting. Raise it to $40 for today?",
    options: [
      { id: "raise", label: "Raise to $40 for today", primary: true },
      { id: "leave", label: "Leave it" },
    ],
    at: ago(10),
    link: { kind: "limits" },
  },
  {
    id: "budget:day:2026-10-04",
    kind: "budget",
    title: "Autonomous work used its $60 for today. 5 tasks are waiting. Raise it to $120 for today?",
    options: [
      { id: "raise", label: "Raise to $120 for today", primary: true },
      { id: "leave", label: "Leave it" },
    ],
    at: ago(5),
    link: { kind: "limits" },
  },
  {
    id: "room:ACM-3:ask-1",
    kind: "question",
    org: "acme",
    task: "ACM-3",
    taskTitle: "Clean the branch history",
    title:
      "@acme-builder asks: The branch has 41 commits with fixups. Clean the history before the merge request?",
    options: [
      { id: "rebuild", label: "Rebuild", primary: true },
      { id: "keep", label: "Keep the history" },
      { id: "squash", label: "Squash into one commit" },
    ],
    suggestion: { option: "rebuild", reason: "Keeps a backup branch, nothing pushed.", by: "captain" },
    at: ago(190),
    link: { kind: "task", id: "ACM-3", item: "ask-1" },
  },
  {
    id: "room:GLX-7:ask-2",
    kind: "question",
    org: "globex",
    task: "GLX-7",
    taskTitle: "Export orders to CSV",
    title: "@globex-builder asks: Which queue should the export use?",
    options: [
      { id: "sqs", label: "SQS", primary: true },
      { id: "redis", label: "Redis" },
    ],
    suggestion: { option: "sqs", reason: "The agent's suggestion", by: "agent" },
    at: ago(95),
    link: { kind: "task", id: "GLX-7", item: "ask-2" },
  },
  {
    id: "room:NWT-21:oq-1",
    kind: "question",
    org: "northwind",
    task: "NWT-21",
    taskTitle: "Reconcile the quarterly freight invoices against the carrier statements for every depot",
    title: "@northwind-lead is asking you something",
    options: [
      { id: "c0", label: "Yes, go ahead", primary: true },
      { id: "c1", label: "Not this quarter" },
    ],
    at: ago(60),
    link: { kind: "task", id: "NWT-21", item: "oq-1" },
  },
  {
    id: "room:NWT-22:perm-1",
    kind: "approval",
    org: "northwind",
    task: "NWT-22",
    taskTitle: "Upgrade the warehouse scanner firmware",
    title: "@northwind-builder needs approval: Run pnpm install in packages/scanner-firmware-updater",
    options: [
      { id: "allow", label: "Allow once", primary: true },
      { id: "allow_always", label: "Always allow" },
      { id: "reject", label: "Reject" },
    ],
    at: ago(42),
    link: { kind: "task", id: "NWT-22", item: "perm-1" },
  },
  {
    id: "room:PRV-4:appr-1",
    kind: "approval",
    task: "PRV-4",
    taskTitle: "Set up a workspace for Initech",
    title: "Create org Initech (key INI)",
    options: [
      { id: "approve", label: "Approve", primary: true },
      { id: "reject", label: "Reject" },
    ],
    at: ago(33),
    link: { kind: "task", id: "PRV-4", item: "appr-1" },
  },
  {
    id: "room:ACM-9:review-2",
    kind: "ship",
    org: "acme",
    task: "ACM-9",
    taskTitle: "Update the onboarding docs",
    title: "Ready for review",
    options: [],
    at: ago(25),
    link: { kind: "task", id: "ACM-9", item: "review-2" },
  },
  {
    id: "room:GLX-5:paused-1",
    kind: "paused",
    org: "globex",
    task: "GLX-5",
    taskTitle: "Migrate the billing job",
    title: "Paused: the account hit its usage limit",
    options: [{ id: "resume", label: "Resume", primary: true }],
    at: ago(130),
    link: { kind: "task", id: "GLX-5", item: "paused-1" },
  },
  {
    id: "cap:acme:memory:2026-10-04",
    kind: "cap",
    org: "acme",
    title: "Acme: the captain answered its 20 questions for today. Raise the limit to 40 for today?",
    options: [
      { id: "raise", label: "Raise to 40 for today", primary: true },
      { id: "leave", label: "Leave it" },
    ],
    at: ago(240),
    link: { kind: "captain" },
  },
  {
    id: "room:ACM-3:secret-1",
    kind: "secret",
    org: "acme",
    task: "ACM-3",
    taskTitle: "Clean the branch history",
    title: "@acme-builder needs a secret: Stripe test key",
    options: [],
    at: ago(22),
    link: { kind: "task", id: "ACM-3", item: "secret-1" },
  },
  {
    id: "signin:claude-acme",
    kind: "sign-in",
    title: "Sign in claude-acme: its agents cannot run until you do",
    options: [],
    at: ago(300),
    link: { kind: "account", id: "claude-acme" },
  },
];

async function stub(page: Page, decisions: OwnerDecision[]) {
  const calls: { name: string; body: unknown }[] = [];
  let left = decisions;
  await page.route("**/api/cmd/decisions.list", (r) => r.fulfill({ json: { decisions: left } }));
  await page.route("**/api/cmd/decisions.answer", (r) => {
    const body = r.request().postDataJSON() as { id: string };
    calls.push({ name: "decisions.answer", body });
    left = left.filter((d) => d.id !== body.id);
    return r.fulfill({ json: { decisions: left } });
  });
  // The seeded workspaces, plus one with a very long name.
  await page.route("**/api/cmd/orgs.list", async (r) => {
    const real = (await (await r.fetch()).json()) as OrgView[];
    const extra = { ...real[0], id: "northwind", name: LONG, key: "NWT", color: "#4f9d8a" } as OrgView;
    return r.fulfill({ json: [...real.filter((o) => o.id !== "northwind"), extra] });
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

for (const [w, h] of [
  [1440, 900],
  [1100, 760],
] as const) {
  for (const theme of ["dark", "light"]) {
    test(`the bell ${w} ${theme}`, async ({ page }) => {
      await open(page, "/", w, h, theme);
      await page.getByRole("button", { name: /^Decisions/ }).click();
      const panel = page.getByRole("dialog", { name: "Decisions" });
      await expect(panel.getByText("Ready to ship").first()).toBeVisible();
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${SHOTS}/bell-${w}-${theme}.png` });
      // No row may spill out of the popover sideways.
      const spill = await panel.evaluate((el) => el.scrollWidth - el.clientWidth);
      expect(spill).toBe(0);
    });
    test(`the page ${w} ${theme}`, async ({ page }) => {
      await open(page, "/decisions", w, h, theme);
      await expect(page.getByRole("heading", { name: "Decisions" })).toBeVisible();
      await page.screenshot({ path: `${SHOTS}/page-${w}-${theme}.png` });
      await noPageScroll(page);
      // The long lower half of the list too.
      await page
        .locator("main, [role=main]")
        .first()
        .evaluate((el) => el.scrollTo?.(0, 99999));
      await page.getByText("Sign in claude-acme").scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${SHOTS}/page-end-${w}-${theme}.png` });
    });
  }
}

test("the page filtered to one workspace, and the empty state", async ({ page }) => {
  await open(page, "/decisions", 1440, 900, "dark");
  await page.getByRole("button", { name: /^Globex/ }).click();
  await expect(page.getByText("Which queue should the export use?")).toBeVisible();
  await expect(page.getByText("Create org Initech")).toBeHidden();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/page-globex-1440-dark.png` });
  await open(page, "/decisions", 1440, 900, "dark", []);
  await expect(page.getByText("Nothing needs you.").first()).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/page-empty-1440-dark.png` });
});

test("answering from the bell asks the server and removes the row", async ({ page }) => {
  const { calls } = await open(page, "/", 1440, 900, "dark");
  await page.getByRole("button", { name: /^Decisions/ }).click();
  const panel = page.getByRole("dialog", { name: "Decisions" });
  const row = panel.locator('[data-decision="room:ACM-3:ask-1"]');
  await expect(row.getByText("Captain recommends")).toBeVisible();
  await row.getByRole("button", { name: "Rebuild", exact: true }).click();
  await expect
    .poll(() => calls.find((c) => c.name === "decisions.answer")?.body)
    .toEqual({ id: "room:ACM-3:ask-1", option: "rebuild" });
  await expect(row).toBeHidden();
});

test("Open task still opens the task, and a sign-in opens Accounts", async ({ page }) => {
  await open(page, "/decisions", 1440, 900, "dark");
  await page.locator('[data-decision="room:GLX-7:ask-2"]').getByRole("button", { name: "Open task" }).click();
  await expect(page).toHaveURL(/\/t\/GLX-7/);
  await page.goto("/decisions");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/accounts/);
});
