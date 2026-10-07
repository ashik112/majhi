import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { expect, expectTasksHome, HOST_HOME, MAJHI_HOME, test, useHome } from "./fixture.ts";

// Org Acme with its agents and the project api. One task on api, from creating it to removing it.
// The fake Claude adapter pauses 120 ms between the steps of a turn, so the turn can be watched.
// The room's other flows are in phase2a-room.spec.ts.
useHome({ seed: "team-api", slow: { claude: 120 } });
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

const messages = (page: Page) => page.getByRole("log", { name: "Room messages" });
const _composer = (page: Page) => page.getByRole("textbox", { name: "Message the room" });

const newTaskDialog = (page: Page) => page.getByRole("dialog", { name: "New task" });

/** Opens the New task dialog with `n` and types the title. */
async function openNewTask(page: Page, title: string) {
  await page.goto("/");
  await expectTasksHome(page);
  await page.keyboard.press("n");
  await expect(newTaskDialog(page)).toBeVisible();
  await newTaskDialog(page).getByRole("textbox", { name: "Title" }).fill(title);
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

test.beforeAll(async ({ request }) => {
  // The lead may edit and run commands, so `npm test` is allowed by rule. The builder may only edit,
  // so its commands ask. The captain runs the chat task.
  await setPerms(request, "acme-lead", ["edit", "shell"]);
  await setPerms(request, "acme-builder", ["edit"]);
  const bossId = readFileSync(join(MAJHI_HOME, "majhi.yaml"), "utf8").match(/^boss: (\S+)/m)?.[1];
  expect(bossId).toBeTruthy();
  await setPerms(request, bossId as string, ["edit", "shell"]);
});

test("add a health endpoint to api from develop: worktree, branch, TASK.md and a streamed turn", async ({
  page,
  request,
}) => {
  // A project named in the words is offered, never added by itself: one click adds it.
  await openNewTask(page, "add a health endpoint to api from develop");
  const dialog = newTaskDialog(page);
  await expect(dialog.getByRole("button", { name: "api", exact: true })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await dialog.getByRole("button", { name: "Add api" }).click();
  await expect(dialog.getByRole("button", { name: "api", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(dialog.getByRole("button", { name: /^Agent: @acme-lead/ })).toBeVisible();
  await shot(page, "task-screen");

  await dialog.getByRole("button", { name: "Add and start" }).click();
  await expect(page).toHaveURL(/\/t\/ACM-\d+$/);
  apiTaskId = taskIdOf(page);

  // The turn runs to its end: a permission answered by rule, the final message, and the agent idle.
  const log = messages(page);
  await expect(verdict(log, "Allowed by rule", "Run npm test")).toBeVisible();
  await expect(log.getByText(/Done\..*Created HEALTH\.md\. Tests passed\./)).toBeVisible();
  await expectIdle(page);

  // On disk.
  apiTask = await getTask(request, apiTaskId);
  const repo = apiTask.repos[0];
  // The base is the project's, never a branch named in the words.
  expect(repo).toMatchObject({ project: "api" });
  expect(apiTask.folder.endsWith(`/${apiTaskId}`)).toBe(true);
  const worktree = join(apiTask.folder, "api");
  expect(repo?.worktree).toBe(worktree);
  expect(existsSync(join(worktree, ".git"))).toBe(true);
  const branch = git(worktree, "rev-parse", "--abbrev-ref", "HEAD");
  expect(branch).toMatch(new RegExp(`^[a-z]+/${apiTaskId.toLowerCase()}-`));
  expect(branch).toContain("health-endpoint");
  // Created from the project's own branch, not from the develop named in the words (one commit ahead of main).
  expect(git(worktree, "rev-parse", "HEAD")).toBe(git(API_SOURCE, "rev-parse", "main"));
  expect(git(worktree, "rev-parse", "HEAD")).not.toBe(git(API_SOURCE, "rev-parse", "develop"));
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

test("removing a task with uncommitted changes is refused, and typing its id removes it", async ({
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
  await expect(dialog.getByRole("listitem")).toContainText("HEALTH.md");
  expect(existsSync(worktree)).toBe(true);

  // Removing over uncommitted work takes the task id typed by the owner.
  const removeWithChanges = dialog.getByRole("button", { name: "Remove with changes" });
  await expect(removeWithChanges).toBeDisabled();
  await dialog.getByRole("textbox").fill(apiTaskId);
  await removeWithChanges.click();
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(/\/$/);
  await expect.poll(() => existsSync(apiTask.folder)).toBe(false);
  expect(git(API_SOURCE, "worktree", "list")).not.toContain(worktree);
  const list = await cmd<{ id: string }[]>(request, "tasks.list", { includeDone: true });
  expect(list.map((t) => t.id)).not.toContain(apiTaskId);
  // The owner's own checkout was never touched.
  expect(git(API_SOURCE, "status", "--porcelain")).toBe("");
});
