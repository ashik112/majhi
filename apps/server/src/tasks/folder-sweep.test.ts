import { mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Task } from "@majhi/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Store } from "../store/index.ts";
import { git, makeRepo, tempDir } from "../testing/fixtures.ts";
import { TaskFolderSweep } from "./folder-sweep.ts";

const NOW = new Date("2026-10-04T12:00:00.000Z");
const OLD = "2026-09-20T00:00:00.000Z";
/** 3 hours before NOW: done, but not for a day. */
const RECENT = "2026-10-04T09:00:00.000Z";
const KB100 = "x".repeat(100_000);

let dir: string;
let dispose: () => Promise<void>;
let store: Store;
let sweep: TaskFolderSweep;
let source: string;
const opts = { hours: 24, worktreeDays: 0 };

beforeEach(async () => {
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  ({ dir, cleanup: dispose } = await tempDir());
  store = new Store(join(dir, "majhi.db"));
  sweep = new TaskFolderSweep({ store, tasksDir: async () => join(dir, "tasks"), now: () => NOW });
  source = join(dir, "work", "api");
  await makeRepo(source, { commit: true });
  await writeFile(join(source, ".gitignore"), "node_modules/\ndist/\n.next/\n");
  await mkdir(join(source, "src"), { recursive: true });
  await writeFile(join(source, "src", "index.ts"), "export {};\n");
  await git(source, "add", ".");
  await git(source, "commit", "--quiet", "-m", "app");
});
afterEach(async () => {
  store.close();
  vi.unstubAllEnvs();
  await dispose();
});

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

interface Seed {
  id: string;
  status?: Task["status"];
  updatedAt?: string;
  org?: string;
}

/** A task with one worktree, a node_modules, a dist (git-ignored), a .pnpm-store at the task root and a nested .next. */
async function seed(s: Seed): Promise<{ folder: string; worktree: string }> {
  const folder = join(dir, "tasks", s.id);
  const worktree = join(folder, "api");
  await mkdir(folder, { recursive: true });
  await git(source, "worktree", "add", "--quiet", "-b", `task/${s.id.toLowerCase()}`, worktree, "main");
  for (const rel of ["node_modules/pkg", "dist", "packages/web/.next", "packages/web/node_modules/other"]) {
    await mkdir(join(worktree, rel), { recursive: true });
    await writeFile(join(worktree, rel, "file.js"), KB100);
  }
  await mkdir(join(folder, ".pnpm-store", "v3"), { recursive: true });
  await writeFile(join(folder, ".pnpm-store", "v3", "blob"), KB100);
  await writeFile(join(folder, "TASK.md"), "brief\n");
  store.tasks.insert({
    id: s.id,
    title: `Task ${s.id}`,
    brief: "brief",
    kind: "code",
    org: s.org ?? "acme",
    status: s.status ?? "done",
    folder,
    repos: [
      {
        project: "acme-api",
        source,
        base: "main",
        branch: `task/${s.id.toLowerCase()}`,
        worktree,
        createdBranch: true,
      },
    ],
    team: ["builder"],
    mode: "lead",
    overrides: {},
    links: [],
    attachments: [],
    createdAt: OLD,
    updatedAt: s.updatedAt ?? OLD,
  } as Task);
  return { folder, worktree };
}

