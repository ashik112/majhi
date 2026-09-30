import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type APIRequestContext, expect, type Locator, type Page, test } from "@playwright/test";
import { HOST_HOME, MAJHI_HOME } from "./fixture.ts";

// Builds on phase 1: an org "Acme", the agents acme-lead, acme-builder and the boss, and the API-key
// account codex-key. The fake Claude adapter pauses 250 ms between the steps of a turn, the fake Codex
// adapter 600 ms, so a turn can be watched and stopped.
test.describe.configure({ mode: "serial" });

const API_SOURCE = join(HOST_HOME, "Work", "alpha-api");
const NOT_TOUCHED = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

const shot = (page: Page, name: string) => page.screenshot({ path: `e2e/screenshots/${name}.png` });
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...NOT_TOUCHED },
  }).trim();

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

let apiTask: TaskInfo;
let apiTaskId: string;
let chatTaskId: string;

test.beforeAll(async ({ request }) => {
  // The lead may edit and run commands, so `npm test` is allowed by rule. The builder may only edit,
  // so its commands ask. The boss runs the chat task.
  await setPerms(request, "acme-lead", ["edit", "shell"]);
  await setPerms(request, "acme-builder", ["edit"]);
  const bossId = readFileSync(join(MAJHI_HOME, "majhi.yaml"), "utf8").match(/^boss: (\S+)/m)?.[1];
  expect(bossId).toBeTruthy();
  await setPerms(request, bossId as string, ["edit", "shell"]);
});

