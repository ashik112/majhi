import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Task } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { readOnlyRepos, repoMounts } from "../runs/launch.ts";
import { git } from "../testing/fixtures.ts";
import { taskWorld, type World } from "../testing/world.ts";

/**
 * A protected project (infra): never added to a task but by the owner, read-only for agents unless
 * the owner allows writes, and shipped only alone with its name typed.
 */

let w: World;
afterEach(async () => {
  await w?.cleanup();
});

const cmd = (name: string, body?: unknown, meta?: unknown) => w.h.cmd(name, body, meta);
const AGENT = { actor: { kind: "agent", id: "acme-builder" }, reason: "for the test" };
const tip = (repo: string, ref: string) => git(repo, "rev-parse", ref);

/** acme-api, and acme-ops protected. */
async function world(): Promise<void> {
  w = await taskWorld({ noAgent: false });
  await w.addRepo("ops");
  expect(
    (await cmd("projects.register", { id: "acme-ops", org: "acme", path: "~/Work/ops", aliases: ["ops"] }))
      .status,
  ).toBe(200);
  const res = await cmd("projects.update", {
    id: "acme-ops",
    org: "acme",
    aliases: ["ops"],
    protected: true,
  });
  expect(res.body.protected).toBe(true);
}

/** ACM-1 on api and ops, made by the owner, with a commit in each worktree. */
async function changedInBoth(writes = false): Promise<Task> {
  const res = await cmd("tasks.create", {
    text: "update api and ops",
    repos: [{ project: "acme-api" }, { project: "acme-ops", writes }],
    start: false,
  });
  expect(res.status).toBe(200);
  const task = (await cmd("tasks.start", { id: "ACM-1" })).body as Task;
  await w.h.majhi.services.runs.idle();
  for (const project of ["acme-api", "acme-ops"]) {
    const tree = join(w.taskDir("ACM-1"), project);
    await writeFile(join(tree, "change.txt"), `${project}\n`);
    await git(tree, "add", "change.txt");
    await git(tree, "commit", "--quiet", "-m", "change");
  }
  return (await cmd("tasks.get", { id: task.id })).body as Task;
}

describe("protected projects", () => {
  it("an agent never adds one to a task: it is left out and the room says so", async () => {
    await world();
    const res = await cmd(
      "tasks.create",
      { text: "update api and ops", repos: [{ project: "acme-api" }, { project: "acme-ops" }], start: false },
      AGENT,
    );
    expect(res.status).toBe(200);
    expect((res.body as Task).repos.map((r) => r.project)).toEqual(["acme-api"]);
    const alone = await cmd(
      "tasks.create",
      { text: "change ops", repos: [{ project: "acme-ops" }], start: false },
      AGENT,
    );
    expect(alone.status).toBe(409);
    // An agent cannot take the protection off.
    const off = await cmd(
      "projects.update",
      { id: "acme-ops", org: "acme", aliases: ["ops"], protected: false },
      AGENT,
    );
    expect(off.status).toBe(409);
  });

  it("is never in a ship with other repos, and ships alone only with its name typed", async () => {
    await world();
    await changedInBoth();
    const ops = await tip(w.repo("ops"), "main");

    const options = (await cmd("tasks.shipOptions", { id: "ACM-1" })).body;
    expect(options.changed.map((r: { project: string }) => r.project)).toEqual(["acme-api"]);
    expect(options.protected.map((r: { project: string }) => r.project)).toEqual(["acme-ops"]);

    const both = await cmd("tasks.merge", { id: "ACM-1", into: "main", push: true, done: true });
    expect(both.status).toBe(200);
    expect(both.body.results).toMatchObject([
      { project: "acme-api", ok: true },
      { project: "acme-ops", skipped: true },
    ]);
    expect(both.body.task.status).toBe("review");
    expect(await tip(w.repo("ops"), "main")).toBe(ops);

    const untyped = await cmd("tasks.merge", { id: "ACM-1", project: "acme-ops", push: true });
    expect(untyped.status).toBe(409);
    const wrong = await cmd("tasks.merge", { id: "ACM-1", project: "acme-ops", confirmProtected: "ops" });
    expect(wrong.status).toBe(409);
    const byAgent = await cmd(
      "tasks.merge",
      { id: "ACM-1", project: "acme-ops", confirmProtected: "acme-ops" },
      AGENT,
    );
    expect(byAgent.status).toBe(409);
    expect(await tip(w.repo("ops"), "main")).toBe(ops);

    const typed = await cmd("tasks.merge", {
      id: "ACM-1",
      project: "acme-ops",
      confirmProtected: "acme-ops",
      push: true,
    });
    expect(typed.status).toBe(200);
    expect(typed.body.results).toMatchObject([{ project: "acme-ops", ok: true }]);
    expect(await git(w.remote("ops"), "show", "main:change.txt")).toBe("acme-ops");
  });

  it("agent runs get its worktree read-only, unless the owner allowed writes for the task", async () => {
    await world();
    const locked = await changedInBoth();
    const config = w.h.majhi.services.config;
    const ops = locked.repos.find((r) => r.project === "acme-ops");
    expect([...(await readOnlyRepos(config, locked))]).toEqual(["acme-ops"]);
    const mounts = await repoMounts(locked, { readOnly: await readOnlyRepos(config, locked) });
    expect(mounts).toContainEqual({ path: ops?.worktree, readOnly: true });
    expect(mounts.some((m) => m.path === join(w.repo("ops"), ".git") && m.readOnly !== true)).toBe(false);
    expect(mounts.some((m) => m.path === join(w.repo("api"), ".git") && m.readOnly !== true)).toBe(true);
  });
});
