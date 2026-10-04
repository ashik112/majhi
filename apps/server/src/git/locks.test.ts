import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git, gitEnv } from "./git.ts";

describe("majhi's git and index.lock", () => {
  let dir: string;
  let repo: string;
  let log: string;
  const savedPath = process.env.PATH;

  const sh = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "1" } });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "majhi-git-locks-"));
    repo = join(dir, "repo");
    log = join(dir, "log");
    await mkdir(repo);
    sh(repo, "init", "-q", "-b", "main");
    sh(repo, "config", "user.name", "t");
    sh(repo, "config", "user.email", "t@acme.test");
    await writeFile(join(repo, "a.txt"), "one\n");
    sh(repo, "add", "a.txt");
    sh(repo, "commit", "-qm", "init");
  });
  afterEach(async () => {
    process.env.PATH = savedPath;
    await rm(dir, { recursive: true, force: true });
  });

  /** A `git` first on PATH that logs each run (its optional-locks setting, start and end), then runs the real one. */
  async function shim(pauseMs: number): Promise<void> {
    const real = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const bin = join(dir, "bin");
    await mkdir(bin);
    const script = join(bin, "git");
    await writeFile(
      script,
      `#!/bin/sh
echo "start $1 locks=$GIT_OPTIONAL_LOCKS" >> '${log}'
'${real}' "$@"
code=$?
sleep ${pauseMs / 1000}
echo "end $1" >> '${log}'
exit $code
`,
    );
    await chmod(script, 0o755);
    process.env.PATH = `${bin}:${savedPath ?? ""}`;
  }

  it("turns optional locks off for every command", async () => {
    expect(gitEnv({ PATH: "/usr/bin" }).GIT_OPTIONAL_LOCKS).toBe("0");
    expect(gitEnv({ PATH: "/usr/bin", GIT_OPTIONAL_LOCKS: "1" }).GIT_OPTIONAL_LOCKS).toBe("0");
    await shim(0);
    await git(repo, ["status", "--porcelain"]);
    await git(repo, ["diff", "--stat"]);
    const lines = (await readFile(log, "utf8")).split("\n").filter((l) => l.startsWith("start"));
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(l).toMatch(/locks=0$/);
  });

  it("a read during a held index lock neither fails nor touches the lock", async () => {
    const lock = join(repo, ".git", "index.lock");
    await writeFile(join(repo, "a.txt"), "changed\n");
    await writeFile(lock, "held by someone else");
    expect(await git(repo, ["status", "--porcelain"])).toContain("a.txt");
    expect(await readFile(lock, "utf8")).toBe("held by someone else");
  });

  it("two writes to one worktree never overlap", async () => {
    await shim(150);
    await writeFile(join(repo, "b.txt"), "b\n");
    await writeFile(join(repo, "c.txt"), "c\n");
    await Promise.all([git(repo, ["add", "b.txt"]), git(repo, ["add", "c.txt"]), git(repo, ["add", "a.txt"])]);
    const events = (await readFile(log, "utf8"))
      .split("\n")
      .filter((l) => /^(start|end) add/.test(l))
      .map((l) => l.split(" ")[0]);
    expect(events).toEqual(["start", "end", "start", "end", "start", "end"]);
  });

  it("waits out a lock someone else holds and never removes it", async () => {
    const lock = join(repo, ".git", "index.lock");
    await writeFile(join(repo, "b.txt"), "b\n");
    await writeFile(lock, "held by an agent");
    const adding = git(repo, ["add", "b.txt"]);
    await new Promise((done) => setTimeout(done, 300));
    expect(await readFile(lock, "utf8")).toBe("held by an agent");
    await rm(lock);
    await adding;
    expect(sh(repo, "status", "--porcelain")).toContain("A  b.txt");
  });
});
