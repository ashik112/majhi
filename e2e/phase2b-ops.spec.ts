import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { HOST_HOME } from "./fixture.ts";

// Own server and home: run with `pnpm exec playwright test -c playwright.ops.config.ts` (port 7083).
// The default suite shares one majhi.yaml across specs, so these stay out of it.
test.skip(process.env.MAJHI_E2E_PORT !== "7083", "runs only under playwright.ops.config.ts");
test.describe.configure({ mode: "serial" });

const TASKS_DIR = join(HOST_HOME, "ops-tasks");
const setRoots = (request: import("@playwright/test").APIRequestContext, roots: string[]) =>
  request.post("/api/cmd/workspaces.set", { data: { workspaces: roots, tasks_dir: TASKS_DIR } });

// Setup (an account and a boss) is not what these tests are about: skip it, as the owner can.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem("majhi.setup.skipped", "1"));
});

test.beforeAll(async ({ request }) => {
  const res = await setRoots(request, [join(HOST_HOME, "Work")]);
  expect(res.ok(), await res.text()).toBe(true);
});

test("Health shows the checks, and a Fix creates a missing folder", async ({ page }) => {
  expect(existsSync(TASKS_DIR)).toBe(false);
  await page.goto("/usage");

  const checks = page.getByRole("region", { name: "Checks" });
  await expect(checks).toBeVisible();
  const accounts = page.getByRole("heading", { name: "Accounts", exact: true });
  const checksBox = await checks.boundingBox();
  const accountsBox = await accounts.boundingBox();
  expect(checksBox && accountsBox && checksBox.y < accountsBox.y).toBe(true);

  // The checks fold to one line per group; a failing one stays open with its fix.
  await expect(checks.getByRole("list", { name: "Checks that need you" })).toContainText("Tasks folder");
  await checks.getByRole("button", { name: /^Show all/ }).click();
  await expect(
    checks.getByRole("list", { name: "majhi" }).getByText("Config", { exact: true }),
  ).toBeVisible();
  const row = checks.getByRole("listitem").filter({ hasText: "Tasks folder" });
  await expect(row).toContainText("does not exist yet");
  await row.getByRole("button", { name: /Create folder/ }).click();
  await expect(row.getByRole("status")).toHaveText("Created the tasks folder.");
  expect(existsSync(TASKS_DIR)).toBe(true);

  await page.getByRole("button", { name: "Run health check" }).click();
  await expect(row).toContainText("exists");
  await expect(row.getByRole("button", { name: /Create folder/ })).toHaveCount(0);
});

test("a failed check with no fix says what to do, and counts in the sidebar", async ({ page, request }) => {
  const res = await setRoots(request, [join(HOST_HOME, "Work"), join(HOST_HOME, "NotMounted")]);
  expect(res.ok(), await res.text()).toBe(true);
  await page.goto("/usage");
  const row = page
    .getByRole("region", { name: "Checks" })
    .getByRole("listitem")
    .filter({ hasText: "Workspace root ~/NotMounted" });
  await expect(row).toContainText("make up");
  await expect(row.getByRole("button")).toHaveCount(0);
  await expect(
    page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: /Health and usage/ }),
  ).toContainText("1 need you");
  await setRoots(request, [join(HOST_HOME, "Work")]);
});

test("the update banner lists the changes and the update reloads on the new commit", async ({ page }) => {
  const state = {
    commit: "aaaaaaa1111111",
    updated: false,
    phase: "idle" as "idle" | "building" | "down",
    startedAt: "",
  };
  const update = (over: object) => ({
    commit: "bbbbbbb2222222",
    startedAt: state.startedAt,
    lines: ["Reading the code on disk", "Building the new image. This takes a few minutes"],
    ...over,
  });
  const json = (body: unknown) => ({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
  await page.route("**/api/cmd/system.version", (route) => {
    if (state.phase === "down") return route.abort();
    const base = { running: state.commit, onDisk: "bbbbbbb2222222", canUpdate: true, dirty: true };
    if (state.updated) {
      const done = { ...base, running: "bbbbbbb2222222", updateReady: false, changes: [] };
      return route.fulfill(json({ ...done, update: update({ state: "done" }) }));
    }
    return route.fulfill(
      json({
        ...base,
        updateReady: true,
        changes: ["feat(health): checks with fixes", "fix(shell): banner spacing"],
        ...(state.phase === "building" ? { update: update({ state: "running" }) } : {}),
      }),
    );
  });
  await page.route("**/api/cmd/system.update", (route) => {
    state.phase = "building";
    state.startedAt = new Date().toISOString();
    return route.fulfill(json({ state: "restarting" }));
  });
  await page.route(
    (url) => url.pathname === "/health",
    (route) => {
      if (state.phase === "down") return route.abort();
      return route.fulfill(
        json({ status: "ok", version: "e2e", commit: state.updated ? "bbbbbbb2222222" : state.commit }),
      );
    },
  );

  await page.goto("/");
  const notice = page.getByRole("region", { name: "Update ready" });
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("2 changes");
  await expect(notice).toContainText("changes you have not committed");
  await notice.getByRole("button", { name: /Update ready/ }).click();
  await expect(notice.getByRole("list", { name: "Changes" })).toContainText(
    "feat(health): checks with fixes",
  );

  await notice.getByRole("button", { name: "Update", exact: true }).click();
  const overlay = page.getByRole("alertdialog", { name: "Updating majhi" });
  await expect(overlay).toBeVisible();
  await expect(overlay.getByRole("list", { name: "Update progress" })).toContainText(
    "Building the new image",
  );

  // The server goes away: the owner still sees the progress, not a dead page.
  state.phase = "down";
  await expect(overlay).toBeVisible();
  await expect(overlay.getByRole("list", { name: "Update progress" })).toContainText(
    "Reading the code on disk",
  );

  // The new server answers with the new commit, and the page reloads without the banner.
  state.updated = true;
  state.phase = "idle";
  await expect(overlay).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByRole("region", { name: "Update ready" })).toHaveCount(0);
});

test("saving a root under Documents warns that macOS will ask", async ({ page }) => {
  await page.goto("/settings/roots");
  await page.getByRole("button", { name: "Type a path" }).click();
  await expect(page.getByRole("note", { name: "macOS folder access" })).toHaveCount(0);
  await page.getByRole("textbox", { name: "Folder path" }).fill("~/Documents/code");
  await page.getByRole("textbox", { name: "Folder path" }).press("Enter");
  const warning = page.getByRole("note", { name: "macOS folder access" });
  await expect(warning).toContainText("macOS will ask whether Docker may access your Documents folder");
  await expect(warning).toContainText("Click Allow");
  await expect(warning).toContainText("~/Documents/code");
});
