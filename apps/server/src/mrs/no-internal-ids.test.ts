import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Task } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { forgetRepoStyles } from "../tasks/branch-naming.ts";
import { git, tempDir } from "../testing/fixtures.ts";
import { type FakeHosts, fakeHosts } from "../testing/mrHosts.ts";
import { taskWorld, type World } from "../testing/world.ts";
import type { MrDeps } from "./service.ts";

/**
 * majhi's own task id and its bookkeeping (checkpoint commits, the `Majhi-Task` trailer) never reach
 * a client repo: not in a branch name, a commit, a merge request, nor a merge commit. Local bare
 * repos and fake `gh` stand in for the host.
 */

let w: World;
let fake: FakeHosts;
let cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await w?.cleanup();
  for (const c of cleanups) await c();
  cleanups = [];
  forgetRepoStyles();
});

const cmd = (name: string, body?: unknown) => w.h.cmd(name, body);

/** The api repo names its branches by issue key (`ABC-1/...`), and the task changes a file with checkpoints. */
async function reviewed(): Promise<Task> {
  const t = await tempDir();
  cleanups.push(t.cleanup);
  fake = await fakeHosts(join(t.dir, "bin"));
  w = await taskWorld({ mrHosts: { bins: fake.bins } });
  for (const name of ["ABC-1/login", "ABC-2/logout", "ABC-3/profile"]) {
    await git(w.repo("api"), "branch", name, "main");
  }
  forgetRepoStyles();
  const deps = (w.h.majhi.services.mrs as unknown as { deps: MrDeps }).deps;
  deps.hostOf = () => "github";
  await fake.addRepo("remotes/api", w.remote("api"));
  await cmd("secrets.save", { name: "gh-acme", value: "gh-token-1" });
  await cmd("orgs.update", { id: "acme", mr_tokens: { github: "secret:gh-acme" } });
  w.h.runtime.onSession = (session) => {
    session.script = async (turn) => {
      await writeFile(join(w.taskDir("ACM-1"), "acme-api", "greeting.txt"), "hello\n");
      turn.emit({ type: "text", messageId: "m", text: "Done." });
      return "end_turn";
    };
  };
  const made = await cmd("tasks.create", {
    text: "fix the greeting",
    repos: [{ project: "acme-api" }],
    start: true,
  });
  expect(made.status).toBe(200);
  await w.h.majhi.services.runs.idle();
  const task = (await cmd("tasks.get", { id: "ACM-1" })).body as Task;
  expect(task.status).toBe("review");
  return task;
}

const taskBranch = async (): Promise<string> =>
  ((await cmd("tasks.get", { id: "ACM-1" })).body as Task).repos[0]?.branch ?? "";

/** Subject and body of every commit `range` lists, with the ref names, as one text to search. */
const history = (repo: string, range: string): Promise<string> =>
  git(repo, "log", "--format=%an|%cn|%B", range);

const leaks = (text: string): boolean =>
  text.toLowerCase().includes("acm-1") || text.includes("Majhi-Task") || text.includes("wip(");

describe("no internal ids in client git", () => {
  it("keeps the task id and checkpoints out of the branch, commits, merge request and merge", async () => {
    const task = await reviewed();
    // A branch made before this rule: it carries the task id and was never pushed.
    const legacy = "fix/acm-1-fix-the-greeting";
    await git(w.repo("api"), "branch", "--move", task.repos[0]?.branch ?? "", legacy);
    w.h.majhi.services.store.tasks.setBranch("ACM-1", "acme-api", legacy);
    expect(await history(w.repo("api"), legacy)).toContain("wip(ACM-1): checkpoint 1");

    const opened = await cmd("tasks.openMrs", { id: "ACM-1" });
    expect(opened.status).toBe(200);

    const branch = await taskBranch();
    expect(branch).toBe("fix/fix-the-greeting");
    expect(await git(w.remote("api"), "branch", "--list")).not.toContain("acm-1");
    const pushed = await history(w.remote("api"), `main..${branch}`);
    expect(leaks(pushed)).toBe(false);
    expect(pushed.match(/\|/g)?.length).toBe(2);
    const [pr] = (await fake.state()).prs["remotes/api"] ?? [];
    expect(pr?.head).toBe(branch);
    expect(leaks(`${pr?.title}\n${pr?.body}`)).toBe(false);
    expect(pr?.title).toBe("Fix the greeting");

    // The same branch merged here, as a merge commit and as a squash, leaves no id either.
    const merged = await cmd("tasks.merge", { id: "ACM-1", into: "main", done: true, method: "squash" });
    expect(merged.status).toBe(200);
    expect(leaks(await history(w.repo("api"), "-3"))).toBe(false);
  });

  it("never rewrites a branch the remote already has", async () => {
    const task = await reviewed();
    const branch = task.repos[0]?.branch ?? "";
    const worktree = join(w.taskDir("ACM-1"), "acme-api");
    await git(worktree, "push", "--quiet", "origin", `${branch}:${branch}`);
    const tip = (await git(w.repo("api"), "rev-parse", branch)).trim();

    expect((await cmd("tasks.openMrs", { id: "ACM-1" })).status).toBe(200);

    expect((await git(w.repo("api"), "rev-parse", branch)).trim()).toBe(tip);
    expect((await git(w.remote("api"), "rev-parse", branch)).trim()).toBe(tip);
  });
});
