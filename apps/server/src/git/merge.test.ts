import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git } from "./git.ts";
import { mergeBranch } from "./merge.ts";

const who = { name: "Owner", email: "owner@example.com" };
let root: string;
let repo: string;

async function commit(cwd: string, file: string, text: string): Promise<void> {
  await writeFile(join(cwd, file), text);
  await git(cwd, ["add", file]);
  await git(cwd, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", `${file}: ${text}`]);
}

const request = (into: string) => ({
  source: repo,
  branch: "task/x",
  into,
  identity: who,
  message: "Merge X",
  scratch: join(root, "scratch"),
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "majhi-merge-"));
  repo = join(root, "repo");
  await git(root, ["init", "-q", "-b", "main", repo]);
  await commit(repo, "a.txt", "one");
  await git(repo, ["branch", "dev"]);
  await git(repo, ["branch", "task/x"]);
  await git(repo, ["worktree", "add", "-q", join(root, "task"), "task/x"]);
  await commit(join(root, "task"), "b.txt", "task work");
});
afterEach(() => rm(root, { recursive: true, force: true }));

describe("mergeBranch", () => {
  it("fast-forwards the checked-out branch and updates the owner's files", async () => {
    expect(await mergeBranch(request("main"))).toMatchObject({ ok: true, how: "fast-forward" });
    expect(await readFile(join(repo, "b.txt"), "utf8")).toBe("task work");
    expect((await git(repo, ["status", "--porcelain"])).trim()).toBe("");
  });

  it("merges into a branch checked out nowhere, without touching the checkout", async () => {
    await commit(repo, "c.txt", "main moved"); // main diverges; dev is not checked out
    expect(await mergeBranch(request("dev"))).toMatchObject({ ok: true, how: "fast-forward", where: "dev" });
    await git(repo, ["checkout", "-q", "dev"]);
    await commit(repo, "d.txt", "dev moved");
    await git(repo, ["checkout", "-q", "main"]);
    await commit(join(root, "task"), "e.txt", "more");
    expect(await mergeBranch(request("dev"))).toMatchObject({ ok: true, how: "merge commit" });
    expect(await git(repo, ["show", "dev:e.txt"])).toBe("more");
    expect((await git(repo, ["worktree", "list"])).includes("scratch")).toBe(false);
  });

  it("refuses a checkout with uncommitted changes and aborts a conflict, leaving it clean", async () => {
    await writeFile(join(repo, "a.txt"), "owner edit");
    expect(await mergeBranch(request("main"))).toMatchObject({ ok: false });
    expect(await readFile(join(repo, "a.txt"), "utf8")).toBe("owner edit");
    await git(repo, ["checkout", "-q", "--", "a.txt"]);

    await commit(repo, "b.txt", "main side");
    const out = await mergeBranch(request("main"));
    expect(out).toMatchObject({ ok: false });
    expect(out.ok ? "" : out.reason).toContain("b.txt");
    expect((await git(repo, ["status", "--porcelain"])).trim()).toBe("");
    expect(await readFile(join(repo, "b.txt"), "utf8")).toBe("main side");
  });
});

const tip = async (cwd: string, ref: string) => (await git(cwd, ["rev-parse", ref])).trim();
const task = () => join(root, "task");
const exists = (cwd: string, path: string) => git(cwd, ["rev-parse", "--git-path", path]).then((p) => p.trim());

describe("mergeBranch with squash", () => {
  it("adds one commit on the target with the message and leaves the task branch as it was", async () => {
    await commit(repo, "c.txt", "main moved");
    await commit(task(), "e.txt", "more");
    const mainBefore = await tip(repo, "main");
    const branchBefore = await tip(repo, "task/x");
    expect(await mergeBranch({ ...request("main"), method: "squash" })).toMatchObject({
      ok: true,
      how: "squash commit",
      head: branchBefore,
    });
    expect(await tip(repo, "main^")).toBe(mainBefore);
    expect((await git(repo, ["show", "-s", "--format=%P", "main"])).trim().split(" ")).toHaveLength(1); // not a merge commit
    expect((await git(repo, ["log", "-1", "--format=%s", "main"])).trim()).toBe("Merge X");
    expect(await readFile(join(repo, "e.txt"), "utf8")).toBe("more");
    expect(await tip(repo, "task/x")).toBe(branchBefore);
    expect((await git(repo, ["status", "--porcelain"])).trim()).toBe("");
  });

  it("squashes into a branch checked out nowhere through a throwaway worktree", async () => {
    await commit(repo, "c.txt", "main moved");
    expect(await mergeBranch({ ...request("dev"), method: "squash" })).toMatchObject({
      ok: true,
      how: "squash commit",
      where: "dev",
    });
    expect(await git(repo, ["show", "dev:b.txt"])).toBe("task work");
    expect((await git(repo, ["worktree", "list"])).includes("scratch")).toBe(false);
  });

  it("on a conflict changes neither branch and leaves the checkout clean", async () => {
    await commit(repo, "b.txt", "main side");
    const mainBefore = await tip(repo, "main");
    const branchBefore = await tip(repo, "task/x");
    const out = await mergeBranch({ ...request("main"), method: "squash" });
    expect(out).toMatchObject({ ok: false, conflicts: ["b.txt"] });
    expect(out.ok ? "" : out.reason).toBe("Conflicts in b.txt. Nothing was merged.");
    expect(await tip(repo, "main")).toBe(mainBefore);
    expect(await tip(repo, "task/x")).toBe(branchBefore);
    expect((await git(repo, ["status", "--porcelain"])).trim()).toBe("");
    expect(await readFile(join(repo, "b.txt"), "utf8")).toBe("main side");
  });
});

