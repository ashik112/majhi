import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { git, tempDir } from "../testing/fixtures.ts";
import { cleanOutgoing } from "./outgoing.ts";

/**
 * Cleaning a task branch before it leaves majhi touches only the task's own commits. Other people's
 * commits that reached the remote after the local base was last updated are never rewritten.
 */

let cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups) await c();
  cleanups = [];
});

const me = { name: "Acme", email: "dev@acme.test" };

async function commit(dir: string, file: string, message: string): Promise<void> {
  await writeFile(join(dir, file), `${message}\n`);
  await git(dir, "add", file);
  await git(dir, "commit", "-q", "-m", message);
}

/** A checkout whose local main is behind origin/main by two teammate commits and a merge. */
async function staleBase(): Promise<{ repo: string; upstream: string }> {
  const t = await tempDir();
  cleanups.push(t.cleanup);
  const origin = join(t.dir, "origin.git");
  const repo = join(t.dir, "repo");
  const mate = join(t.dir, "mate");
  await git(t.dir, "init", "-q", "--bare", "-b", "main", origin);
  await git(t.dir, "clone", "-q", origin, repo);
  await commit(repo, "a.txt", "first");
  await git(repo, "push", "-q", "origin", "main");
  await git(t.dir, "clone", "-q", origin, mate);
  await commit(mate, "b.txt", "teammate one");
  await git(mate, "checkout", "-q", "-b", "side", "HEAD~1");
  await commit(mate, "c.txt", "teammate two");
  await git(mate, "checkout", "-q", "main");
  await git(mate, "merge", "-q", "--no-ff", "-m", "Merge side", "side");
  await git(mate, "push", "-q", "origin", "main");
  await git(repo, "fetch", "-q", "origin");
  const upstream = (await git(repo, "rev-parse", "origin/main")).trim();
  return { repo, upstream };
}

describe("cleanOutgoing", () => {
  it("folds only the task's checkpoints onto origin/main when the local main is behind", async () => {
    const { repo, upstream } = await staleBase();
    await git(repo, "checkout", "-q", "-b", "fix/greeting", "origin/main");
    await commit(repo, "d.txt", "wip(ACM-1): checkpoint 1");
    await commit(repo, "e.txt", "wip(ACM-1): checkpoint 2");

    const result = await cleanOutgoing({
      source: repo,
      branch: "fix/greeting",
      base: "main",
      startCommit: upstream,
      taskId: "ACM-1",
      subject: "Fix the greeting",
      identity: me,
    });

    expect(result.changed).toBe(true);
    expect((await git(repo, "rev-parse", "fix/greeting~1")).trim()).toBe(upstream);
    expect((await git(repo, "log", "-1", "--format=%s", "fix/greeting")).trim()).toBe("Fix the greeting");
    expect((await git(repo, "rev-list", "--count", "origin/main..fix/greeting")).trim()).toBe("1");
  });

  it("finds the fork on the remote base even without a start commit", async () => {
    const { repo, upstream } = await staleBase();
    await git(repo, "checkout", "-q", "-b", "fix/greeting", "origin/main");
    await commit(repo, "d.txt", "wip(ACM-1): checkpoint 1");

    await cleanOutgoing({
      source: repo,
      branch: "fix/greeting",
      base: "main",
      taskId: "ACM-1",
      subject: "Fix the greeting",
      identity: me,
    });

    expect((await git(repo, "rev-parse", "fix/greeting~1")).trim()).toBe(upstream);
  });

  it("keeps the teammates' commits when the task merged origin/main in", async () => {
    const { repo, upstream } = await staleBase();
    await git(repo, "checkout", "-q", "-b", "fix/greeting", "main");
    await commit(repo, "d.txt", "wip(ACM-1): checkpoint 1");
    await git(repo, "merge", "-q", "--no-ff", "-m", "Merge origin/main", "origin/main");

    await cleanOutgoing({
      source: repo,
      branch: "fix/greeting",
      base: "main",
      startCommit: (await git(repo, "rev-parse", "main")).trim(),
      taskId: "ACM-1",
      subject: "Fix the greeting",
      identity: me,
    });

    expect((await git(repo, "rev-parse", "fix/greeting~1")).trim()).toBe(upstream);
    expect((await git(repo, "rev-list", "--count", "origin/main..fix/greeting")).trim()).toBe("1");
    expect((await git(repo, "show", "fix/greeting:d.txt")).trim()).toBe("wip(ACM-1): checkpoint 1");
  });
});
