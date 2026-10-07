import { stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { git, tempDir } from "../testing/fixtures.ts";
import { seedStatus } from "../testing/status.ts";
import { taskWorld, type World } from "../testing/world.ts";

/** Ship's pushes against a local bare remote: never forced, and refused with the fix when they cannot work. */

let w: World;
let cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await w?.cleanup();
  for (const c of cleanups) await c();
  cleanups = [];
});

const cmd = (name: string, body?: unknown) => w.h.cmd(name, body);
const branch = "fix/acm-1-fix-api";
const tip = (repo: string, ref: string) => git(repo, "rev-parse", ref).then((s) => s.trim());
const present = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

/** ACM-1 on api, in review, with one committed change on its branch. */
async function reviewed(): Promise<void> {
  w = await taskWorld();
  w.h.runtime.onSession = (session) => {
    session.script = async (t) => {
      await writeFile(join(w.taskDir("ACM-1"), "acme-api", "fix.txt"), "fix\n");
      t.emit({ type: "text", messageId: "m", text: "Done." });
      return "end_turn";
    };
  };
  expect(
    (await cmd("tasks.create", { text: "fix api", repos: [{ project: "acme-api" }], start: true })).status,
  ).toBe(200);
  await w.h.majhi.services.runs.idle();
  expect((await cmd("tasks.get", { id: "ACM-1" })).body.status).toBe("review");
}

/** Someone else pushes a commit to `ref` on the remote. */
async function pushFromElsewhere(ref: string): Promise<string> {
  const t = await tempDir();
  cleanups.push(t.cleanup);
  const clone = join(t.dir, "other");
  await git(t.dir, "clone", "--quiet", w.remote("api"), clone);
  await git(clone, "checkout", "--quiet", "-B", ref, `origin/${ref}`);
  await writeFile(join(clone, "other.txt"), "other\n");
  await git(clone, "add", ".");
  await git(
    clone,
    "-c",
    "user.name=Other",
    "-c",
    "user.email=other@example.com",
    "commit",
    "--quiet",
    "-m",
    "other",
  );
  await git(clone, "push", "--quiet", "origin", `${ref}:${ref}`);
  return tip(clone, "HEAD");
}

describe("Ship", () => {
  it("merges into main and pushes main, then marks the task done", async () => {
    await reviewed();
    const res = await cmd("tasks.merge", { id: "ACM-1", into: "main", push: true, done: true });
    expect(res.status).toBe(200);
    expect(res.body.results).toMatchObject([{ project: "acme-api", into: "main", ok: true }]);
    expect(res.body.task.status).toBe("done");
    expect(await tip(w.remote("api"), "main")).toBe(await tip(w.repo("api"), "main"));
    expect(await git(w.remote("api"), "ls-tree", "--name-only", "main")).toContain("fix.txt");
  });

  it("refuses to merge and push when the remote branch moved, and changes nothing", async () => {
    await reviewed();
    const theirs = await pushFromElsewhere("main");
    const before = await tip(w.repo("api"), "main");
    const res = await cmd("tasks.merge", { id: "ACM-1", into: "main", push: true, done: true });
    expect(res.status).toBe(409);
    // Nothing merged locally, nothing overwritten on the remote.
    expect(await tip(w.repo("api"), "main")).toBe(before);
    expect(await tip(w.remote("api"), "main")).toBe(theirs);
    expect((await cmd("tasks.get", { id: "ACM-1" })).body.status).toBe("review");
  });

  it("pushes the task branch, and never forces over a branch that moved on the remote", async () => {
    await reviewed();
    const first = await cmd("tasks.push", { id: "ACM-1" });
    expect(first.status).toBe(200);
    expect(first.body.results).toMatchObject([{ project: "acme-api", into: branch, ok: true }]);
    expect(await tip(w.remote("api"), branch)).toBe(await tip(w.repo("api"), branch));

    const theirs = await pushFromElsewhere(branch);
    const second = await cmd("tasks.push", { id: "ACM-1" });
    expect(second.status).toBe(200);
    expect(second.body.results[0]).toMatchObject({ ok: false });
    expect(await tip(w.remote("api"), branch)).toBe(theirs);
  });

  it("squashes into main, marks it done, then deletes the task branch and its worktree", async () => {
    await reviewed();
    const res = await cmd("tasks.merge", {
      id: "ACM-1",
      into: "main",
      done: true,
      method: "squash",
      deleteAfter: true,
    });
    expect(res.status).toBe(200);
    expect(res.body.results).toMatchObject([{ ok: true }]);
    expect(res.body.task.status).toBe("done");
    expect(res.body.task.repos[0].worktree).toBeUndefined();
    expect(await git(w.repo("api"), "show", "main:fix.txt")).toBe("fix");
    expect(await git(w.repo("api"), "branch", "--list", branch)).toBe("");
    expect(await present(join(w.taskDir("ACM-1"), "acme-api"))).toBe(false);
  });

  it("refuses delete after while the worktree has uncommitted files, before merging anything", async () => {
    await reviewed();
    await writeFile(join(w.taskDir("ACM-1"), "acme-api", "scratch.txt"), "not committed\n");
    const before = await tip(w.repo("api"), "main");
    const res = await cmd("tasks.merge", { id: "ACM-1", into: "main", done: true, deleteAfter: true });
    expect(res.status).toBe(409);
    expect(await tip(w.repo("api"), "main")).toBe(before);
    expect((await cmd("tasks.get", { id: "ACM-1" })).body.status).toBe("review");
    expect(await present(join(w.taskDir("ACM-1"), "acme-api", "scratch.txt"))).toBe(true);
  });

  it("deletes nothing when the push fails, and keeps the remote branch when it works", async () => {
    await reviewed();
    expect((await cmd("tasks.push", { id: "ACM-1" })).status).toBe(200);
    await pushFromElsewhere(branch);
    const failed = await cmd("tasks.push", { id: "ACM-1", deleteAfter: true });
    expect(failed.body.results[0]).toMatchObject({ ok: false });
    expect(await present(join(w.taskDir("ACM-1"), "acme-api"))).toBe(true);
    expect(await git(w.repo("api"), "branch", "--list", branch)).not.toBe("");

    // Back in step with the remote: the agent's commit goes on top of theirs, then the push works.
    const tree = join(w.taskDir("ACM-1"), "acme-api");
    await git(tree, "pull", "--quiet", "--no-rebase", "--no-edit", "origin", branch);
    const pushed = await cmd("tasks.push", { id: "ACM-1", deleteAfter: true });
    expect(pushed.body.results[0]).toMatchObject({ ok: true });
    expect(await present(tree)).toBe(false);
    expect(await git(w.repo("api"), "branch", "--list", branch)).toBe("");
    expect(await git(w.remote("api"), "branch", "--list", branch)).not.toBe("");
  });

  it("keeps Ship open on a done task until its work is pushed, without reopening it", async () => {
    await reviewed();
    const { store } = w.h.majhi.services;
    seedStatus(store, "ACM-1", "done", undefined, new Date().toISOString());
    let options = (await cmd("tasks.shipOptions", { id: "ACM-1" })).body;
    expect(options).toMatchObject({ merge: { ok: true }, mergePush: { ok: true }, push: { ok: true } });

    const res = await cmd("tasks.push", { id: "ACM-1" });
    expect(res.body.results[0]).toMatchObject({ ok: true });
    expect(res.body.task.status).toBe("done");
    options = (await cmd("tasks.shipOptions", { id: "ACM-1" })).body;
    expect(options.merge).toMatchObject({ ok: false });
    expect(options.push).toMatchObject({ ok: false });
  });
});
