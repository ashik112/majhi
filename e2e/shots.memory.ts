import { expect, type Page, test } from "@playwright/test";

/**
 * The Memory screens against a home seeded by `e2e/memory-seed.ts`: the Studio page (filters,
 * search, Approve, Undo, Pin, Forget, To AGENTS.md), the task's Memory tab and the Hub setup section.
 * The tests share one server and change its facts, so they run in order.
 */
const OUT = process.env.MEMORY_SHOTS ?? "e2e/screenshots";
const shot = (page: Page, name: string) => page.screenshot({ path: `${OUT}/memory-${name}.png` });
const DONE = "GLX-1";
const OPEN = "GLX-2";

const PNPM = "Use pnpm, not npm, to install packages in alpha-api";
const STAGING = "Deploys to staging are cut from a release/* branch";
const ACME = "Acme reviews every change with two people";

/** A fact's words in the list of facts, not in the log of automatic decisions below it. */
const inFacts = (page: Page, text: string) =>
  page.getByRole("list", { name: "Facts", exact: true }).getByText(text, { exact: true });

test.describe.configure({ mode: "serial" });

test("the page: filters, search, Approve", async ({ page }) => {
  await page.goto("/memory");
  await expect(page.getByRole("heading", { name: "Memory", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: /Memory\s*\d+ to review/ })).toBeVisible();
  await expect(inFacts(page, PNPM)).toBeVisible();
  await page.waitForTimeout(400);
  await shot(page, "01-all");

  await page.getByRole("tab", { name: /^Needs review/ }).click();
  await expect(inFacts(page, STAGING)).toBeVisible();
  await expect(inFacts(page, PNPM)).toHaveCount(0);
  await shot(page, "02-needs-review");

  await page.getByRole("button", { name: `Approve: ${STAGING}` }).click();
  await expect(inFacts(page, STAGING)).toHaveCount(0);

  await page.getByRole("tab", { name: /^All/ }).click();
  await page.getByRole("searchbox", { name: "Search memory" }).fill("pnpm install packages");
  await expect(page.getByText(/1 match/)).toBeVisible();
  await expect(inFacts(page, PNPM)).toBeVisible();
  await shot(page, "03-search");
});

test("automatic decisions: Undo, and Pin", async ({ page }) => {
  await page.goto("/memory");
  const log = page.getByRole("region", { name: "Recent automatic decisions" });
  await expect(log.getByText("A lasting convention for this repo, not task chatter.")).toBeVisible();
  await expect(log.getByText(/93% sure/)).toBeVisible();
  await log.scrollIntoViewIfNeeded();
  await shot(page, "04-auto-decisions");

  await log.getByRole("button", { name: `Undo: Kept ${PNPM}` }).click();
  await expect(log.getByText("Undone", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: /^Needs review/ }).click();
  await expect(inFacts(page, PNPM)).toBeVisible();
  await shot(page, "05-after-undo");
  await page.getByRole("button", { name: `Approve: ${PNPM}` }).click();

  await page.getByRole("tab", { name: /^All/ }).click();
  await page.getByRole("button", { name: `Pin: ${PNPM}` }).click();
  await expect(page.getByRole("button", { name: `Unpin: ${PNPM}` })).toBeVisible();
  await shot(page, "06-pinned");
});

test("Forget and To AGENTS.md ask first", async ({ page }) => {
  await page.goto("/memory");
  await page.getByRole("button", { name: `Forget: ${ACME}` }).click();
  await expect(page.getByRole("heading", { name: "Forget this fact?" })).toBeVisible();
  await page.waitForTimeout(400);
  await shot(page, "07-forget-confirm");
  await page.getByRole("button", { name: "Forget", exact: true }).click();
  await expect(inFacts(page, ACME)).toHaveCount(0);

  await page.getByRole("button", { name: `To AGENTS.md: ${PNPM}` }).click();
  await expect(page.getByRole("heading", { name: "Add this fact to AGENTS.md?" })).toBeVisible();
  await page.waitForTimeout(400);
  await shot(page, "08-agents-md-confirm");
  await page.getByRole("button", { name: "Make the task" }).click();
  // The task is made in the repo, which takes a moment; an error would stay in the dialog.
  await expect(page.getByRole("heading", { name: "Add this fact to AGENTS.md?" })).toHaveCount(0, {
    timeout: 20_000,
  });
  await expect(
    page
      .getByRole("listitem")
      .filter({ hasText: PNPM })
      .getByText(/^In AGENTS.md via/),
  ).toBeVisible();
  await shot(page, "09-after-agents-md");

  await page.getByRole("tab", { name: /^Globex/ }).click();
  await expect(inFacts(page, PNPM)).toBeVisible();
  await expect(
    page.getByRole("list", { name: "Facts", exact: true }).getByText("beta-web builds need bun 1.2 or newer"),
  ).toHaveCount(0);
  await shot(page, "10-org-filter");
});

test("the task's Memory tab", async ({ page }) => {
  await page.goto(`/t/${DONE}`);
  await page.getByRole("button", { name: /^Memory/ }).click();
  await expect(page.getByRole("region", { name: "Memory of this task" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Extract again" })).toBeVisible();
  await page.waitForTimeout(400);
  await shot(page, "11-task-memory-done");
  await page.getByRole("button", { name: "Extract again" }).click();
  await page.waitForTimeout(1500);
  await shot(page, "12-task-extract");

  await page.goto(`/t/${OPEN}`);
  await page.getByRole("button", { name: /^Memory/ }).click();
  await expect(page.getByText("The api serves /health without a login")).toBeVisible();
  await expect(page.getByRole("button", { name: "Extract again" })).toHaveCount(0);
  await shot(page, "13-task-memory-open");
});

test("Hub setup: the Memory section", async ({ page }) => {
  await page.goto("/setup");
  const section = page.getByRole("region", { name: "Memory" });
  await section.scrollIntoViewIfNeeded();
  await expect(section.getByText("Keep or drop on its own at")).toBeVisible();
  await shot(page, "14-setup-memory");

  const threshold = section.getByLabel("Keep or drop on its own at");
  await threshold.fill("0.3");
  await section.getByRole("button", { name: "Save memory settings" }).click();
  await expect(section.getByText("Use a number from 0.5 to 1.")).toBeVisible();
  await shot(page, "15-setup-invalid");

  await threshold.fill("0.9");
  await section.getByRole("switch", { name: "Review every fact" }).click();
  await section.getByLabel("Housekeeper", { exact: true }).selectOption("globex-reviewer");
  await section.getByRole("button", { name: "Save memory settings" }).click();
  await expect(page.getByText("Memory settings saved")).toBeVisible();

  await page.reload();
  const again = page.getByRole("region", { name: "Memory" });
  await again.scrollIntoViewIfNeeded();
  await expect(again.getByLabel("Keep or drop on its own at")).toHaveValue("0.9");
  await expect(again.getByRole("switch", { name: "Review every fact" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(again.getByLabel("Housekeeper", { exact: true })).toHaveValue("globex-reviewer");
  await shot(page, "16-setup-saved");
});
