import { chmod, rm, writeFile } from "node:fs/promises";
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
  it("squash and push sends only the changed repo, into its base, and skips the others", async () => {
    await reviewed(["acme-api"]);
    const ops = { main: await tip(w.repo("ops"), "main"), develop: await tip(w.repo("ops"), "develop") };
    const web = await tip(w.repo("web"), "main");

    const options = must(await cmd("tasks.shipOptions", { id: "ACM-1" })) as Record<string, unknown>;
    expect(options.changed).toEqual([{ project: "acme-api", base: "main", branch: expect.any(String) }]);
    expect(options.unchanged).toEqual(["acme-web", "acme-ops"]);

    const res = await cmd("tasks.merge", {
      id: "ACM-1",
      into: "main",
      push: true,
      method: "squash",
      done: true,
    });
    expect(res.status).toBe(200);
    expect(res.body.results).toMatchObject([
      { project: "acme-api", into: "main", ok: true, detail: "Pushed main to origin." },
      { project: "acme-web", ok: true, skipped: true },
      { project: "acme-ops", ok: true, skipped: true },
    ]);
    expect(res.body.task.status).toBe("done");
    expect(await git(w.remote("api"), "show", "main:change.txt")).toBe("acme-api change");
    expect(await tip(w.remote("api"), "main")).toBe(await tip(w.repo("api"), "main"));
    // Nothing touched in the unchanged repos: no merge into main was tried for ops.
    expect(await tip(w.repo("ops"), "main")).toBe(ops.main);
    expect(await tip(w.repo("ops"), "develop")).toBe(ops.develop);
    expect(await tip(w.repo("web"), "main")).toBe(web);
    expect(await tip(w.remote("ops"), "main")).not.toBe(ops.main);
  });

  it("a conflict in one changed repo merges nothing anywhere", async () => {
    await reviewed(["acme-api", "acme-web"]);
    await commitOn(w.repo("web"), "main", "change.txt", "main side\n");
    const api = await tip(w.repo("api"), "main");
    const web = await tip(w.repo("web"), "main");
    const pushed = await tip(w.remote("api"), "main");

    const res = await cmd("tasks.merge", { id: "ACM-1", into: "main", push: true, done: true });
    expect(res.status).toBe(200);
    expect(res.body.results).toMatchObject([
      { project: "acme-api", ok: false, detail: "Not merged: acme-web cannot merge, so nothing was merged." },
      { project: "acme-web", ok: false, conflicts: ["change.txt"] },
      { project: "acme-ops", ok: true, skipped: true },
    ]);
    expect(await tip(w.repo("api"), "main")).toBe(api);
    expect(await tip(w.repo("web"), "main")).toBe(web);
    expect(await tip(w.remote("api"), "main")).toBe(pushed);
    expect((await cmd("tasks.get", { id: "ACM-1" })).body.status).toBe("review");
  });

  it("a push that fails after the merges says which repo is merged and not pushed; Push again sends it", async () => {
    await reviewed(["acme-api", "acme-web"]);
    const hook = join(w.remote("web"), "hooks", "pre-receive");
    await writeFile(hook, "#!/bin/sh\necho 'closed for now' >&2\nexit 1\n");
    await chmod(hook, 0o755);

    const first = await cmd("tasks.merge", { id: "ACM-1", into: "main", push: true, done: true });
    expect(first.status).toBe(200);
    expect(first.body.results).toMatchObject([
      { project: "acme-api", ok: true, detail: "Pushed main to origin." },
      { project: "acme-web", ok: false, notPushed: true },
      { project: "acme-ops", skipped: true },
    ]);
    expect(first.body.results[1].detail).toMatch(/^Merged into main, but /);
    expect(await git(w.repo("web"), "show", "main:change.txt")).toBe("acme-web change");
    expect(first.body.task.status).toBe("review");

    await rm(hook);
    const again = await cmd("tasks.merge", { id: "ACM-1", into: "main", push: true, done: true });
    expect(again.status).toBe(200);
    expect(again.body.results).toMatchObject([
      { project: "acme-api", ok: true },
      { project: "acme-web", ok: true, detail: "Pushed main to origin." },
      { project: "acme-ops", skipped: true },
    ]);
    expect(await tip(w.remote("web"), "main")).toBe(await tip(w.repo("web"), "main"));
    expect(again.body.task.status).toBe("done");
  });

  it("one target covers only the repos on that base; each other repo goes into its own", async () => {
    await reviewed(["acme-api", "acme-ops"]);
    const opsMain = await tip(w.repo("ops"), "main");

    const refused = await cmd("tasks.merge", { id: "ACM-1", into: "staging" });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe(
      "The repos start from different branches (acme-api on main, acme-ops on develop), so staging is not a target for all of them. Pick a target for each repo.",
    );

    const res = await cmd("tasks.merge", { id: "ACM-1", into: "main" });
    expect(res.status).toBe(200);
    expect(res.body.results).toMatchObject([
      { project: "acme-api", into: "main", ok: true },
      { project: "acme-ops", into: "develop", ok: true },
      { project: "acme-web", skipped: true },
    ]);
    expect(await git(w.repo("api"), "show", "main:change.txt")).toBe("acme-api change");
    expect(await git(w.repo("ops"), "show", "develop:change.txt")).toBe("acme-ops change");
    expect(await tip(w.repo("ops"), "main")).toBe(opsMain);
  });

  it("per-repo targets are respected", async () => {
    await reviewed(["acme-api", "acme-ops"]);
    const apiMain = await tip(w.repo("api"), "main");
    const res = await cmd("tasks.merge", { id: "ACM-1", targets: { "acme-api": "develop" } });
    expect(res.status).toBe(200);
    expect(res.body.results).toMatchObject([
      { project: "acme-api", into: "develop", ok: true },
      { project: "acme-ops", into: "develop", ok: true },
      { project: "acme-web", skipped: true },
    ]);
    expect(await git(w.repo("api"), "show", "develop:change.txt")).toBe("acme-api change");
    expect(await tip(w.repo("api"), "main")).toBe(apiMain);

    const unknown = await cmd("tasks.merge", { id: "ACM-1", targets: { "acme-db": "main" } });
    expect(unknown.status).toBe(409);
    expect(unknown.body.error).toBe("acme-db is not a repo of this task.");
  });

  it("resolve and ship asks the lead only about changed repos that conflict", async () => {
    const task = await reviewed(["acme-api", "acme-web"]);
    await commitOn(w.repo("web"), "main", "change.txt", "main side\n");
    const res = await cmd("tasks.resolveShip", { id: "ACM-1", action: "merge", into: "main" });
    expect(res.status).toBe(200);
    expect(res.body.task.pendingShip).toMatchObject({
      into: "main",
      targets: { "acme-api": "main", "acme-web": "main" },
    });
    await w.h.majhi.services.runs.idle();
    const ask = prompts.find((p) => p.includes("Shipping hit conflicts"));
    const web = task.repos.find((r) => r.project === "acme-web")?.branch;
    expect(ask).toContain(`${web} in acme-web conflicts with main in change.txt.`);
    expect(ask).toContain("Only acme-web needs this");
    expect(ask).not.toContain("acme-ops");
    expect(ask).not.toContain("in acme-api conflicts");
  });
});
