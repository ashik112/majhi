import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskRepo } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { git } from "../git/git.ts";
import { repoChanged } from "./ship-plan.ts";

let dir: string | undefined;
afterEach(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("repoChanged", () => {
  it("counts a branch whose commits the base already holds as nothing to ship", async () => {
    dir = await mkdtemp(join(tmpdir(), "majhi-shipplan-"));
    const run = (...args: string[]) =>
      git(dir as string, ["-c", "user.name=T", "-c", "user.email=t@example.com", ...args]);
    await run("init", "-b", "main");
    await writeFile(join(dir, "a.txt"), "a\n");
    await run("add", ".");
    await run("commit", "-m", "base");
    const start = (await run("rev-parse", "HEAD")).trim();
    await run("checkout", "-b", "task/acme-1");
    await writeFile(join(dir, "b.txt"), "b\n");
    await run("add", ".");
    await run("commit", "-m", "work");
    const repo = { source: dir, base: "main", branch: "task/acme-1", startCommit: start } as TaskRepo;
    expect(await repoChanged(repo)).toBe(true);
    await run("checkout", "main");
    await run("merge", "--no-ff", "task/acme-1", "-m", "merge");
    expect(await repoChanged(repo)).toBe(false);
  });
});
