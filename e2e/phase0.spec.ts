import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { HOST_HOME, MAJHI_HOME } from "./fixture.ts";

// One server, one majhi.yaml: each test builds on the state the previous one left.
test.describe.configure({ mode: "serial" });

const shot = (page: Page, name: string) => page.screenshot({ path: `e2e/screenshots/${name}.png` });
const rows = (page: Page) => page.locator("[data-repo-row]");
const row = (page: Page, name: string) => rows(page).filter({ hasText: name });

test("first run: pick ~/Work and see its repos with their hosts", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Pick your workspace roots" })).toBeVisible();
  const progress = page.getByRole("navigation", { name: "Setup progress" });
  await expect(progress).toContainText(/Step 1 of \d+/);
  await expect(progress.locator('[aria-current="step"]')).toHaveText("Workspace roots");

  const root = page.getByRole("textbox", { name: "Workspace root 1" });
  await expect(root).toBeFocused();
  await root.fill("~/Work");
  await shot(page, "onboarding");
  await page.getByRole("button", { name: /Save roots/ }).click();

  await expect(page.getByRole("heading", { name: "Repos", exact: true })).toBeVisible();
  await expect(rows(page)).toHaveCount(3);
  await expect(row(page, "alpha-api")).toContainText("GitHub");
  await expect(row(page, "beta-web")).toContainText("GitLab");
  await expect(row(page, "beta-web")).toContainText("develop");
  await expect(row(page, "gamma-infra")).toContainText("Bitbucket");
  await expect(row(page, "gamma-infra")).toContainText("bitbucket-acme");
  await expect(row(page, "gamma-infra")).toContainText("ops/gamma-infra");

  await expect(page.getByText("Roots saved")).toBeHidden();
  await shot(page, "repos");
});

test("a root that is not mounted shows the restart card with make up", async ({ page }) => {
  await page.goto("/settings/roots");
  const first = page.getByRole("textbox", { name: "Workspace root 1" });
  await expect(first).toHaveValue("~/Work");

  // Enter on a filled row adds the next row and focuses it.
  await first.press("End");
  await first.press("Enter");
  const second = page.getByRole("textbox", { name: "Workspace root 2" });
  await expect(second).toBeFocused();
  await second.fill("~/Missing");
  await page.getByRole("button", { name: /Save changes/ }).click();

  const card = page.getByRole("region", { name: /Restart majhi/ });
  await expect(card).toBeVisible();
  await expect(card.getByRole("list", { name: "Roots not mounted yet" })).toHaveText(/~\/Missing/);
  await expect(card.getByText("make up", { exact: true })).toBeVisible();
  await expect(card.getByRole("button", { name: "Reload" })).toBeVisible();
  // Let the entrance motion settle so the capture shows the resting card.
  await expect(card).toHaveCSS("opacity", "1");
  await expect(card).toHaveCSS("transform", "none");
  await shot(page, "unmounted");

  await card.getByRole("button", { name: "Show repos now" }).click();
  const missing = page.getByRole("region", { name: "~/Missing" });
  await expect(missing).toContainText("not mounted");
  await expect(missing).toContainText("make up");
  await expect(rows(page)).toHaveCount(3);
});

test("search filters repos and / focuses it", async ({ page }) => {
  await page.goto("/");
  await expect(rows(page)).toHaveCount(3);

  await page.keyboard.press("/");
  const search = page.getByRole("searchbox", { name: "Search repos" });
  await expect(search).toBeFocused();

  await page.keyboard.type("gitlab");
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page)).toContainText("beta-web");
  await expect(page.getByRole("region", { name: "~/Missing" })).toHaveCount(0);

  await search.fill("infra");
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).locator("mark").first()).toHaveText("infra");
  await shot(page, "search");

  await search.fill("nothing-like-this");
  await expect(page.getByRole("heading", { name: /No repos match/ })).toBeVisible();

  await search.press("Escape");
  await expect(search).toHaveValue("");
  await expect(rows(page)).toHaveCount(3);
});

test("j moves the selection and Enter copies the repo path", async ({ page }) => {
  await page.goto("/");
  await expect(rows(page)).toHaveCount(3);
  await expect(row(page, "alpha-api")).toHaveAttribute("aria-current", "true");

  await page.keyboard.press("j");
  await expect(row(page, "beta-web")).toHaveAttribute("aria-current", "true");
  await expect(page.getByRole("complementary", { name: "Repo details" })).toContainText(
    "https://gitlab.com/acme/beta-web.git",
  );

  await page.keyboard.press("Enter");
  await expect(page.getByText("Copied", { exact: true })).toBeVisible();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toBe(join(HOST_HOME, "Work", "beta-web"));
});

test("a broken majhi.yaml shows the file and each error, and Retry recovers", async ({ page }) => {
  const file = join(MAJHI_HOME, "majhi.yaml");
  const good = readFileSync(file, "utf8");
  writeFileSync(file, "workspaces: []\ntasks_dir: tasks\nsurprise: true\n");
  try {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "majhi.yaml has errors" })).toBeVisible();
    await expect(page.getByText("~/.majhi/majhi.yaml")).toBeVisible();
    const errors = page.getByRole("region", { name: /errors/ }).getByRole("listitem");
    await expect(errors).toHaveCount(3);
    await expect(errors.filter({ hasText: "surprise" })).toHaveCount(1);
    await shot(page, "config-error");
  } finally {
    writeFileSync(file, good);
  }

  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByRole("heading", { name: "Repos", exact: true })).toBeVisible();
  await expect(rows(page)).toHaveCount(3);
});
