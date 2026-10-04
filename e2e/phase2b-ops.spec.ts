import { join } from "node:path";
import { expect, HOST_HOME, test, useHome } from "./fixture.ts";

useHome({ seed: "empty" });
test.describe.configure({ mode: "serial" });

const TASKS_DIR = join(HOST_HOME, "ops-tasks");
const setRoots = (request: import("@playwright/test").APIRequestContext, roots: string[]) =>
  request.post("/api/cmd/workspaces.set", { data: { workspaces: roots, tasks_dir: TASKS_DIR } });

// Setup (an account and a captain) is not what these tests are about: skip it, as the owner can.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem("majhi.setup.skipped", "1"));
});

test.beforeAll(async ({ request }) => {
  const res = await setRoots(request, [join(HOST_HOME, "Work")]);
  expect(res.ok(), await res.text()).toBe(true);
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
  await notice.getByRole("button", { name: /Update ready/ }).click();
  await expect(notice).toContainText("changes you have not committed");
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
