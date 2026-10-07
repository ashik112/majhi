import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Task } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { git } from "../testing/fixtures.ts";
import { taskWorld, type World } from "../testing/world.ts";

/**
 * Shipping a task with several repos, against local bare remotes: each repo goes into its own base,
 * repos the task did not change are skipped, and one repo that cannot merge stops them all.
 * `acme-api` and `acme-web` start from main, `acme-ops` from develop. In ops, main and develop
 * have diverged, so merging its task branch into main would conflict.
 */

let w: World;
afterEach(async () => {
  await w?.cleanup();
});

const cmd = (name: string, body?: unknown) => w.h.cmd(name, body);
const tip = (repo: string, ref: string) => git(repo, "rev-parse", ref);
const must = (res: { status: number; body: unknown }) => {
  if (res.status !== 200) throw new Error(`unexpected ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body;
};

async function until(check: () => Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 1000; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

async function commitOn(repo: string, branch: string, file: string, text: string): Promise<void> {
  await git(repo, "checkout", "--quiet", branch);
  await writeFile(join(repo, file), text);
  await git(repo, "add", file);
  await git(repo, "commit", "--quiet", "-m", `${file} on ${branch}`);
  await git(repo, "checkout", "--quiet", "main");
}

/** Prompts the agent got, in order. */
let prompts: string[] = [];

/** ACM-1 on api, web and ops, in review, with a change in each repo of `changes`. */
async function reviewed(changes: string[]): Promise<Task> {
  w = await taskWorld();
  prompts = [];
  await w.addRepo("web");
  await w.addRepo("ops");
  must(await cmd("projects.register", { id: "acme-web", org: "acme", path: "~/Work/web", aliases: ["web"] }));
  must(await cmd("projects.register", { id: "acme-ops", org: "acme", path: "~/Work/ops", aliases: ["ops"] }));
  must(await cmd("projects.update", { id: "acme-ops", org: "acme", aliases: ["ops"], base: "develop" }));
  // ops: main and develop both changed the README.
  await commitOn(w.repo("ops"), "main", "README.md", "# ops on main\n");
  await commitOn(w.repo("ops"), "develop", "README.md", "# ops on develop\n");
  w.h.runtime.onSession = (session) => {
    session.script = async (t) => {
      prompts.push(t.text);
      if (prompts.length === 1) {
        for (const project of changes) {
          await writeFile(join(w.taskDir("ACM-1"), project, "change.txt"), `${project} change\n`);
        }
      }
      t.emit({ type: "text", messageId: `m-${prompts.length}`, text: "Done." });
      return "end_turn";
    };
  };
  must(
    await cmd("tasks.create", {
      text: "update api, web and ops",
      repos: [{ project: "acme-api" }, { project: "acme-web" }, { project: "acme-ops" }],
      start: true,
    }),
  );
  await w.h.majhi.services.runs.idle();
  await until(async () => (await cmd("tasks.get", { id: "ACM-1" })).body.status === "review", "review");
  const task = (await cmd("tasks.get", { id: "ACM-1" })).body as Task;
  expect(task.repos.map((r) => [r.project, r.base])).toEqual([
    ["acme-api", "main"],
    ["acme-web", "main"],
    ["acme-ops", "develop"],
  ]);
  return task;
}

describe("shipping a task with several repos", () => {
  it("a conflict in one changed repo merges nothing anywhere", async () => {
    await reviewed(["acme-api", "acme-web"]);
    await commitOn(w.repo("web"), "main", "change.txt", "main side\n");
    await git(w.repo("web"), "push", "--quiet", "origin", "main");
    const api = await tip(w.repo("api"), "main");
    const web = await tip(w.repo("web"), "main");
    const pushed = await tip(w.remote("api"), "main");

    const res = await cmd("tasks.merge", { id: "ACM-1", into: "main", push: true, done: true });
    expect(res.status).toBe(200);
    expect(res.body.results).toMatchObject([
      { project: "acme-api", ok: false },
      { project: "acme-web", ok: false, conflicts: ["change.txt"] },
      { project: "acme-ops", ok: true, skipped: true },
    ]);
    expect(await tip(w.repo("api"), "main")).toBe(api);
    expect(await tip(w.repo("web"), "main")).toBe(web);
    expect(await tip(w.remote("api"), "main")).toBe(pushed);
    expect((await cmd("tasks.get", { id: "ACM-1" })).body.status).toBe("review");
  });

  it("does not push the owner's own unpushed commits on the target, or create a branch, unless confirmed", async () => {
    await reviewed(["acme-api"]);
    await commitOn(w.repo("api"), "main", "notes.txt", "owner's work\n");
    const local = await tip(w.repo("api"), "main");
    const remote = await tip(w.remote("api"), "main");

    const refused = await cmd("tasks.merge", { id: "ACM-1", into: "main", push: true });
    expect(refused.status).toBe(409);
    expect(await tip(w.repo("api"), "main")).toBe(local);
    expect(await tip(w.remote("api"), "main")).toBe(remote);

    // A target the remote does not have is not created without a yes either.
    await git(w.repo("api"), "branch", "release", "main");
    const missing = await cmd("tasks.merge", {
      id: "ACM-1",
      into: "release",
      push: true,
      pushLocalCommits: true,
    });
    expect(missing.status).toBe(409);
    expect(await git(w.remote("api"), "branch", "--list", "release")).toBe("");

    const sent = await cmd("tasks.merge", { id: "ACM-1", into: "main", push: true, pushLocalCommits: true });
    expect(sent.status).toBe(200);
    expect(await git(w.remote("api"), "show", "main:notes.txt")).toBe("owner's work");
    expect(await git(w.remote("api"), "show", "main:change.txt")).toBe("acme-api change");
  });
});