test("register a repo as a project from the Projects page", async ({ page, request }) => {
  await page.goto("/projects");
  await page.getByRole("button", { name: "Register alpha-api" }).click();
  const dialog = page.getByRole("dialog", { name: "Register alpha-api" });
  await dialog.getByRole("combobox", { name: "Org" }).selectOption({ label: "Acme" });
  const id = dialog.getByRole("textbox", { name: "Project id" });
  await expect(id).toHaveValue("alpha-api");
  await id.fill("api");
  const aliases = dialog.getByRole("textbox", { name: "Aliases" });
  await aliases.fill("backend");
  await aliases.press("Enter");
  await expect(dialog.getByRole("button", { name: "Remove alias backend" })).toBeVisible();
  await shot(page, "repos-register");
  await dialog.getByRole("button", { name: "Register", exact: true }).click();
  await expect(dialog).toBeHidden();

  await expect(
    page.getByRole("navigation", { name: "Projects" }).getByRole("button", { name: "api", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Register alpha-api" })).toHaveCount(0);
  const projects = await cmd<{ id: string; org: string; aliases: string[] }[]>(request, "projects.list", {});
  expect(projects).toMatchObject([{ id: "api", org: "acme", aliases: ["backend"] }]);
});

test("add a health endpoint to api from develop: worktree, branch, TASK.md and a streamed turn", async ({
  page,
  request,
}) => {
  // Typing everything in the title still works: the project chip and the base follow the words.
  await openNewTask(page, "add a health endpoint to api from develop");
  const dialog = newTaskDialog(page);
  await expect(dialog.getByRole("button", { name: "api", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(dialog.getByText("Branches from develop")).toBeVisible();
  await expect(dialog.getByRole("button", { name: /^Agent: @acme-lead/ })).toBeVisible();
  await shot(page, "task-screen");

  await dialog.getByRole("button", { name: "Add and start" }).click();
  await expect(page).toHaveURL(/\/t\/ACM-\d+$/);
  apiTaskId = taskIdOf(page);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("health endpoint");

  // The turn streams: the owner's text, pinned plan, text, tools, a permission answered by rule, the final message.
  const log = messages(page);
  await expect(log.getByText("add a health endpoint to api from develop")).toBeVisible();
  await expect(log.getByText(/@acme-lead started on claude-acme-1/)).toBeVisible();
  // The fixture remote does not exist, so the fetch fails; the task starts from the local copy.
  await expect(log.getByText(/Could not fetch develop from origin/)).toBeVisible();
  const plan = room(page).getByRole("region", { name: "Plan of acme-lead" });
  await expect(plan).toBeVisible();
  await expect(plan).toContainText("Read the project");
  await expect(plan).toContainText("Write the change");
  await expect(log.getByText("I will look at the project first.")).toBeVisible();
  await expect(log.getByRole("button", { name: /Read package\.json/ })).toBeVisible();
  const edit = log.getByRole("button", { name: /Edit HEALTH\.md/ });
  await expect(edit).toBeVisible();
  await page.getByRole("button", { name: "Stop all" }).waitFor();
  await shot(page, "room-running");

  await expect(verdict(log, "Allowed by rule", "Run npm test")).toBeVisible();
  await expect(log.getByText(/Done\..*Created HEALTH\.md\. Tests passed\./)).toBeVisible();
  // Nothing is left open, so the plan is no longer pinned; the room keeps a summary line.
  await expect(plan).toBeHidden();
  await expect(log.getByText("Plan, 2 of 2 done")).toBeVisible();
  await expectIdle(page);

  // Expanding the edit shows its diff.
  await edit.click();
  await expect(edit).toHaveAttribute("aria-expanded", "true");
  await expect(log.getByText("# Health")).toBeVisible();
  await expect(log.getByText("new file")).toBeVisible();

  // On disk.
  apiTask = await getTask(request, apiTaskId);
  const repo = apiTask.repos[0];
  expect(repo).toMatchObject({ project: "api", base: "develop" });
  expect(apiTask.folder.endsWith(`/${apiTaskId}`)).toBe(true);
  const worktree = join(apiTask.folder, "api");
  expect(repo?.worktree).toBe(worktree);
  expect(existsSync(join(worktree, ".git"))).toBe(true);
  const branch = git(worktree, "rev-parse", "--abbrev-ref", "HEAD");
  expect(branch).toMatch(new RegExp(`^task/${apiTaskId.toLowerCase()}-`));
  expect(branch).toContain("health-endpoint");
  // Created from develop, which is one commit ahead of main.
  expect(git(worktree, "rev-parse", "HEAD")).toBe(git(API_SOURCE, "rev-parse", "develop"));
  expect(git(worktree, "rev-parse", "HEAD")).not.toBe(git(API_SOURCE, "rev-parse", "main"));
  expect(git(API_SOURCE, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");

  const taskMd = readFileSync(join(apiTask.folder, "TASK.md"), "utf8");
  expect(taskMd).toContain(apiTaskId);
  expect(taskMd).toContain(`\`${branch}\``);
  expect(taskMd).toContain(worktree);
  expect(taskMd).toContain("add a health endpoint to api from develop");
  expect(existsSync(join(apiTask.folder, "AGENTS.md"))).toBe(true);
  expect(readFileSync(join(apiTask.folder, "HEALTH.md"), "utf8")).toBe("# Health\n\nok\n");

  // Nothing was pushed: the remote is as it was, no remote branches exist and the branch tracks nothing.
  expect(git(API_SOURCE, "remote", "get-url", "origin")).toBe("git@github.com:acme/alpha-api.git");
  expect(git(API_SOURCE, "for-each-ref", "refs/remotes")).toBe("");
  expect(git(API_SOURCE, "for-each-ref", "--format=%(upstream)", `refs/heads/${branch}`)).toBe("");
});

test("asking for a file in the repo writes it to the worktree and lists it under Changes", async ({
  page,
}) => {
  await page.goto(`/t/${apiTaskId}`);
  await composer(page).fill("create api/HEALTH.md");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const log = messages(page);
  await expect(log.getByText("create api/HEALTH.md")).toBeVisible();
  await expect(log.getByText(/Done\..*Created api\/HEALTH\.md\. Tests passed\./)).toBeVisible({
    timeout: 20_000,
  });
  await expectIdle(page);

  const file = join(apiTask.folder, "api", "HEALTH.md");
  expect(readFileSync(file, "utf8")).toBe("# Health\n\nok\n");
  // The turn ended with a checkpoint: the file is committed on the task branch, nothing is left over.
  const worktree = join(apiTask.folder, "api");
  expect(git(worktree, "log", "-1", "--format=%s")).toMatch(/^wip\([A-Z]+-\d+\): checkpoint \d+$/);
  expect(git(worktree, "show", "--name-only", "--format=", "HEAD")).toContain("HEALTH.md");
  expect(git(worktree, "status", "--porcelain")).toBe("");
  // The agent is the committer, and the message links the commit to its task.
  expect(git(worktree, "log", "-1", "--format=%cn|%ce")).toBe("acme-lead via majhi|majhi@majhi.local");
  expect(git(worktree, "log", "-1", "--format=%(trailers:key=Majhi-Task,valueonly)")).toBe(apiTaskId);

  const changes = panel(page);
  await expect(changes.getByRole("heading", { name: "Changes" })).toBeVisible();
  await expect(changes.getByRole("region", { name: "Branch and worktree" })).toContainText("develop");
  const section = changes.getByRole("region", { name: "Changes in api" });
  await expect(changes.getByRole("button", { name: "Copy worktree path of api" })).toBeVisible();
  await expect(section.getByRole("list", { name: "Commits" })).toContainText("@acme-lead");
  await shot(page, "changes-commits-by-agent");

  // A commit made by hand shows no agent, next to the agent's.
  git(
    worktree,
    "-c",
    "user.name=Ada",
    "-c",
    "user.email=ada@acme.test",
    "commit",
    "--quiet",
    "--allow-empty",
    "-m",
    "docs: by hand",
  );
  await page.reload();
  await page.getByRole("tab", { name: "Changes" }).click();
  const commits = page
    .getByRole("region", { name: "Changes in api" })
    .getByRole("list", { name: "Commits" })
    .first();
  await expect(commits.getByRole("listitem").filter({ hasText: "docs: by hand" })).not.toContainText("@");
  await expect(commits.getByRole("listitem").filter({ hasText: "checkpoint" })).toContainText("@acme-lead");
  await shot(page, "changes-tab-commits");
  await page.getByRole("tab", { name: "Room" }).click();

  // A changed file opens the Changes view with its diff inline.
  await section.getByRole("button", { name: "Show the diff of HEALTH.md" }).click();
  await expect(page.getByRole("tab", { name: "Changes", selected: true })).toBeVisible();
  await expect(page.getByRole("group").filter({ hasText: "New file" })).toContainText("# Health");
});

test("agent attribution in commits can be turned off for majhi, an org and a project", async ({
  page,
  request,
}) => {
  const attribution = async () =>
    (await cmd<{ commits: { attribution: boolean } }>(request, "settings.get", {})).commits.attribution;
  const fromOrg = async () =>
    (await cmd<{ id: string; commits?: { attribution: boolean } }[]>(request, "orgs.list", {})).find(
      (o) => o.id === "acme",
    )?.commits;
  const fromProject = async () =>
    (await cmd<{ id: string; commits?: { attribution: boolean } }[]>(request, "projects.list", {})).find(
      (p) => p.id === "api",
    )?.commits;
  expect(await attribution()).toBe(true);

  // All of majhi: a switch in Hub setup, on by default.
  await page.goto("/setup?section=context");
  const global = page.getByRole("switch", { name: "Agent attribution in commits" });
  await expect(global).toBeChecked();
  await shot(page, "attribution-setup");
  await global.click();
  await page.getByRole("button", { name: "Save Commits" }).click();
  await expect.poll(attribution).toBe(false);

  // An org: "Use majhi's setting / On / Off".
  await page.goto("/orgs");
  await page.getByRole("navigation", { name: "Orgs" }).getByRole("button", { name: /^Acme/ }).click();
  const orgSelect = page.getByRole("combobox", { name: "Agent attribution in commits" });
  await expect(orgSelect).toHaveValue("default");
  await orgSelect.selectOption({ label: "On" });
  await shot(page, "attribution-org");
  await page.getByRole("button", { name: "Save settings" }).first().click();
  await expect.poll(fromOrg).toEqual({ attribution: true });

  // A project: "Use the org's setting / On / Off".
  await page.goto("/projects");
  await page
    .getByRole("navigation", { name: "Projects" })
    .getByRole("button", { name: "api", exact: true })
    .click();
  const projectSelect = page.getByRole("combobox", { name: "Agent attribution in commits" });
  await expect(projectSelect).toHaveValue("default");
  await projectSelect.selectOption({ label: "Off" });
  await shot(page, "attribution-project");
  await page.getByRole("button", { name: "Save Settings" }).click();
  await expect.poll(fromProject).toEqual({ attribution: false });

  // Put everything back, so later tests run with the defaults.
  await cmd(request, "settings.set", { commits: { attribution: true } });
  await cmd(request, "orgs.update", { id: "acme", commits: null });
  await cmd(request, "projects.update", { id: "api", org: "acme", aliases: ["backend"], commits: null });
  expect(await fromProject()).toBeUndefined();
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
  await expect(log.getByText("Queued, waits for the agent's next turn")).toBeVisible();

  await composer(page).press("Escape");
  await expect(log.getByText("Stopped @acme-slow's turn.")).toBeVisible();
  await expect(panel(page).getByText("Idle", { exact: true })).toBeVisible();
  // The plan still has open entries, so it stays pinned. The turn ended before the tests ran,
  // and the queued message did not go.
  await expect(room(page).getByRole("region", { name: "Plan of acme-slow" })).toBeVisible();
  await expect(log.getByText(/Tests passed/)).toHaveCount(0);
  await expect(log.getByText("Queued, waits for the agent's next turn")).toBeVisible();
  await expect(log.getByText("echo: echo: queued one")).toHaveCount(0);
  const cancelled = await getTask(request, id);
  expect(cancelled.status).toBe("running");

  // The next send releases it, ahead of the new message.
  await composer(page).fill("echo: two");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(log.getByText("echo: echo: queued one")).toBeVisible();
  await expect(log.getByText("echo: echo: two")).toBeVisible();
  await expect(log.getByText("Queued, waits for the agent's next turn")).toHaveCount(0);
});

test("a command the agent may not run asks inline: Deny fails the tool and the turn goes on", async ({
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

test("removing a task with uncommitted changes is refused, and Remove anyway removes it", async ({
  page,
  request,
}) => {
  await page.goto(`/t/${apiTaskId}`);
  const worktree = join(apiTask.folder, "api");
  expect(existsSync(worktree)).toBe(true);
  expect(git(API_SOURCE, "worktree", "list")).toContain(worktree);
  // Turns end with a checkpoint, so only a change made outside a turn is left uncommitted.
  writeFileSync(join(worktree, "HEALTH.md"), "# Health\n\nedited by hand\n");

  await page.getByRole("button", { name: "Task menu" }).click();
  await page.getByRole("menuitem", { name: "Remove task" }).click();
  const dialog = page.getByRole("dialog", { name: `Remove ${apiTaskId}` });
  await dialog.getByRole("button", { name: "Remove task" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Uncommitted changes");
  await expect(dialog.getByRole("alert")).toContainText("HEALTH.md");
  expect(existsSync(worktree)).toBe(true);

  await dialog.getByRole("button", { name: "Remove anyway" }).click();
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(/\/$/);
  await expect.poll(() => existsSync(apiTask.folder)).toBe(false);
  expect(git(API_SOURCE, "worktree", "list")).not.toContain(worktree);
  const list = await cmd<{ id: string }[]>(request, "tasks.list", { includeDone: true });
  expect(list.map((t) => t.id)).not.toContain(apiTaskId);
  // The owner's own checkout was never touched.
  expect(git(API_SOURCE, "status", "--porcelain")).toBe("");
});
