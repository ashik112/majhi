import type { RoomItem, Task } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { git } from "../testing/fixtures.ts";
import { taskWorld, type World } from "../testing/world.ts";

/**
 * A task's repos are only the ones its creator picked. Project names in the brief attach nothing,
 * and the base and working branch never come from its prose.
 */

let w: World;
afterEach(async () => {
  await w?.cleanup();
});

const cmd = (name: string, body?: unknown) => w.h.cmd(name, body);
const notes = async (id: string) =>
  ((await cmd("room.items", { task: id, limit: 100 })).body.items as RoomItem[]).flatMap((i) =>
    i.type === "system" ? [i.text] : [],
  );

async function world(): Promise<World> {
  w = await taskWorld();
  await w.addRepo("web");
  await w.addRepo("ops");
  for (const [id, alias] of [
    ["acme-web", "web"],
    ["acme-ops", "ops"],
  ] as const) {
    const res = await cmd("projects.register", {
      id,
      org: "acme",
      path: `~/Work/${alias}`,
      aliases: [alias],
    });
    expect(res.status).toBe(200);
  }
  return w;
}

describe("the repos of a new task", () => {
  it("a brief that names other projects attaches only the picked repo", async () => {
    await world();
    const res = await cmd("tasks.create", {
      text: "Fix the login in api. The web source is read only, do not change it. List what needs the owner in ops (DNS, ingress, deploy).",
      repos: [{ project: "acme-api" }],
      start: false,
    });
    expect(res.status).toBe(200);
    const task = res.body as Task;
    expect(task.repos.map((r) => r.project)).toEqual(["acme-api"]);
    expect(await notes(task.id)).toContain(
      "Named in the text but not part of this task: acme-web, acme-ops. Agents can read them; nothing there gets a branch or ships.",
    );
    expect(await git(w.repo("web"), "branch", "--list", "task/*")).toBe("");
  });

  it("no repos listed: names in the text attach nothing", async () => {
    await world();
    const res = await cmd("tasks.create", {
      text: "look at api and web",
      kind: "chat",
      org: "acme",
      start: false,
    });
    expect(res.status).toBe(200);
    expect((res.body as Task).repos).toEqual([]);
    const code = await cmd("tasks.create", { text: "fix api", kind: "code", start: false });
    expect(code.status).toBe(400);
    expect(code.body.error).toBe(
      "A code task needs a project. Pick the repos it changes, or change the kind.",
    );
  });

  it("respects an explicit list with a base per repo, and ignores a base or branch in the prose", async () => {
    await world();
    const res = await cmd("tasks.create", {
      text: "move off staging on team/prod: tidy api and ops",
      repos: [{ project: "acme-ops", base: "develop" }, { project: "acme-api" }],
      start: false,
    });
    expect(res.status).toBe(200);
    const task = res.body as Task;
    expect(task.repos.map((r) => [r.project, r.base, r.createdBranch])).toEqual([
      ["acme-ops", "develop", true],
      ["acme-api", "main", true],
    ]);
    for (const r of task.repos) expect(r.branch).toMatch(/^task\/acm-1-/);
  });

  // Real briefs that once gave a bogus branch or base (PRV-87, PRV-68). Keywords are split on purpose.
  it.each([
    ["Fix the crash X o" + "n /profile in api", "code"],
    ["Move the code f" + "rom acme-web into api and fix the imports", "code"],
    ["Fix the API b" + "ase URLs in api", "code"],
    ["Update api: the host is resolved once at startup f" + "rom window.location.hostname", "code"],
    ["Add the screenshot, taken with Playwright, to the api docs", "code"],
    ["Fix the api, work o" + "n main later", "code"],
    ["Update api to use the default b" + "ranch name", "code"],
  ])("keeps the project base and a new task branch for: %s", async (text, kind) => {
    await world();
    const res = await cmd("tasks.create", { text, repos: [{ project: "acme-api" }], start: false });
    expect(res.status).toBe(200);
    const task = res.body as Task;
    expect(task.kind).toBe(kind);
    expect(task.repos.map((r) => [r.project, r.base, r.createdBranch])).toEqual([["acme-api", "main", true]]);
    expect(task.repos[0]?.branch).toMatch(/^task\/acm-1-/);
  });

  // Whole briefs the way leads write them, with the title given apart (PRV-64, PRV-66).
  it.each([
    {
      title: "Add screenshots to the api docs",
      text: "Take the screenshots with the Playwright tool, the ones taken with Playwright last week are stale.\nWork on main later, once the docs build is green.",
      slug: "task/acm-1-add-screenshots-to-the-api-docs",
    },
    {
      title: "Task text picks the base branch by mistake",
      text: "In api, the parser reads the base branch from prose. It should use the default branch.\nMention the branch field in the docs.",
      slug: "task/acm-1-task-text-picks-the-base-branch-by-mista",
    },
    {
      title: "Move the login off staging",
      text: "Product names like Acme Cloud, GitHub and Docker appear here.\nThe api branch protection stays as it is. Rebase on develop is not needed.",
      slug: "task/acm-1-move-the-login-off-staging",
    },
  ])(
    "a brief with prose about branches keeps the base and every title word: $title",
    async ({ title, text, slug }) => {
      await world();
      const res = await cmd("tasks.create", { title, text, repos: [{ project: "acme-api" }], start: false });
      expect(res.status).toBe(200);
      const task = res.body as Task;
      expect(task.repos.map((r) => [r.base, r.branch])).toEqual([["main", slug]]);
    },
  );

  it("starts from the project's base, with a warning, when the picked base is not in the repo", async () => {
    await world();
    const res = await cmd("tasks.create", {
      text: "fix api",
      repos: [
        { project: "acme-api", base: "Playwright" },
        { project: "acme-web", base: "develop" },
      ],
      start: false,
    });
    expect(res.status).toBe(200);
    const task = res.body as Task;
    expect(task.repos.map((r) => [r.project, r.base])).toEqual([
      ["acme-api", "main"],
      ["acme-web", "develop"],
    ]);
    const items = (await cmd("room.items", { task: task.id, limit: 100 })).body.items as RoomItem[];
    expect(items).toContainEqual(
      expect.objectContaining({
        level: "warn",
        text: "acme-api has no branch Playwright. Starting from main instead. To change it before the task starts, update its base.",
      }),
    );
  });
});

