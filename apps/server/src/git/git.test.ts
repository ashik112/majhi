import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commitBy, commitCheckpoint } from "../runs/checkpoint.ts";
import { git, gitEnv, uncommitted } from "./git.ts";
import { mergeBranch, mergeConflicts } from "./merge.ts";

describe("majhi's own git", () => {
  let dir: string;
  const saved = { sock: process.env.SSH_AUTH_SOCK, ssh: process.env.GIT_SSH_COMMAND };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "majhi-git-env-"));
  });
  afterEach(async () => {
    for (const [name, value] of [
      ["SSH_AUTH_SOCK", saved.sock],
      ["GIT_SSH_COMMAND", saved.ssh],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(dir, { recursive: true, force: true });
  });

  it("keeps the SSH agent socket and turns prompts off", () => {
    const env = gitEnv({ PATH: "/usr/bin", SSH_AUTH_SOCK: "/run/ssh-agent.sock" });
    expect(env).toMatchObject({
      SSH_AUTH_SOCK: "/run/ssh-agent.sock",
      GIT_TERMINAL_PROMPT: "0",
      GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
    });
  });

  it("hands the socket to ssh when it fetches", async () => {
    const seen = join(dir, "seen");
    const probe = join(dir, "ssh-probe.sh");
    await writeFile(probe, `#!/bin/sh\nprintf '%s' "$SSH_AUTH_SOCK" > '${seen}'\nexit 1\n`);
    await chmod(probe, 0o755);
    process.env.SSH_AUTH_SOCK = "/run/ssh-agent.sock";
    process.env.GIT_SSH_COMMAND = probe;
    await git(dir, ["init", "-q"]);
    await expect(git(dir, ["fetch", "ssh://git@example.test/x.git"])).rejects.toThrow();
    expect(await readFile(seen, "utf8")).toBe("/run/ssh-agent.sock");
  });

  it("runs none of the commands a repo's config and attributes name", async () => {
    const repo = join(dir, "repo");
    const task = join(dir, "task");
    const marker = join(dir, "ran");
    const ran = () => readFile(marker, "utf8").catch(() => "");
    const commit = async (cwd: string, file: string, text: string) => {
      await writeFile(join(cwd, file), text);
      await git(cwd, ["add", file]);
      await git(cwd, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", file]);
    };
    await git(dir, ["init", "-q", "-b", "main", repo]);
    await commit(repo, "a.txt", "one\n");
    await commit(repo, "shared.txt", "1\n2\n3\n");
    await git(repo, ["branch", "task/x"]);
    await git(repo, ["branch", "other"]);
    await git(repo, ["worktree", "add", "-q", task, "task/x"]);

    // What an agent could plant: hooks, an fsmonitor and drivers that write the marker. The driver's
    // name holds a `=`, which `git -c` would cut short.
    const hooks = join(dir, "hooks");
    await mkdir(hooks);
    const names = [
      "pre-commit",
      "commit-msg",
      "post-commit",
      "post-checkout",
      "pre-merge-commit",
      "post-merge",
    ];
    for (const name of [...names, "reference-transaction", "fsmonitor"]) {
      await writeFile(join(hooks, name), `#!/bin/sh\necho hook ${name} >> '${marker}'\n`, { mode: 0o755 });
    }
    const say = (what: string, then: string) => `echo ${what} >> '${marker}'; ${then}`;
    for (const [key, value] of [
      ["core.hooksPath", hooks],
      ["core.fsmonitor", join(hooks, "fsmonitor")],
      ["filter.x=y.clean", say("clean", "cat")],
      ["filter.x=y.smudge", say("smudge", "cat")],
      ["filter.x=y.required", "true"],
      ["diff.x=y.textconv", say("textconv", "cat")],
      ["diff.x=y.command", say("external-diff", "true")],
      ["merge.x=y.driver", say("merge-driver", "true")],
    ] as const) {
      await git(repo, ["config", key, value]);
    }
    const attributes = "* filter=x=y diff=x=y merge=x=y\n";
    await writeFile(join(repo, ".git", "info", "attributes"), attributes);
    await writeFile(join(task, ".gitattributes"), attributes);
    await writeFile(join(task, "a.txt"), "two\n");
    await writeFile(join(task, "shared.txt"), "task\n2\n3\n");

    expect(await uncommitted(task)).toEqual([" M a.txt", " M shared.txt", "?? .gitattributes"]);
    expect(await git(task, ["diff"])).toContain("+two");
    const by = commitBy({ name: "Acme", email: "dev@acme.test" }, "ACME-1");
    const repos = [{ project: "app", worktree: task, branch: "task/x", base: "main" }];
    expect(await commitCheckpoint(repos, "ACME-1", 1, by)).toEqual({ committed: ["app"], skipped: [] });
    await git(repo, ["checkout", "-q", "other"]);
    await commit(repo, "shared.txt", "1\n2\nother\n");
    await git(repo, ["checkout", "-q", "main"]);
    await commit(repo, "c.txt", "main moved\n");
    // Apart, the two changes merge as text; with a merge driver majhi does not run, it is a conflict.
    expect(await mergeConflicts(repo, "task/x", "other")).toEqual(["shared.txt"]);
    const merged = await mergeBranch({
      source: repo,
      branch: "task/x",
      into: "main",
      identity: { name: "Owner", email: "owner@acme.test" },
      message: "Merge ACME-1",
      scratch: join(dir, "scratch"),
    });
    expect(merged).toMatchObject({ ok: true, how: "merge commit" });
    expect(await readFile(join(repo, "a.txt"), "utf8")).toBe("two\n");
    expect(await ran()).toBe("");

    // The same repo with plain git does run them, so the setup above is live.
    const { GIT_CONFIG_COUNT: _count, ...env } = gitEnv(process.env);
    const plain = (cwd: string, args: string[]) =>
      promisify(execFile)("git", args, { cwd, env }).catch(() => undefined);
    await writeFile(join(task, "a.txt"), "three\n");
    await plain(task, ["diff"]);
    await plain(repo, ["merge-tree", "--write-tree", "other", "task/x"]);
    await plain(repo, ["update-ref", "refs/heads/probe", "HEAD"]);
    expect(await ran()).toMatch(/clean[\s\S]*merge-driver[\s\S]*hook reference-transaction/);
  });
});
