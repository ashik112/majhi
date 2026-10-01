import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ChangeBranchInputSchema, type Task } from "@majhi/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorktreeLocks } from "../rooms/locks.ts";
import { commitBy } from "../runs/checkpoint.ts";
import { git, makeRepo, tempDir } from "../testing/fixtures.ts";
import { type ChangeBranchDeps, changeTaskBranch } from "./change-branch.ts";

let dir: string;
let cleanup: () => Promise<void>;
beforeEach(async () => {
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  ({ dir, cleanup } = await tempDir());
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await cleanup();
});

function task(id: string, org: string, repo?: { worktree: string; branch: string }): Task {
  return {
    id,
    title: id,
    brief: id,
    kind: "code",
    org,
    status: "review",
    folder: join(dir, id),
    repos:
      repo === undefined
        ? []
        : [{ project: "acme-api", source: join(dir, "api"), base: "main", createdBranch: true, ...repo }],
    team: ["acme-dev"],
    mode: "lead",
    overrides: {},
    links: [],
    attachments: [],
    createdAt: "",
    updatedAt: "",
  } as unknown as Task;
}

interface World {
  deps: ChangeBranchDeps;
  /** ACM-2's worktree, on `task/acm-2-api`. */
  target: string;
  posted: string[];
  working: string[];
}