describe("freeing rebuildable folders of done tasks", () => {
  it("deletes dependency and build folders, keeps tracked files, and reports the bytes it freed", async () => {
    const { folder, worktree } = await seed({ id: "ACM-1" });
    const report = await sweep.run(opts);

    expect(await exists(join(worktree, "node_modules"))).toBe(false);
    expect(await exists(join(worktree, "dist"))).toBe(false);
    expect(await exists(join(worktree, "packages/web/.next"))).toBe(false);
    expect(await exists(join(worktree, "packages/web/node_modules"))).toBe(false);
    expect(await exists(join(folder, ".pnpm-store"))).toBe(false);
    expect(await readFile(join(worktree, "src/index.ts"), "utf8")).toBe("export {};\n");
    expect(await exists(join(folder, "TASK.md"))).toBe(true);
    expect(report.tasks).toHaveLength(1);
    expect(report.tasks[0]?.removed.sort()).toEqual(
      [
        ".pnpm-store",
        "api/dist",
        "api/node_modules",
        "api/packages/web/.next",
        "api/packages/web/node_modules",
      ].sort(),
    );
    // Five folders of one 100 KB file each, plus their directories.
    expect(report.freedBytes).toBeGreaterThanOrEqual(500_000);
  });

  it("frees nothing on a second run", async () => {
    await seed({ id: "ACM-1" });
    await sweep.run(opts);
    expect(await sweep.run(opts)).toEqual({ freedBytes: 0, tasks: [] });
  });

  it("leaves a task done for less than the hours alone, and deletes nothing in a preview", async () => {
    const { worktree } = await seed({ id: "ACM-1", updatedAt: RECENT });
    expect((await sweep.run(opts)).freedBytes).toBe(0);
    await seed({ id: "ACM-2" });
    const preview = await sweep.preview(opts);
    expect(preview.freedBytes).toBeGreaterThan(0);
    expect(await exists(join(dir, "tasks/ACM-2/api/node_modules"))).toBe(true);
    expect(await exists(join(worktree, "node_modules"))).toBe(true);
  });

  it("never touches a task that is not done", async () => {
    for (const [id, status] of [
      ["ACM-1", "running"],
      ["ACM-2", "paused"],
      ["ACM-3", "review"],
      ["ACM-4", "inbox"],
      ["ACM-5", "mr"],
      ["ACM-6", "ready"],
    ] as const) {
      const { worktree } = await seed({ id, status });
      expect((await sweep.run(opts)).freedBytes).toBe(0);
      expect(await exists(join(worktree, "node_modules")), id).toBe(true);
    }
  });

  it("deletes nothing in a task with an uncommitted change to a tracked file", async () => {
    const { folder, worktree } = await seed({ id: "ACM-1" });
    await writeFile(join(worktree, "src/index.ts"), "export const wip = 1;\n");
    const report = await sweep.run(opts);
    expect(report.freedBytes).toBe(0);
    expect(report.tasks[0]?.kept[0]).toMatch(/uncommitted/);
    expect(await exists(join(worktree, "node_modules"))).toBe(true);
    expect(await exists(join(folder, ".pnpm-store"))).toBe(true);
    expect(await readFile(join(worktree, "src/index.ts"), "utf8")).toBe("export const wip = 1;\n");
  });

  it("deletes nothing when a change is staged, and nothing when git cannot be read", async () => {
    const { worktree } = await seed({ id: "ACM-1" });
    await writeFile(join(worktree, "src/new.ts"), "export {};\n");
    await git(worktree, "add", "src/new.ts");
    expect((await sweep.run(opts)).freedBytes).toBe(0);
    await git(worktree, "reset", "--quiet");
    await writeFile(join(worktree, ".git"), "gitdir: /nonexistent\n");
    expect((await sweep.run(opts)).freedBytes).toBe(0);
    expect(await exists(join(worktree, "node_modules"))).toBe(true);
  });

  it("keeps a node_modules that holds a tracked file, and a dist git does not ignore", async () => {
    const { worktree } = await seed({ id: "ACM-1" });
    await writeFile(join(worktree, "node_modules/pkg/vendored.js"), "tracked\n");
    await git(worktree, "add", "-f", "node_modules/pkg/vendored.js");
    await git(worktree, "commit", "--quiet", "-m", "vendor");
    await mkdir(join(worktree, "packages/web/build"), { recursive: true });
    await writeFile(join(worktree, "packages/web/build/out.js"), KB100);
    const report = await sweep.run(opts);
    expect(await exists(join(worktree, "node_modules/pkg/vendored.js"))).toBe(true);
    expect(await exists(join(worktree, "packages/web/build/out.js"))).toBe(true);
    expect(report.tasks[0]?.removed).not.toContain("api/node_modules");
    expect(report.tasks[0]?.removed).toContain("api/dist");
  });

  it("never follows or removes a symlink, in the task folder or inside a rebuildable folder", async () => {
    const outside = join(dir, "outside");
    await mkdir(join(outside, "node_modules"), { recursive: true });
    await writeFile(join(outside, "precious.txt"), "mine\n");
    await writeFile(join(outside, "node_modules", "m.js"), "mine\n");
    const { folder, worktree } = await seed({ id: "ACM-1" });
    // A link that is named like a rebuildable folder, a link to a folder holding one, and a link inside node_modules.
    await symlink(outside, join(folder, "node_modules"));
    await symlink(outside, join(folder, "linked"));
    await symlink(outside, join(worktree, "node_modules/pkg/escape"));
    await sweep.run(opts);
    expect(await readFile(join(outside, "precious.txt"), "utf8")).toBe("mine\n");
    expect(await readFile(join(outside, "node_modules", "m.js"), "utf8")).toBe("mine\n");
    // The link named node_modules is left, and so is the one to a folder; the real node_modules went.
    expect((await stat(join(folder, "node_modules"))).isDirectory()).toBe(true);
    expect(await exists(join(folder, "linked"))).toBe(true);
    expect(await exists(join(worktree, "node_modules"))).toBe(false);
  });

  it("refuses a task folder that sits outside the tasks folder", async () => {
    const { worktree } = await seed({ id: "ACM-1" });
    const elsewhere = join(dir, "elsewhere");
    await mkdir(join(elsewhere, "node_modules"), { recursive: true });
    await writeFile(join(elsewhere, "node_modules", "x.js"), KB100);
    store.raw.prepare("UPDATE tasks SET folder = ? WHERE id = ?").run(elsewhere, "ACM-1");
    const report = await sweep.run(opts);
    expect(report.freedBytes).toBe(0);
    expect(await exists(join(elsewhere, "node_modules/x.js"))).toBe(true);
    expect(await exists(join(worktree, "node_modules"))).toBe(true);
  });

  it("skips a task that is reopened while the sweep runs", async () => {
    const { worktree } = await seed({ id: "ACM-1" });
    const real = store.tasks.get.bind(store.tasks);
    let calls = 0;
    const spy = vi.spyOn(store.tasks, "get").mockImplementation((id: string) => {
      calls++;
      // The first read loads the task; the owner reopens it before the first folder goes.
      if (calls === 2) store.raw.prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(id);
      return real(id);
    });
    const report = await sweep.run(opts);
    spy.mockRestore();
    expect(report.freedBytes).toBe(0);
    expect(report.tasks[0]?.kept).toContain("it was reopened");
    expect(await exists(join(worktree, "node_modules"))).toBe(true);
  });
});

