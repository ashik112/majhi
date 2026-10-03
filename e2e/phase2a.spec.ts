import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { expect, HOST_HOME, MAJHI_HOME, test, useHome } from "./fixture.ts";

// Org Acme with its agents. One task on api, from registering the project to removing the task.
// The fake Claude adapter pauses 120 ms between the steps of a turn, so the turn can be watched.
// The room's other flows are in phase2a-room.spec.ts.
useHome({ seed: "team", slow: { claude: 120 } });
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

test("register a repo as a project from the Projects page", async ({ page, request }) => {
  await page.goto("/projects");
  await page.getByRole("button", { name: "Register alpha-api" }).click();
  const dialog = page.getByRole("dialog", { name: "Register alpha-api" });
  await dialog.getByRole("combobox", { name: "Workspace" }).selectOption({ label: "Acme" });
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
  await expect(page.getByRole("heading", { level: 1 })).toContainText("health endpoint");

  // The turn streams: the owner's text, pinned plan, text, tools, a permission answered by rule, the final message.
  const log = messages(page);
  await expect(log.getByText("add a health endpoint to api from develop")).toBeVisible();
  await expect(log.getByText(/@acme-lead started on claude-acme-1/)).toBeVisible();
  // The fixture remote does not exist, so the fetch fails; the task starts from the local copy.
  await expect(log.getByText(/Could not fetch \S+ from origin/)).toBeVisible();
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
  // The base is the project's, never a branch named in the words.
  expect(repo).toMatchObject({ project: "api" });
  expect(apiTask.folder.endsWith(`/${apiTaskId}`)).toBe(true);
  const worktree = join(apiTask.folder, "api");
  expect(repo?.worktree).toBe(worktree);
  expect(existsSync(join(worktree, ".git"))).toBe(true);
  const branch = git(worktree, "rev-parse", "--abbrev-ref", "HEAD");
  expect(branch).toMatch(new RegExp(`^task/${apiTaskId.toLowerCase()}-`));
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
  // The checkpoint lands a moment after the room shows the agent idle.
  await expect
    .poll(() => git(worktree, "log", "-1", "--format=%s"))
    .toMatch(/^wip\([A-Z]+-\d+\): checkpoint \d+$/);
  expect(git(worktree, "show", "--name-only", "--format=", "HEAD")).toContain("HEALTH.md");
  expect(git(worktree, "status", "--porcelain")).toBe("");
  // The agent is the committer, and the message links the commit to its task.
  expect(git(worktree, "log", "-1", "--format=%cn|%ce")).toBe("acme-lead via majhi|majhi@majhi.local");
  expect(git(worktree, "log", "-1", "--format=%(trailers:key=Majhi-Task,valueonly)")).toBe(apiTaskId);

  const changes = panel(page);
  await expect(changes.getByRole("heading", { name: "Changes" })).toBeVisible();
  await expect(changes.getByRole("region", { name: "Branch and worktree" })).toContainText("main");
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
  await page.getByRole("navigation", { name: "Workspaces" }).getByRole("button", { name: /^Acme/ }).click();
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
  await expect(dialog.getByText("These changes are in no commit")).toBeVisible();
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
