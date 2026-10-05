import type { Task } from "@majhi/shared";
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
    expect(await git(w.repo("web"), "branch", "--list", "*/acm-*")).toBe("");
  });
});

describe("the repos of a new task, refusals", () => {
  it("never takes a working branch that already exists: the new one gets a number", async () => {
    await world();
    await git(w.repo("api"), "branch", "fix/acm-1-fix-api", "main");
    const res = await cmd("tasks.create", {
      text: "fix api",
      repos: [{ project: "acme-api" }],
      start: false,
    });
    expect(res.status).toBe(200);
    expect((res.body as Task).repos[0]?.branch).toBe("fix/acm-1-fix-api-2");
  });
});
