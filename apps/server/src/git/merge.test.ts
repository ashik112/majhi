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

const tip = async (cwd: string, ref: string) => (await git(cwd, ["rev-parse", ref])).trim();

describe("mergeBranch with squash", () => {
  it("on a conflict changes neither branch and leaves the checkout clean", async () => {
    await commit(repo, "b.txt", "main side");
    const mainBefore = await tip(repo, "main");
    const branchBefore = await tip(repo, "task/x");
    const out = await mergeBranch({ ...request("main"), method: "squash" });
    expect(out).toMatchObject({ ok: false, conflicts: ["b.txt"] });
    expect(await tip(repo, "main")).toBe(mainBefore);
    expect(await tip(repo, "task/x")).toBe(branchBefore);
    expect((await git(repo, ["status", "--porcelain"])).trim()).toBe("");
    expect(await readFile(join(repo, "b.txt"), "utf8")).toBe("main side");
  });
});