describe("removing whole worktrees of old done tasks", () => {
  const withTrees = { hours: 24, worktreeDays: 7 };

  it("removes a clean worktree whose branch is merged, keeps the branch, and clears the task row", async () => {
    const { folder, worktree } = await seed({ id: "ACM-1" });
    const report = await sweep.run(withTrees);
    expect(report.tasks[0]?.worktrees).toEqual(["acme-api"]);
    expect(await exists(worktree)).toBe(false);
    expect(await exists(join(folder, "TASK.md"))).toBe(true);
    expect(await git(source, "branch", "--list", "task/acm-1")).toContain("task/acm-1");
    expect(store.tasks.get("ACM-1")?.repos[0]?.worktree).toBeUndefined();
    expect(report.freedBytes).toBeGreaterThan(0);
  });

  it("keeps a worktree whose commits are neither merged nor pushed", async () => {
    const { worktree } = await seed({ id: "ACM-1" });
    await writeFile(join(worktree, "src/work.ts"), "export const w = 1;\n");
    await git(worktree, "add", ".");
    await git(worktree, "commit", "--quiet", "-m", "work");
    const report = await sweep.run(withTrees);
    expect(await exists(worktree)).toBe(true);
    expect(report.tasks[0]?.kept.join(" ")).toMatch(/neither merged nor pushed/);
    // The folders inside it are still freed.
    expect(await exists(join(worktree, "node_modules"))).toBe(false);
  });

  it("keeps a worktree with an untracked file", async () => {
    const { worktree } = await seed({ id: "ACM-1" });
    await writeFile(join(worktree, "draft.md"), "draft\n");
    await sweep.run(withTrees);
    expect(await exists(join(worktree, "draft.md"))).toBe(true);
  });
});