/** A repo with ACM-2's worktree on its branch, and ACM-1 (acme) and GLX-1 (globex) as callers. */
async function world(): Promise<World> {
  const repo = join(dir, "api");
  await makeRepo(repo);
  await writeFile(join(repo, "a.txt"), "one\n");
  await writeFile(join(repo, ".gitignore"), ".env\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "--quiet", "-m", "init");
  const target = join(dir, "ACM-2", "acme-api");
  await git(repo, "worktree", "add", "--quiet", "-b", "task/acm-2-api", target);
  const tasks = new Map([
    ["ACM-1", task("ACM-1", "acme")],
    ["ACM-2", task("ACM-2", "acme", { worktree: target, branch: "task/acm-2-api" })],
    ["GLX-1", task("GLX-1", "globex")],
  ]);
  const posted: string[] = [];
  const working: string[] = [];
  const deps: ChangeBranchDeps = {
    tasks: { get: (id) => tasks.get(id) },
    working: () => working,
    locks: new WorktreeLocks(),
    room: {
      post: (_task, _id, payload) => {
        if (payload.type === "system") posted.push(payload.text);
      },
    },
    commitBy: async (t, _project, agent) => commitBy({ name: "Acme", email: "dev@acme.test" }, t.id, agent),
    isRoot: async (agent) => agent === "boss",
  };
  return { deps, target, posted, working };
}

const input = (files: { path: string; content: string }[]) =>
  ChangeBranchInputSchema.parse({ task: "ACM-2", files, message: "fix: the greeting" });
const lead = (task = "ACM-1") => ({
  actor: { kind: "agent" as const, id: "acme-lead" },
  task,
  reason: "wrong greeting",
});

describe("changing another task's branch", () => {
  it("commits inside the target's worktree, so its files, index and branch agree", async () => {
    const w = await world();
    const out = await changeTaskBranch(
      w.deps,
      input([
        { path: "a.txt", content: "two\n" },
        { path: "src/new.ts", content: "export {};\n" },
      ]),
      lead(),
    );
    expect(await git(w.target, "status", "--porcelain")).toBe("");
    expect(await readFile(join(w.target, "a.txt"), "utf8")).toBe("two\n");
    expect(await git(w.target, "rev-parse", "task/acm-2-api")).toBe(out.commit);
    expect(await git(w.target, "log", "-1", "--format=%an|%cn|%B")).toBe(
      "Acme|acme-lead via majhi|fix: the greeting\n\nMajhi-Task: ACM-2",
    );
    expect(out).toMatchObject({ task: "ACM-2", project: "acme-api", branch: "task/acm-2-api" });
    expect(w.posted).toEqual([
      `@acme-lead changed a.txt, src/new.ts on task/acm-2-api: wrong greeting (${out.commit.slice(0, 7)})`,
    ]);
    // The lock is free again for the target's agents.
    expect(w.deps.locks.holder(w.target)).toBeUndefined();
  });

  it("is refused across orgs, but a root agent may", async () => {
    const w = await world();
    const change = input([{ path: "a.txt", content: "two\n" }]);
    await expect(changeTaskBranch(w.deps, change, lead("GLX-1"))).rejects.toThrow(/another org/);
    expect(await git(w.target, "log", "-1", "--format=%s")).toBe("init");
    const boss = { actor: { kind: "agent" as const, id: "boss" }, task: "GLX-1" };
    await changeTaskBranch(w.deps, change, boss);
    expect(await git(w.target, "log", "-1", "--format=%s")).toBe("fix: the greeting");
  });

  it("is refused while an agent of the target is turning or has work queued, or holds its worktree", async () => {
    const w = await world();
    w.working.push("acme-dev");
    const change = input([{ path: "a.txt", content: "two\n" }]);
    await expect(changeTaskBranch(w.deps, change, lead())).rejects.toThrow(
      /@acme-dev in ACM-2 is working or has work queued. Retry when ACM-2 is idle/,
    );
    w.working.length = 0;
    const release = await w.deps.locks.acquire([w.target], "ACM-2\u0000acme-dev");
    await expect(changeTaskBranch(w.deps, change, lead())).rejects.toThrow(/Retry when it is idle/);
    release();
    expect(await git(w.target, "log", "-1", "--format=%s")).toBe("init");
  });

  it("never touches a worktree with uncommitted changes", async () => {
    const w = await world();
    await writeFile(join(w.target, "a.txt"), "half done\n");
    await writeFile(join(w.target, "notes.md"), "draft\n");
    await expect(
      changeTaskBranch(w.deps, input([{ path: "b.txt", content: "x\n" }]), lead()),
    ).rejects.toThrow(/uncommitted changes \(a\.txt, notes\.md\)/);
    expect(await readFile(join(w.target, "a.txt"), "utf8")).toBe("half done\n");
    expect(await git(w.target, "log", "-1", "--format=%s")).toBe("init");
    await expect(readFile(join(w.target, "b.txt"), "utf8")).rejects.toThrow();
  });

  it("refuses paths that leave the repo, enter .git, follow a symlink or are ignored", () => {
    for (const path of [
      "../outside.txt",
      "/etc/passwd",
      "a/../../x",
      ".git/hooks/pre-commit",
      "src/.GIT/x",
      "a\\b",
    ]) {
      expect(
        ChangeBranchInputSchema.safeParse({ task: "ACM-2", files: [{ path, content: "" }], message: "m" })
          .success,
      ).toBe(false);
    }
  });

  it("refuses a symlink or ignored path in the worktree, and leaves it as it was", async () => {
    const w = await world();
    const outside = join(dir, "outside");
    await mkdir(outside);
    await symlink(outside, join(w.target, "link"));
    await git(w.target, "add", "link");
    await git(w.target, "commit", "--quiet", "-m", "link");
    await expect(
      changeTaskBranch(w.deps, input([{ path: "link/x.txt", content: "x\n" }]), lead()),
    ).rejects.toThrow(/symlink/);
    await expect(readFile(join(outside, "x.txt"), "utf8")).rejects.toThrow();

    await writeFile(join(w.target, ".env"), "SECRET=1\n");
    await expect(changeTaskBranch(w.deps, input([{ path: ".env", content: "x\n" }]), lead())).rejects.toThrow(
      /ignored/,
    );
    expect(await readFile(join(w.target, ".env"), "utf8")).toBe("SECRET=1\n");
  });

  it("puts the worktree back when there is nothing to commit", async () => {
    const w = await world();
    await expect(
      changeTaskBranch(w.deps, input([{ path: "a.txt", content: "one\n" }]), lead()),
    ).rejects.toThrow(/nothing to commit/);
    expect(await git(w.target, "status", "--porcelain")).toBe("");
    expect(w.deps.locks.holder(w.target)).toBeUndefined();
    expect(w.posted).toEqual([]);
  });

  it("refuses the caller's own task", async () => {
    const w = await world();
    await expect(
      changeTaskBranch(w.deps, input([{ path: "a.txt", content: "two\n" }]), lead("ACM-2")),
    ).rejects.toThrow(/your own task/);
  });
});
