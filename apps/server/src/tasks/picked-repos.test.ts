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
