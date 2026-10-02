import { expect, type Page, test } from "@playwright/test";

/**
 * The Automations page against the seeded home: an empty page, a new schedule with its preview, the
 * list after Run now, the history drawer, then the same for a trigger. The tests share one server,
 * so they run in order.
 */
const OUT = process.env.AUTOMATION_SHOTS ?? "e2e/screenshots";

async function shot(page: Page, name: string) {
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/automations-${name}.png` });
}

test.describe.configure({ mode: "serial" });

test("an empty page, then a schedule with a Berlin clock", async ({ page }) => {
  await page.goto("/automations");
  await expect(page.getByRole("heading", { name: "No schedules yet" })).toBeVisible();
  await shot(page, "01-empty");

  await page.getByRole("button", { name: "New schedule" }).first().click();
  const form = page.getByRole("dialog", { name: "New schedule" });
  await form.getByLabel("Name", { exact: true }).fill("Nightly check");
  await form.getByLabel("Workspace", { exact: true }).selectOption({ label: "Globex" });
  await form.getByLabel("Phrase").fill("weekdays at 9:00");
  await form.getByLabel("Time zone").selectOption("Europe/Berlin");
  await form.getByLabel("Project").selectOption("alpha-api");
  await form.getByLabel("Title").fill("Nightly dependency check");
  await form.getByLabel("What the task should do").fill("Check for outdated dependencies and report.");
  await expect(form.getByText(/your time/).first()).toBeVisible();
  await shot(page, "02-schedule-form");

  await form.getByLabel("Phrase").fill("weekdays at 25:00");
  await expect(form.getByText(/not a time/)).toBeVisible();
  await shot(page, "03-schedule-form-error");
  await form.getByLabel("Phrase").fill("weekdays at 9:00");
  await form.getByRole("button", { name: "Create schedule" }).click();
  await expect(page.getByRole("button", { name: "Nightly check", exact: true })).toBeVisible();
  await shot(page, "04-schedules");
});

test("Run now, then the history", async ({ page }) => {
  await page.goto("/automations");
  await page.getByRole("button", { name: "Run now" }).first().click();
  await expect(page.getByText(/Never ran/)).toHaveCount(0, { timeout: 20_000 });
  await shot(page, "05-schedules-after-run");
  await page.getByRole("button", { name: "History of Nightly check" }).click();
  await expect(page.getByRole("dialog", { name: "History of Nightly check" })).toBeVisible();
  await shot(page, "06-schedule-history");
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Pause Nightly check" }).click();
  await expect(page.getByText("Paused").first()).toBeVisible();
  await shot(page, "07-schedule-paused");
});

test("a trigger, Run now and its history", async ({ page }) => {
  await page.goto("/automations?tab=triggers");
  await expect(page.getByRole("heading", { name: "No triggers yet" })).toBeVisible();
  await shot(page, "08-triggers-empty");

  await page.getByRole("button", { name: "New trigger" }).first().click();
  const form = page.getByRole("dialog", { name: "New trigger" });
  await form.getByLabel("Name", { exact: true }).fill("Follow up when a task is done");
  await form.getByLabel("Workspace", { exact: true }).selectOption({ label: "Globex" });
  await form.getByLabel("Fires when").selectOption("task.status");
  await form.getByLabel("Becomes").selectOption("done");
  await form.getByLabel("Project").selectOption("alpha-api");
  await form.getByLabel("Title").fill("Follow up");
  await form.getByLabel("What the task should do").fill("Review what finished: {{event}}");
  await shot(page, "09-trigger-form");
  await form.getByRole("button", { name: "Create trigger" }).click();
  await expect(
    page.getByRole("button", { name: "Follow up when a task is done", exact: true }),
  ).toBeVisible();
  await shot(page, "10-triggers");

  await page.getByRole("button", { name: "Run now" }).first().click();
  await expect(page.getByText(/Never ran/)).toHaveCount(0, { timeout: 20_000 });
  await page.getByRole("button", { name: "History of Follow up when a task is done" }).click();
  await shot(page, "11-trigger-history");
});
