import { existsSync } from "node:fs";
import { join } from "node:path";
import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { expect, test, useHome } from "./fixture.ts";

// The room: stopping a turn, permissions, a chat task and what an agent can show. Org Acme with its
// agents, the API-key account codex-key and the project api. The fake Codex adapter pauses 600 ms
// between the steps of a turn, so a turn can be stopped halfway.
useHome({ seed: "team-api", slow: { codex: 600 } });
// The flows do not depend on each other, so each runs in a worker of its own.
test.describe.configure({ mode: "parallel" });

const shot = (page: Page, name: string) => page.screenshot({ path: `e2e/screenshots/${name}.png` });

interface TaskInfo {
  id: string;
  folder: string;
  status: string;
  repos: { project: string; base: string; branch: string; worktree?: string }[];
}

async function cmd<T>(request: APIRequestContext, name: string, data: object): Promise<T> {
  const res = await request.post(`/api/cmd/${name}`, { data });
  expect(res.ok(), `${name}: ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

/** Sets which things an existing agent may do without asking, keeping everything else. */
async function setPerms(request: APIRequestContext, id: string, perms: string[]) {
  const entries = await cmd<{ status: string; agent: { frontmatter: { id: string } } }[]>(
    request,
    "agents.list",
    {},
  );
  const entry = entries.find((e) => e.status === "ok" && e.agent.frontmatter.id === id);
  expect(entry, `agent ${id} exists`).toBeTruthy();
  const { frontmatter, instructions } = (
    entry as unknown as { agent: { frontmatter: object; instructions: string } }
  ).agent;
  const { id: _id, ...rest } = frontmatter as { id: string };
  await cmd(request, "agents.update", { id, frontmatter: { ...rest, perms }, instructions });
}

const taskIdOf = (page: Page) => new URL(page.url()).pathname.split("/").pop() as string;
const getTask = (request: APIRequestContext, id: string) => cmd<TaskInfo>(request, "tasks.get", { id });

const room = (page: Page) => page.getByRole("region", { name: "Task room" });
const messages = (page: Page) => page.getByRole("log", { name: "Room messages" });
const composer = (page: Page) => page.getByRole("textbox", { name: "Message the room" });

const newTaskDialog = (page: Page) => page.getByRole("dialog", { name: "New task" });

/** Opens the New task dialog with `n` and types the title. */
async function openNewTask(page: Page, title: string) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Board", exact: true })).toBeVisible();
  await page.keyboard.press("n");
  await expect(newTaskDialog(page)).toBeVisible();
  await newTaskDialog(page).getByRole("textbox", { name: "Title" }).fill(title);
}

/** Adds a task from the dialog and starts it; resolves with the new task's id once its room is open. */
async function startTask(page: Page, text: string): Promise<string> {
  await openNewTask(page, text);
  await newTaskDialog(page).getByRole("button", { name: "Add and start" }).click();
  await expect(page).toHaveURL(/\/t\/[A-Z]+-\d+$/);
  await expect(room(page)).toBeVisible();
  return taskIdOf(page);
}

/** A permission that no longer waits: its verdict ("Allowed by rule", "Denied") and the request, on one line. */
const verdict = (log: Locator, text: string, request: string) =>
  log.getByRole("group").filter({ hasText: text }).filter({ hasText: request });

const panel = (page: Page) => page.getByRole("complementary", { name: "Task details" });

/** The agent finished its turn: the room panel says idle and the composer offers Send, not Stop. */
async function expectIdle(page: Page) {
  await expect(panel(page).getByText("Idle", { exact: true }).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
}

let chatTaskId: string;

test.beforeAll(async ({ request }) => {
  // The builder may only edit, so its commands ask. The lead and the boss (who runs the chat task)
  // may edit and run commands.
  await setPerms(request, "acme-builder", ["edit"]);
});

test("Esc stops a slow turn, and a queued message waits until the next send", async ({ page, request }) => {
  await cmd(request, "agents.create", {
    id: "acme-slow",
    frontmatter: {
      scope: "acme",
      role: "Builder",
      account: "codex-key",
      where: ["anywhere"],
      perms: ["edit", "shell"],
    },
    instructions: "Slow on purpose.",
  });
  const id = await startTask(page, "polish the api docs @acme-slow");
  const log = messages(page);
  await expect(room(page).getByRole("region", { name: "Plan of acme-slow" })).toBeVisible();
  await expect(log.getByRole("button", { name: /Read package\.json/ })).toBeVisible();

  // A message while the agent works is queued.
  await composer(page).fill("echo: queued one");
  await composer(page).press("Enter");
  await expect(log.getByText("echo: queued one")).toBeVisible();
  await expect(log.getByText("Queued for the agent's next turn")).toBeVisible();

  await composer(page).press("Escape");
  await expect(log.getByText("Stopped @acme-slow's turn.")).toBeVisible();
  await expect(panel(page).getByText("Idle", { exact: true })).toBeVisible();
  // The plan still has open entries, so it stays pinned. The turn ended before the tests ran,
  // and the queued message did not go.
  await expect(room(page).getByRole("region", { name: "Plan of acme-slow" })).toBeVisible();
  await expect(log.getByText(/Tests passed/)).toHaveCount(0);
  await expect(log.getByText("Queued for the agent's next turn")).toBeVisible();
  await expect(log.getByText("echo: echo: queued one")).toHaveCount(0);
  const cancelled = await getTask(request, id);
  expect(cancelled.status).toBe("running");

  // The next send releases it, ahead of the new message.
  await composer(page).fill("echo: two");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(log.getByText("echo: echo: queued one")).toBeVisible();
  await expect(log.getByText("echo: echo: two")).toBeVisible();
  await expect(log.getByText("Queued for the agent's next turn")).toHaveCount(0);
});

test("a command the agent may not run asks inline: Deny fails the tool and the turn goes on", { tag: "@smoke" }, async ({
  page,
}) => {
  await startTask(page, "tidy the readme in backend @acme-builder");
  const log = messages(page);
  const prompt = room(page).getByRole("region", { name: "Permission: Run npm test" });
  await expect(prompt).toBeVisible();
  await expect(prompt).toContainText("acme-builder asks to");
  await expect(prompt.getByRole("button")).toHaveText(["Allow", "Allow for this task", "Deny"]);
  await expect(room(page).getByRole("region", { name: "Plan of acme-builder" })).toBeVisible();
  await shot(page, "room-permission");

  // The shell's banner points at the prompt too, and goes away once it is answered.
  const banner = page.getByRole("status").filter({ hasText: "waiting for your answer" });
  await expect(banner).toContainText("@acme-builder is waiting for your answer in");
  await banner.getByRole("button", { name: "Show" }).click();
  await expect(prompt).toBeFocused();

  await prompt.getByRole("button", { name: "Deny" }).click();
  await expect(prompt).toBeHidden();
  await expect(banner).toBeHidden();
  await expect(verdict(log, "Denied", "Run npm test")).toBeVisible();
  await expect(log.getByRole("button", { name: /Run npm test.*failed/ })).toBeVisible();
  await expect(log.getByText(/I could not run the tests\./)).toBeVisible();
  await expectIdle(page);
});

test("Allow for this task answers the next ask of that kind by itself", async ({ page }) => {
  await startTask(page, "fix the typo in api @acme-builder");
  const log = messages(page);
  const prompt = room(page).getByRole("region", { name: "Permission: Run npm test" });
  await prompt.getByRole("button", { name: "Allow for this task" }).click();
  await expect(log.getByText(/Tests passed\./)).toBeVisible();
  await expectIdle(page);

  await composer(page).fill("run it once more");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(verdict(log, "Allowed by rule", "Run npm test").last()).toBeVisible({ timeout: 20_000 });
  await expect(log.getByText(/Tests passed\./)).toHaveCount(2, { timeout: 20_000 });
  await expect(room(page).getByRole("region", { name: "Permission: Run npm test" })).toHaveCount(0);
  await expectIdle(page);
});

test.describe("a chat task", () => {
  test.describe.configure({ mode: "serial" });

  test("a chat task without a repo replies in the room", async ({ page, request }) => {
    await openNewTask(page, "echo: hello");
    const dialog = newTaskDialog(page);
    await expect(dialog.getByText("this becomes a chat task")).toBeVisible();
    await dialog.getByRole("button", { name: "Add and start" }).click();
    await expect(page).toHaveURL(/\/t\/LOCAL-\d+$/);
    const id = taskIdOf(page);
    chatTaskId = id;
    const log = messages(page);
    await expect(log.getByText(/Done\..*Created HEALTH\.md\. Tests passed\./)).toBeVisible({ timeout: 20_000 });
    await expectIdle(page);

    await composer(page).fill("echo: hello");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(log.getByText("echo: echo: hello")).toBeVisible();
    expect((await getTask(request, id)).repos).toEqual([]);
  });

  test("the agent shows an image and a page; the page runs sandboxed and cannot reach majhi", async ({
    page,
    request,
  }) => {
    await page.goto(`/t/${chatTaskId}`);
    const log = messages(page);
    await composer(page).fill("show: media");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(log.getByText("Here is the chart and the report.")).toBeVisible();

    // The markdown image renders inline, at most 480 px wide.
    const chart = log.getByRole("img", { name: "Latency chart" });
    await expect(chart).toBeVisible();
    await expect.poll(() => chart.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    expect((await chart.boundingBox())?.width).toBeLessThanOrEqual(480);
    await expect(chart).toHaveAttribute("src", `/api/tasks/${chatTaskId}/files/media/chart.png`);

    // The image block the agent sent was saved into the task's media folder and shows too.
    await expect(log.getByRole("img", { name: "1.png" })).toBeVisible();
    const docs = log.getByRole("link", { name: "the docs" });
    await expect(docs).toHaveAttribute("href", "https://example.com/docs");
    await expect(docs).toHaveAttribute("target", "_blank");
    await expect(docs).toHaveAttribute("rel", "noopener noreferrer");
    const spec = log.getByRole("link", { name: "Open Spec sheet" });
    await expect(spec).toHaveAttribute("href", "https://example.com/spec");
    await expect(spec).toHaveAttribute("rel", "noopener noreferrer");
    await expectIdle(page);

    // A table in the reply is a real table with the right cells.
    const table = log.getByRole("table");
    await expect(table).toBeVisible();
    await expect(table.getByRole("columnheader")).toHaveText(["Keep", "Delete", "Safe?"]);
    await expect(table.getByRole("row")).toHaveCount(3);
    await expect(table.getByRole("cell")).toHaveText([
      "chart.png",
      "tmp.png",
      "yes",
      "report.html",
      "old.html",
      "yes",
    ]);
    await expect(log.getByText("| Keep |")).toHaveCount(0);

    // A file link inside a sentence stays on the line: no taller than the text around it.
    const notes = log.getByRole("link", { name: "media/notes.md" });
    await expect(notes).toBeVisible();
    expect((await notes.boundingBox())?.height).toBeLessThan(24);
    // Inline code does not stretch its line either.
    const code = log.locator("code", { hasText: "latency/p99-ms" });
    expect((await code.boundingBox())?.height).toBeLessThan(24);
    await shot(page, "room-markdown");

    // Click for full size; Esc closes it and does not stop anything.
    await log.getByRole("button", { name: "View Latency chart full size" }).click();
    const lightbox = page.getByRole("dialog", { name: "Latency chart" });
    await expect(lightbox).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(lightbox).toBeHidden();
    await expect(log.getByText(/Stopped @/)).toHaveCount(0);

    // The .md link opens the in-app viewer, not a tab: rendered headings and a table.
    let popups = 0;
    page.on("popup", () => {
      popups += 1;
    });
    await notes.click();
    const viewer = page.getByRole("dialog", { name: "File media/notes.md" });
    await expect(viewer).toBeVisible();
    await expect(page).toHaveURL(/file=media%2Fnotes\.md/);
    await expect(viewer.getByRole("heading", { name: "Latency notes", level: 1 })).toBeVisible();
    await expect(viewer.getByRole("heading", { name: "What changed", level: 2 })).toBeVisible();
    await expect(viewer.getByRole("columnheader")).toHaveText(["Metric", "Before", "After"]);
    await expect(viewer.getByRole("cell", { name: "410 ms" })).toBeVisible();
    await expect(viewer.getByText("media/notes.md · ", { exact: false })).toBeVisible();
    await expect(viewer.getByRole("button", { name: "Copy ts" })).toBeVisible();
    await shot(page, "file-viewer");
    expect(popups).toBe(0);

    // Reload keeps the viewer open on the same file.
    await page.reload();
    await expect(page.getByRole("dialog", { name: "File media/notes.md" })).toBeVisible();

    // Raw shows the source with line numbers.
    await viewer.getByRole("button", { name: "Raw", exact: true }).click();
    await expect(viewer.getByText("# Latency notes")).toBeVisible();
    await expect(viewer.getByRole("heading", { name: "Latency notes" })).toHaveCount(0);
    await expect(viewer.locator(".code-gutter")).toContainText("12");
    await viewer.getByRole("button", { name: "Rendered" }).click();
    await expect(viewer.getByRole("heading", { name: "Latency notes", level: 1 })).toBeVisible();

    // Esc closes it, and Back opens it again.
    await page.keyboard.press("Escape");
    await expect(viewer).toBeHidden();
    await expect(page).not.toHaveURL(/file=/);
    await page.goBack();
    await expect(page.getByRole("dialog", { name: "File media/notes.md" })).toBeVisible();
    await page.getByRole("button", { name: "Close viewer" }).click();
    await expect(page.getByRole("dialog", { name: "File media/notes.md" })).toBeHidden();

    // The page is a card; it opens in the viewer, which never shows it: "Open page" opens it sandboxed in a tab.
    const card = log.getByRole("link", { name: "Open Latency report" });
    const href = `/api/tasks/${chatTaskId}/files/media/report.html`;
    await card.click();
    const pageViewer = page.getByRole("dialog", { name: "File media/report.html" });
    await expect(pageViewer).toBeVisible();
    await expect(pageViewer.locator("iframe")).toHaveCount(0);
    await expect(pageViewer.getByText("<title>Latency report</title>")).toBeVisible();
    const open = pageViewer.getByRole("link", { name: "Open page" });
    await expect(open).toHaveAttribute("href", href);
    await expect(open).toHaveAttribute("rel", "noopener noreferrer");
    const served = await request.get(href);
    expect(served.headers()["content-security-policy"]).toBe(
      "sandbox allow-scripts allow-forms allow-popups allow-downloads",
    );
    expect(served.headers()["x-content-type-options"]).toBe("nosniff");
    const [popup] = await Promise.all([page.waitForEvent("popup"), open.click()]);
    const commands: number[] = [];
    popup.on("response", (res) => {
      if (res.url().includes("/api/cmd/")) commands.push(res.status());
    });
    await popup.waitForLoadState();
    await expect(popup.getByRole("heading", { name: "Latency report" })).toBeVisible();
    await expect(popup.locator("#out")).toHaveText("blocked from majhi");
    expect(commands.filter((status) => status < 400)).toEqual([]);
    await popup.close();
    await page.keyboard.press("Escape");

    // The files endpoint serves the task folder and nothing else.
    const folder = (await getTask(request, chatTaskId)).folder;
    expect((await request.get(`/api/tasks/${chatTaskId}/files/TASK.md`)).status()).toBe(200);
    const meta = await request.get(`/api/tasks/${chatTaskId}/files/TASK.md?meta=1`);
    expect(await meta.json()).toMatchObject({ size: expect.any(Number), modified: expect.any(String) });
    expect((await request.get(`/api/tasks/${chatTaskId}/files/.fake-sessions`)).status()).toBe(403);
    expect(
      (await request.get(`/api/tasks/${chatTaskId}/files/..%2F..%2Fmajhi.yaml`)).status(),
    ).toBeGreaterThanOrEqual(403);
    expect((await request.get(`/api/tasks/${chatTaskId}/files/media/missing.png`)).status()).toBe(404);
    expect(existsSync(join(folder, "media", "1.png"))).toBe(true);
    // An opaque origin, like a sandboxed page's, is refused by the command endpoint.
    const refused = await request.post("/api/cmd/tasks.list", { data: {}, headers: { origin: "null" } });
    expect(refused.status()).toBe(403);
  });
});
