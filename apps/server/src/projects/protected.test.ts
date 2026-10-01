import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RoomItem, Task } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { readOnlyRepos, repoMounts } from "../runs/launch.ts";
import { git } from "../testing/fixtures.ts";
import { taskWorld, type World } from "../testing/world.ts";
import { infraName } from "./infra.ts";

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
const notes = async (id: string) =>
  ((await cmd("room.items", { task: id, limit: 100 })).body.items as RoomItem[]).flatMap((i) =>
    i.type === "system" ? [i.text] : [],
  );

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
  it("names that look like infra are offered protection", async () => {
    expect(
      ["acme-gitops", "deploy-scripts", "ops", "infra", "k8s-config", "terraform-aws"].map(infraName),
    ).toEqual([true, true, true, true, true, true]);
    expect(["acme-api", "web", "shop"].map(infraName)).toEqual([false, false, false]);
    await world();
    const list = (await cmd("projects.list")).body as {
      id: string;
      protected: boolean;
      looksLikeInfra?: boolean;
    }[];
    expect(list.find((p) => p.id === "acme-ops")).toMatchObject({ protected: true });
    expect(list.find((p) => p.id === "acme-api")?.looksLikeInfra).toBeUndefined();
  });

  it("an agent never adds one to a task: it is left out and the room says so", async () => {
    await world();
    const res = await cmd(
      "tasks.create",
      { text: "update api and ops", repos: [{ project: "acme-api" }, { project: "acme-ops" }], start: false },
      AGENT,
    );
    expect(res.status).toBe(200);
    expect((res.body as Task).repos.map((r) => r.project)).toEqual(["acme-api"]);
    expect(await notes(res.body.id)).toContain(
      "Left out acme-ops: it is protected, so only you can add it to a task. Agents can still read it.",
    );
    const alone = await cmd(
      "tasks.create",
      { text: "change ops", repos: [{ project: "acme-ops" }], start: false },
      AGENT,
    );
    expect(alone.status).toBe(409);
    expect(alone.body.error).toBe("acme-ops is protected: only the owner can add it to a task.");
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
    expect(both.body.results[1].detail).toMatch(/^Protected: not shipped with the others\./);
    expect(both.body.task.status).toBe("review");
    expect(await tip(w.repo("ops"), "main")).toBe(ops);

    const untyped = await cmd("tasks.merge", { id: "ACM-1", project: "acme-ops", push: true });
    expect(untyped.status).toBe(409);
    expect(untyped.body.error).toBe("acme-ops is protected. Type its name to ship it.");
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

  it("resolve and ship never takes it, and a push or merge request leaves it out", async () => {
    await world();
    await changedInBoth();
    const pushed = await cmd("tasks.push", { id: "ACM-1" });
    expect(pushed.status).toBe(200);
    expect(pushed.body.results).toMatchObject([
      { project: "acme-api", ok: true },
      { project: "acme-ops", skipped: true },
    ]);
    const branch = ((await cmd("tasks.get", { id: "ACM-1" })).body as Task).repos[1]?.branch ?? "";
    expect(await git(w.remote("ops"), "branch", "--list", branch)).toBe("");

    // A conflict only in ops: nothing that may ship conflicts, so nothing is asked of the lead.
    await writeFile(join(w.repo("ops"), "change.txt"), "main side\n");
    await git(w.repo("ops"), "add", "change.txt");
    await git(w.repo("ops"), "commit", "--quiet", "-m", "main side");
    const resolve = await cmd("tasks.resolveShip", { id: "ACM-1", action: "merge", into: "main" });
    expect(resolve.status).toBe(409);
    expect(resolve.body.error).toBe("Nothing conflicts with main now. Ship again.");
  });

  it("agent runs get its worktree read-only, unless the owner allowed writes for the task", async () => {
    await world();
    const locked = await changedInBoth();
    const config = w.h.majhi.services.config;
    const ops = locked.repos.find((r) => r.project === "acme-ops");
    expect([...(await readOnlyRepos(config, locked))]).toEqual(["acme-ops"]);
    const mounts = await repoMounts(locked, await readOnlyRepos(config, locked));
    expect(mounts).toContainEqual({ path: ops?.worktree, readOnly: true });
    expect(mounts.some((m) => m.path === join(w.repo("ops"), ".git") && m.readOnly !== true)).toBe(false);
    expect(mounts.some((m) => m.path === join(w.repo("api"), ".git") && m.readOnly !== true)).toBe(true);
  });

  it("allow writes: the owner's choice for one task", async () => {
    await world();
    const open = await changedInBoth(true);
    expect(open.repos.find((r) => r.project === "acme-ops")?.writes).toBe(true);
    expect([...(await readOnlyRepos(w.h.majhi.services.config, open))]).toEqual([]);
  });
});
