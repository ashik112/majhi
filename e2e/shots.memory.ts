import { expect, type Page, test } from "@playwright/test";

/**
 * The Memory screens against a home seeded by `e2e/memory-seed.ts`: a project's Brief, Tasks,
 * Threads and Lessons tabs, each at 1440 and 1100 wide, the steps each one offers (Restore, Close a
 * thread and Undo, Reject all), the task's Memory tab and the Hub setup Memory section.
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
const panel = (page: Page) => page.getByRole("tabpanel");

test.describe.configure({ mode: "serial" });

test("Brief: the sections, the history and Restore", async ({ page }) => {
  await page.goto("/memory?project=alpha-api&tab=brief");
  await expect(panel(page).getByRole("region", { name: "Current state" })).toContainText(/request id/);
  await shots(page, "01-brief");

  const history = page.getByRole("region", { name: "History" });
  await history.getByRole("button", { name: "Show" }).first().click();
  await shots(page, "02-brief-history");
  await history.getByRole("button", { name: "Restore" }).last().click();
  await expect(page.getByRole("heading", { name: "Restore version 1?" })).toBeVisible();
  await page.getByRole("button", { name: "Restore", exact: true }).last().click();
  await expect(page.getByText(/restored from v1/).first()).toBeVisible();
  await expect(
    panel(page).getByText("The health check is on the root route.", { exact: false }),
  ).toBeVisible();

  await page.getByRole("button", { name: /^beta-web/ }).click();
  await expect(page.getByRole("button", { name: "Build the brief" })).toBeVisible();
  await shots(page, "03-brief-empty");
});

test("Tasks: compact records that open, and search", async ({ page }) => {
  await page.goto("/memory?project=alpha-api&tab=tasks");
  const list = page.getByRole("list", { name: "Task records" });
  await expect(list.getByRole("listitem")).toHaveCount(3);
  await list
    .getByRole("button", { name: /^Show the record of/ })
    .first()
    .click();
  await shots(page, "04-tasks");
  await page.getByRole("searchbox", { name: "Search task records" }).fill("health check route");
  // The first search may wait for the embedding model to load.
  await expect(list.getByText(/own route/).first()).toBeVisible({ timeout: 45_000 });
  await shots(page, "05-tasks-search");
});

test("Threads: a checklist, Close and Undo, the closed ones", async ({ page }) => {
  await page.goto("/memory?project=alpha-api&tab=threads");
  const probe = "Point the readiness probe in deploy/k8s.yaml at /health";
  await expect(page.getByText(probe)).toBeVisible();
  await shots(page, "06-threads");
  await page.getByRole("checkbox", { name: `Close: ${probe}` }).check();
  await expect(page.getByRole("checkbox", { name: `Reopen: ${probe}` })).toBeChecked();
  await page.getByRole("region", { name: "Closed" }).getByRole("button", { name: "Show" }).click();
  await shots(page, "07-threads-closed");
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByRole("checkbox", { name: `Close: ${probe}` })).not.toBeChecked();
});

test("Lessons: the sidebar count opens the review, Reject all asks first", async ({ page }) => {
  await page.goto("/memory");
  await page.getByRole("link", { name: /to review$/ }).click();
  await expect(tab(page, "Lessons")).toHaveAttribute("aria-selected", "true");
  const waiting = page.getByRole("region", { name: "Waiting for you" });
  await expect(waiting.getByRole("button", { name: "Approve all" })).toBeVisible();
  await shots(page, "08-lessons-review");
  await waiting.getByRole("button", { name: "Reject all" }).click();
  await expect(page.getByRole("heading", { name: /^Reject \d/ })).toBeVisible();
  await shots(page, "09-lessons-reject-all");
  await page.getByRole("button", { name: "Reject all" }).last().click();
  await expect(page.getByRole("region", { name: "Waiting for you" })).toHaveCount(0);
  await page.goto("/memory?project=alpha-api&tab=lessons");
  await expect(page.getByRole("list", { name: "Active lessons" })).toBeVisible();
  await shots(page, "10-lessons-active");
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
  await page.goto("/setup?section=memory");
  await expect(page.getByText("Keep or drop on its own above")).toBeVisible();
  await shots(page, "13-setup-memory");
});
