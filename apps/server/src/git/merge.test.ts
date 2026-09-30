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