describe("mergeBranch with rebase", () => {
  it("rebases the task branch onto the target, then only fast-forwards the target", async () => {
    await commit(repo, "c.txt", "main moved");
    const mainBefore = await tip(repo, "main");
    const out = await mergeBranch({ ...request("main"), method: "rebase" });
    expect(out).toMatchObject({ ok: true, how: "rebased" });
    const mainAfter = await tip(repo, "main");
    expect(out.ok && out.head).toBe(mainAfter);
    expect(await tip(repo, "task/x")).toBe(mainAfter);
    // The target was not rewritten: its old tip is the parent of the rebased task commit.
    expect(await tip(repo, "main^")).toBe(mainBefore);
    expect(await readFile(join(repo, "b.txt"), "utf8")).toBe("task work");
    expect(await readFile(join(task(), "c.txt"), "utf8")).toBe("main moved");
    expect((await git(repo, ["status", "--porcelain"])).trim()).toBe("");
    expect((await git(task(), ["status", "--porcelain"])).trim()).toBe("");
  });

  it("works when neither branch is checked out, and removes its throwaway worktree", async () => {
    await git(repo, ["worktree", "remove", task()]);
    await git(repo, ["checkout", "-q", "dev"]);
    await commit(repo, "d.txt", "dev moved");
    await git(repo, ["checkout", "-q", "main"]);
    await commit(repo, "c.txt", "main moved");
    const devBefore = await tip(repo, "dev");
    expect(await mergeBranch({ ...request("dev"), method: "rebase" })).toMatchObject({
      ok: true,
      how: "rebased",
      where: "dev",
    });
    expect(await tip(repo, "dev^")).toBe(devBefore);
    expect(await tip(repo, "task/x")).toBe(await tip(repo, "dev"));
    expect((await git(repo, ["worktree", "list"])).includes("scratch")).toBe(false);
  });

  it("on a conflict aborts and leaves both branches exactly as they were", async () => {
    await commit(repo, "b.txt", "main side");
    await commit(task(), "e.txt", "more");
    const mainBefore = await tip(repo, "main");
    const branchBefore = await tip(repo, "task/x");
    const out = await mergeBranch({ ...request("main"), method: "rebase" });
    expect(out).toMatchObject({ ok: false, conflicts: ["b.txt"] });
    expect(out.ok ? "" : out.reason).toBe(
      "Rebasing task/x onto main hit conflicts in b.txt. Nothing was merged.",
    );
    expect(await tip(repo, "main")).toBe(mainBefore);
    expect(await tip(repo, "task/x")).toBe(branchBefore);
    expect((await git(task(), ["status", "--porcelain"])).trim()).toBe("");
    expect(await readFile(join(task(), "b.txt"), "utf8")).toBe("task work");
    const rebasing = await exists(task(), "rebase-merge");
    await expect(readFile(join(rebasing, "head-name"), "utf8")).rejects.toThrow();
  });

  it("refuses when the target's checkout has uncommitted changes, before touching the task branch", async () => {
    await commit(repo, "c.txt", "main moved");
    await writeFile(join(repo, "a.txt"), "owner edit");
    const branchBefore = await tip(repo, "task/x");
    expect(await mergeBranch({ ...request("main"), method: "rebase" })).toMatchObject({ ok: false });
    expect(await tip(repo, "task/x")).toBe(branchBefore);
    expect(await readFile(join(repo, "a.txt"), "utf8")).toBe("owner edit");
  });
});