describe("changing the starting branch", () => {
  const create = async (repos: { project: string }[] = [{ project: "acme-api" }]) =>
    (await cmd("tasks.create", { text: "fix api", repos, start: false })).body as Task;

  it("moves the base of a task in the inbox, and its worktree starts there", async () => {
    await world();
    await git(w.repo("api"), "checkout", "--quiet", "develop");
    await git(w.repo("api"), "commit", "--quiet", "--allow-empty", "-m", "only on develop");
    await git(w.repo("api"), "push", "--quiet", "origin", "develop");
    await git(w.repo("api"), "checkout", "--quiet", "main");
    const tip = await git(w.repo("api"), "rev-parse", "develop");
    const task = await create();
    const res = await cmd("tasks.update", { id: task.id, base: "develop" });
    expect(res.status).toBe(200);
    expect((res.body as Task).repos[0]?.base).toBe("develop");
    expect(await notes(task.id)).toContain("Starting branch: develop, was main.");

    const started = await cmd("tasks.start", { id: task.id });
    expect(started.status).toBe(200);
    const worktree = (started.body as Task).repos[0]?.worktree ?? "";
    expect(await git(worktree, "rev-parse", "HEAD")).toBe(tip);
    // Started: the base stays.
    const late = await cmd("tasks.update", { id: task.id, base: "main" });
    expect(late.status).toBe(409);
    expect(late.body.error).toBe(
      `${task.id} has started, so its starting branch stays develop. Only a task that has not started can change it.`,
    );
  });

  it("refuses a base the repo does not have, and keeps the old one", async () => {
    await world();
    const task = await create();
    const res = await cmd("tasks.update", { id: task.id, base: "branch" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("acme-api has no branch branch. The starting branch stays main.");
    expect(((await cmd("tasks.get", { id: task.id })).body as Task).repos[0]?.base).toBe("main");
  });

  it("asks which repo when the task has more than one", async () => {
    await world();
    const task = await create([{ project: "acme-api" }, { project: "acme-web" }]);
    const bare = await cmd("tasks.update", { id: task.id, base: "develop" });
    expect(bare.status).toBe(400);
    expect(bare.body.error).toContain("has more than one repo. Say which with project: acme-api, acme-web.");
    const res = await cmd("tasks.update", { id: task.id, base: "develop", project: "acme-web" });
    expect(res.status).toBe(200);
    expect((res.body as Task).repos.map((r) => [r.project, r.base])).toEqual([
      ["acme-api", "main"],
      ["acme-web", "develop"],
    ]);
  });
});

describe("the repos of a new task, refusals", () => {
  it("refuses a working branch that already exists", async () => {
    await world();
    await git(w.repo("api"), "branch", "task/acm-1-fix-api", "main");
    const res = await cmd("tasks.create", {
      text: "fix api",
      repos: [{ project: "acme-api" }],
      start: false,
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("acme-api already has a branch task/acm-1-fix-api.");
  });

  it("refuses a project that is not registered", async () => {
    await world();
    const res = await cmd("tasks.create", { text: "fix it", repos: [{ project: "acme-db" }], start: false });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Project "acme-db" does not exist.');
  });
});
