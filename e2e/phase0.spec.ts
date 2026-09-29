import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { HOST_HOME, MAJHI_HOME } from "./fixture.ts";

// One server, one majhi.yaml: each test builds on the state the previous one left.
test.describe.configure({ mode: "serial" });

// Setup now goes on to accounts and the boss. Phase 0 is about roots and repos, so every test after
// the first run behaves like an owner who skipped that part.
test.beforeEach(async ({ context }, info) => {
  if (info.title.startsWith("first run")) return;
  await context.addInitScript(() => window.localStorage.setItem("majhi.setup.skipped", "1"));
});

const shot = (page: Page, name: string) => page.screenshot({ path: `e2e/screenshots/${name}.png` });
const rows = (page: Page) => page.locator("[data-repo-row]");
const row = (page: Page, name: string) => rows(page).filter({ hasText: name });
const chosenRoots = (page: Page) => page.getByRole("list", { name: "Roots", exact: true });
const folders = (page: Page, where: string) => page.getByRole("listbox", { name: `Folders in ${where}` });

/** The helper connects a moment after `/health` answers; tests that browse folders wait for it. */
async function waitForHelper(request: APIRequestContext) {
  await expect
    .poll(async () => {
      const res = await request.post("/api/cmd/host.status", { data: {} });
      return ((await res.json()) as { connected: boolean }).connected;
    })
    .toBe(true);
}

