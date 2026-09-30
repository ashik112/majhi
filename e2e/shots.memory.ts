import { expect, type Page, test } from "@playwright/test";

/**
 * The Memory screens against a home seeded by `e2e/memory-seed.ts`: the Brief, Tasks, Threads and
 * Lessons tabs, each at 1440 and 1100 wide, the steps each one offers (Restore this version, Close a
 * thread and Undo, Approve all), the task's Memory tab and the Hub setup section.
 * The tests share one server and change its memory, so they run in order.
 */
const OUT = process.env.MEMORY_SHOTS ?? "e2e/screenshots";
const DONE = "GLX-1";
const OPEN = "GLX-2";

async function shots(page: Page, name: string) {
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/memory-${name}-1440.png` });
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/memory-${name}-1100.png` });
  await page.setViewportSize({ width: 1440, height: 900 });
}

const tab = (page: Page, name: string) => page.getByRole("tab", { name: new RegExp(`^${name}`) });

test.describe.configure({ mode: "serial" });

test("Brief: the current brief, its history and Restore this version", async ({ page }) => {
  await page.goto("/memory");
  await tab(page, "Brief").click();
  await page.getByRole("combobox", { name: "Project" }).selectOption("alpha-api");
  const brief = page.getByRole("article", { name: "Brief of alpha-api" });
  await expect(brief.getByText(/request id/)).toBeVisible();
  await shots(page, "01-brief");

  const history = page.getByRole("region", { name: "Earlier versions" });
  await history.getByRole("button", { name: "Show" }).first().click();
  await shots(page, "02-brief-history");
  await history.getByRole("button", { name: "Restore this version" }).last().click();
  await expect(page.getByRole("heading", { name: "Restore version 1?" })).toBeVisible();
  await page.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(page.getByText(/Restored from version 1/).first()).toBeVisible();
  await expect(brief.getByText("The health check is on the root route.", { exact: false })).toBeVisible();

  await page.getByRole("combobox", { name: "Project" }).selectOption("beta-web");
  await expect(page.getByRole("button", { name: "Build it now" })).toBeVisible();
  await shots(page, "03-brief-empty");
});

test("Tasks: the records timeline and search", async ({ page }) => {
  await page.goto("/memory");
  await tab(page, "Tasks").click();
  const list = page.getByRole("list", { name: "Task records" });
  await expect(list.getByRole("article")).toHaveCount(3);
  await shots(page, "04-tasks");
  await list
    .getByRole("button", { name: /Show all/ })
    .first()
    .click();
  await page.getByRole("searchbox", { name: "Search task records" }).fill("health check route");
  // The first search may wait for the embedding model to load.
  await expect(
    page
      .getByRole("list", { name: "Task records" })
      .getByText(/own route/)
      .first(),
  ).toBeVisible({
    timeout: 45_000,
  });
  await shots(page, "05-tasks-search");
});

test("Threads: open per project, Close and Undo, the closed ones", async ({ page }) => {
  await page.goto("/memory");
  await tab(page, "Threads").click();
  const probe = "Point the readiness probe in deploy/k8s.yaml at /health";
  await expect(page.getByText(probe)).toBeVisible();
  await shots(page, "06-threads");
  await page.getByRole("button", { name: `Close: ${probe}` }).click();
  await expect(page.getByRole("button", { name: `Reopen: ${probe}` })).toBeVisible();
  await page.getByRole("region", { name: "Closed threads" }).getByRole("button", { name: /^Show/ }).click();
  await shots(page, "07-threads-closed");
  await page
    .getByRole("button", { name: `Reopen: ${probe}` })
    .first()
    .click();
});

test("Lessons: scopes, the review list with Approve all and Reject all", async ({ page }) => {
  await page.goto("/memory");
  await tab(page, "Lessons").click();
  await expect(page.getByRole("list", { name: "Lessons" })).toBeVisible();
  await shots(page, "08-lessons");
  await page.getByRole("button", { name: /^Needs review/ }).click();
  await expect(page.getByRole("button", { name: "Approve all" })).toBeVisible();
  await shots(page, "09-lessons-review");
  await page.getByRole("button", { name: "Reject all" }).click();
  await expect(page.getByRole("heading", { name: /^Reject \d/ })).toBeVisible();
  await shots(page, "10-lessons-reject-all");
  await page.getByRole("button", { name: "Reject all" }).last().click();
  await expect(page.getByRole("button", { name: "Approve all" })).toHaveCount(0);
});

test("the task's Memory tab shows its record", async ({ page }) => {
  await page.goto(`/t/${DONE}`);
  await page.getByRole("button", { name: /^Memory/ }).click();
  const region = page.getByRole("region", { name: "Memory of this task" });
  await expect(region.getByText(/Install section to README.md/)).toBeVisible();
  await expect(region.getByRole("button", { name: "Write again" })).toBeVisible();
  await shots(page, "11-task-memory-done");

  await page.goto(`/t/${OPEN}`);
  await page.getByRole("button", { name: /^Memory/ }).click();
  await expect(page.getByText("The api serves /health without a login")).toBeVisible();
  await shots(page, "12-task-memory-open");
});

test("Hub setup: the Memory section", async ({ page }) => {
  await page.goto("/setup");
  const section = page.getByRole("region", { name: "Memory" });
  await section.scrollIntoViewIfNeeded();
  await expect(section.getByText("Keep or drop on its own above")).toBeVisible();
  await shots(page, "13-setup-memory");
});