test("first run: suggestions list folders with repos, and one click on ~/Work sets it up", async ({
  page,
  request,
}) => {
  await waitForHelper(request);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Pick your workspace roots" })).toBeVisible();
  const progress = page.getByRole("navigation", { name: "Setup progress" });
  await expect(progress).toContainText(/Step 1 of \d+/);
  await expect(progress.locator('[aria-current="step"]')).toHaveText("Workspace roots");

  const suggested = page.getByRole("list", { name: "Suggested" });
  const work = suggested.getByRole("button", { name: "~/Work, 3 repos" });
  await expect(suggested.getByRole("button")).toHaveCount(2);
  await expect(suggested.getByRole("button", { name: "~/Projects, 1 repo" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await expect(work).toBeFocused();
  await expect(work).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByText("None yet.")).toBeVisible();
  await shot(page, "onboarding");

  await work.click();
  await expect(work).toHaveAttribute("aria-pressed", "true");
  await expect(chosenRoots(page).getByRole("listitem")).toHaveText([/^~\/Work/]);
  await page.getByRole("button", { name: /Save roots/ }).click();

  // Step 2 (first account) follows; Phase 0 only cares about the repos, so skip the rest of setup.
  await expect(progress).toContainText("Step 2 of 3");
  await page.getByRole("button", { name: "Skip for now" }).click();

  // Home is the task screen now; the repos list is its own view.
  await expect(page.getByRole("heading", { name: "Pick a task, or write a new one" })).toBeVisible();
  await page.getByRole("link", { name: "Repos" }).click();
  await expect(page).toHaveURL(/\/repos$/);
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

test("the folder browser marks repos, goes up with Backspace, and adds the folder on screen", async ({
  page,
  request,
}) => {
  await waitForHelper(request);
  await page.goto("/settings/roots");
  await expect(chosenRoots(page).getByRole("listitem")).toHaveText([/^~\/Work/]);

  await page.getByRole("button", { name: "Browse folders" }).click();
  const filter = page.getByRole("combobox", { name: "Filter folders" });
  await expect(filter).toBeFocused();
  const home = folders(page, "~");
  await expect(home.getByRole("option", { name: "Work, 3 repos, already a root" })).toBeVisible();
  await expect(home.getByRole("option", { name: "Empty", exact: true })).toBeVisible();
  // The home folder itself is too wide to mount.
  await expect(page.getByRole("button", { name: /Use this folder/ })).toBeDisabled();

  await home.getByRole("option", { name: /^Work,/ }).click();
  const work = folders(page, "~/Work");
  await expect(work.getByRole("option", { name: "alpha-api, git repo" })).toBeVisible();
  await expect(work.getByRole("option", { name: "beta-web, git repo" })).toBeVisible();
  await expect(work.getByRole("option", { name: "ops", exact: true })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Folder path" })).toHaveText(/~\s*Work/);
  await expect(page.getByRole("button", { name: /Use this folder/ })).toBeDisabled();
  await shot(page, "folder-browser");

  // Backspace in the empty filter goes up and puts the cursor back on the folder it came from.
  await filter.press("Backspace");
  await expect(home.getByRole("option", { name: /^Work,/ })).toHaveAttribute("aria-selected", "true");

  await home.getByRole("option", { name: "Projects, 1 repo" }).click();
  await expect(
    folders(page, "~/Projects").getByRole("option", { name: "delta-app, git repo" }),
  ).toBeVisible();
  await page.getByRole("button", { name: /Use this folder/ }).click();

  await expect(filter).toBeHidden();
  await expect(page.getByRole("button", { name: "Browse folders" })).toBeFocused();
  await expect(chosenRoots(page).getByRole("listitem")).toHaveText([/^~\/Work/, /^~\/Projects/]);
  await page.getByRole("button", { name: /Save changes/ }).click();

  await expect(page.getByRole("heading", { name: "Repos", exact: true })).toBeVisible();
  await expect(rows(page)).toHaveCount(4);
  await expect(row(page, "delta-app")).toContainText("GitHub");
});

test("roots can be picked with the keyboard alone", async ({ page, request }) => {
  await waitForHelper(request);
  await page.goto("/settings/roots");
  const suggested = page.getByRole("list", { name: "Suggested" });
  await expect(suggested.getByRole("button", { name: "~/Work, 3 repos" })).toBeFocused();

  // Arrow to ~/Projects and remove it; it is a toggle.
  await page.keyboard.press("ArrowDown");
  const projects = suggested.getByRole("button", { name: "~/Projects, 1 repo" });
  await expect(projects).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(projects).toHaveAttribute("aria-pressed", "false");
  await expect(chosenRoots(page).getByRole("listitem")).toHaveText([/^~\/Work/]);

  // Esc closes the browser and gives focus back to its button.
  await page.keyboard.press("Tab");
  const browse = page.getByRole("button", { name: "Browse folders" });
  await expect(browse).toBeFocused();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
  await expect(browse).toBeFocused();

  // Type to filter, Enter opens, Cmd/Ctrl+Enter uses the folder on screen.
  await page.keyboard.press("Enter");
  await page.keyboard.type("proj");
  await expect(folders(page, "~").getByRole("option")).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect(folders(page, "~/Projects")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(browse).toBeFocused();
  await expect(projects).toHaveAttribute("aria-pressed", "true");

  // Cmd/Ctrl+Enter anywhere else in the form saves.
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(page.getByRole("heading", { name: "Repos", exact: true })).toBeVisible();
  await expect(rows(page)).toHaveCount(4);
});

test("a root that does not exist shows the restart card with make up", async ({ page, request }) => {
  await waitForHelper(request);
  await page.goto("/settings/roots");
  await page.getByRole("button", { name: "Type a path" }).click();
  const path = page.getByRole("textbox", { name: "Folder path" });
  await expect(path).toBeFocused();

  await path.fill("Missing");
  await path.press("Enter");
  await expect(page.getByText("Use an absolute path, or one starting with ~/")).toBeVisible();
  await path.fill("~/Missing");
  await path.press("Enter");
  await expect(path).toHaveValue("");
  await expect(chosenRoots(page)).toContainText("~/Missing");
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
  // The e2e helper cannot run Docker, so there is nothing to mount it with.
  await expect(missing.getByRole("button", { name: "Mount now" })).toHaveCount(0);
  await expect(rows(page)).toHaveCount(4);
});

test("without the host helper the roots form falls back to typed paths", async ({ page }) => {
  // The server's own answer when no helper is connected.
  await page.route("**/api/cmd/fs.suggestRoots", (route) =>
    route.fulfill({ status: 503, json: { error: "host-offline", details: ["No host helper is connected"] } }),
  );
  await page.goto("/settings/roots");

  await expect(page.getByText("Folder browsing needs the majhi host helper")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Workspace root 1" })).toHaveValue("~/Work");
  await expect(page.getByRole("textbox", { name: "Workspace root 3" })).toHaveValue("~/Missing");
  await expect(page.getByRole("button", { name: "Browse folders" })).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "Online" })).toHaveText("Online, helper off");
  await shot(page, "helper-offline");
});

test("search filters repos and / focuses it", async ({ page }) => {
  await page.goto("/repos");
  await expect(rows(page)).toHaveCount(4);

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
  await expect(rows(page)).toHaveCount(4);
});

test("j moves the selection and Enter copies the repo path", async ({ page }) => {
  await page.goto("/repos");
  await expect(rows(page)).toHaveCount(4);
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
    await page.goto("/repos");
    await expect(page.getByRole("heading", { name: "majhi.yaml has errors" })).toBeVisible();
    await expect(page.getByText("~/.majhi/majhi.yaml")).toBeVisible();
    const errors = page.getByRole("region", { name: /errors/ }).getByRole("listitem");
    await expect(errors).toHaveCount(3);
    await expect(errors.filter({ hasText: "surprise" })).toHaveCount(1);
    await shot(page, "config-error");
  } finally {
    writeFileSync(file, good);
  }

  // The live feed may recover the screen by itself before Retry is clicked; either way it recovers.
  await page
    .getByRole("button", { name: "Retry" })
    .click({ timeout: 2_000 })
    .catch(() => {});
  await expect(page.getByRole("heading", { name: "Pick a task, or write a new one" })).toBeVisible();
  await page.goto("/repos");
  await expect(rows(page)).toHaveCount(4);
});
