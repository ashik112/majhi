import { mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Task } from "@majhi/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventHub } from "../events/hub.ts";
import { RoomService } from "../room/service.ts";
import { Store } from "../store/index.ts";
import { git, makeRepo, tempDir } from "../testing/fixtures.ts";
import { CleanupService } from "./cleanup.ts";

const NOW = new Date("2026-09-30T12:00:00.000Z");
const OLD = "2026-07-01T00:00:00.000Z";
const RECENT = "2026-09-25T00:00:00.000Z";

let dir: string;
let dispose: () => Promise<void>;
let store: Store;
let room: RoomService;
let service: CleanupService;
let source: string;
/** The remotes the stub project reports; tests that use a remote set it. */
let remotes: Record<string, { mr?: boolean }> = {};

beforeEach(async () => {
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  ({ dir, cleanup: dispose } = await tempDir());
  store = new Store(join(dir, "majhi.db"));
  room = new RoomService(store);
  remotes = {};
  service = new CleanupService({
    store,
    room,
    events: new EventHub(),
    projects: { get: async () => ({ remotes }) },
    now: () => NOW,
  });
  source = join(dir, "work", "api");
  await makeRepo(source, { commit: true });
});
afterEach(async () => {
  store.close();
  vi.unstubAllEnvs();
  await dispose();
});

interface Seed {
  id: string;
  status?: Task["status"];
  updatedAt?: string;
  /** Commits on the task branch that main does not have. */
  ahead?: boolean;
  dirty?: boolean;
  mr?: "merged" | "open";
  createdBranch?: boolean;
  items?: number;
}

/** A task with one repo: a branch off main, a worktree on it and some room items. */
async function seed(s: Seed): Promise<{ worktree: string; branch: string }> {
  const branch = `task/${s.id.toLowerCase()}`;
  const worktree = join(dir, "tasks", s.id, "api");
  await mkdir(join(dir, "tasks", s.id), { recursive: true });
  await git(source, "worktree", "add", "--quiet", "-b", branch, worktree, "main");
  if (s.ahead === true) {
    await writeFile(join(worktree, "work.txt"), "work\n");
    await git(worktree, "add", ".");
    await git(worktree, "commit", "--quiet", "-m", "work");
  }
  if (s.dirty === true) await writeFile(join(worktree, "scratch.txt"), "wip\n");
  store.tasks.insert({
    id: s.id,
    title: `Task ${s.id}`,
    brief: "brief",
    kind: "code",
    org: "acme",
    status: s.status ?? "done",
    folder: join(dir, "tasks", s.id),
    repos: [
      {
        project: "acme-api",
        source,
        base: "main",
        branch,
        worktree,
        createdBranch: s.createdBranch ?? true,
        ...(s.mr === undefined
          ? {}
          : { mr: { url: "https://git.example.com/mr/1", number: 1, state: s.mr, ci: "none" } }),
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
  for (let i = 0; i < (s.items ?? 3); i++) {
    store.room.upsert(s.id as never, `m${i}`, { type: "system", level: "info", text: `line ${i}` });
  }
  return { worktree, branch };
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );
const branches = async () => (await git(source, "branch", "--format=%(refname:short)")).split("\n");

/** A bare remote called `name` on the source checkout. */
async function addRemote(name: string): Promise<void> {
  const bare = join(dir, `${name}.git`);
  await mkdir(bare, { recursive: true });
  await git(bare, "init", "--bare", "--quiet", "--initial-branch=main");
  await git(source, "remote", "add", name, bare);
}

describe("preview", () => {
  it("lists only done tasks older than the cutoff", async () => {
    await seed({ id: "ACM-1" });
    await seed({ id: "ACM-2", updatedAt: RECENT });
    await seed({ id: "ACM-3", status: "review" });
    await seed({ id: "ACM-4", status: "paused" });
    const { tasks } = await service.preview(30);
    expect(tasks.map((t) => t.id)).toEqual(["ACM-1"]);
    expect((await service.preview(3)).tasks.map((t) => t.id)).toEqual(["ACM-1", "ACM-2"]);
  });

  it("shows what would go and why the rest stays", async () => {
    await seed({ id: "ACM-1", dirty: true });
    await seed({ id: "ACM-2", ahead: true });
    const { tasks } = await service.preview(30);
    const [dirty, unmerged] = tasks;
    expect(dirty?.roomItems).toBe(3);
    expect(dirty?.steps).toEqual([
      expect.objectContaining({
        kind: "worktree",
        action: "skip",
        reason: expect.stringContaining("uncommitted"),
      }),
      expect.objectContaining({ kind: "branch", action: "skip", reason: "its worktree is kept" }),
    ]);
    expect(unmerged?.steps).toEqual([
      expect.objectContaining({ kind: "worktree", action: "remove" }),
      expect.objectContaining({
        kind: "branch",
        action: "skip",
        reason: expect.stringContaining("not merged"),
      }),
    ]);
  });
});

describe("run", () => {
  it("frees ignored dependency caches in dirty finished worktrees while preserving source, commits and history", async () => {
    const { worktree, branch } = await seed({ id: "ACM-1", dirty: true, ahead: true });
    await writeFile(join(worktree, ".gitignore"), "node_modules/\n");
    const cache = join(worktree, "apps", "web", "node_modules");
    await mkdir(cache, { recursive: true });
    await writeFile(join(cache, "dependency.js"), "generated\n");
    expect((await service.preview(30)).tasks[0]?.steps).toContainEqual(
      expect.objectContaining({ kind: "cache", name: cache, action: "remove" }),
    );
    const report = await service.run(["ACM-1"], 30, "owner", true);
    expect(report.tasks[0]).toMatchObject({
      roomItems: 0,
      steps: [{ kind: "cache", name: cache, action: "remove" }],
    });
    expect(await exists(cache)).toBe(false);
    expect(await readFile(join(worktree, "scratch.txt"), "utf8")).toBe("wip\n");
    expect(await exists(worktree)).toBe(true);
    expect(await branches()).toContain(branch);
    expect(store.room.count("ACM-1", "cleanup-note:")).toBe(3);
    expect(store.tasks.get("ACM-1")?.repos[0]?.worktree).toBe(worktree);
  });

  it("allows explicit cache-only cleanup of a recently finished task without changing source retention", async () => {
    const { worktree } = await seed({ id: "ACM-1", updatedAt: RECENT });
    await writeFile(join(worktree, ".gitignore"), "node_modules/\n");
    await mkdir(join(worktree, "node_modules"));
    await writeFile(join(worktree, "node_modules", "package.js"), "generated\n");
    expect((await service.preview(30)).tasks).toEqual([]);
    expect((await service.preview(30, true)).tasks[0]).toMatchObject({
      roomItems: 0,
      steps: [{ kind: "cache" }],
    });
    expect((await service.run(["ACM-1"], 30, "owner")).tasks[0]?.skipped).toContain("less than 30");
    expect((await service.run(["ACM-1"], 30, "owner", true)).tasks[0]?.steps[0]?.action).toBe("remove");
    expect(await exists(worktree)).toBe(true);
    expect(store.room.count("ACM-1", "cleanup-note:")).toBe(3);
  });

  it("never frees tracked dependencies, external symlink targets or caches in unfinished tasks", async () => {
    const { worktree } = await seed({ id: "ACM-1", dirty: true });
    await writeFile(join(worktree, ".gitignore"), "node_modules/\n");
    const external = join(dir, "external");
    await mkdir(external);
    await writeFile(join(external, "keep.txt"), "keep\n");
    await symlink(external, join(worktree, "node_modules"));
    expect((await service.run(["ACM-1"], 30, "owner", true)).tasks[0]?.steps).toEqual([]);
    expect(await readFile(join(external, "keep.txt"), "utf8")).toBe("keep\n");
    const active = await seed({ id: "ACM-2", status: "running" });
    await writeFile(join(active.worktree, ".gitignore"), "node_modules/\n");
    await mkdir(join(active.worktree, "node_modules"));
    await writeFile(join(active.worktree, "node_modules", "keep.js"), "keep\n");
    expect((await service.run(["ACM-2"], 30, "owner", true)).tasks[0]?.skipped).toContain("not done");
    expect(await exists(join(active.worktree, "node_modules", "keep.js"))).toBe(true);
    const tracked = await seed({ id: "ACM-3" });
    await writeFile(join(tracked.worktree, ".gitignore"), "node_modules/\n");
    await mkdir(join(tracked.worktree, "node_modules"));
    await writeFile(join(tracked.worktree, "node_modules", "keep.js"), "tracked\n");
    await git(tracked.worktree, "add", "-f", "node_modules/keep.js");
    expect((await service.run(["ACM-3"], 30, "owner", true)).tasks[0]?.steps).toEqual([]);
    expect(await exists(join(tracked.worktree, "node_modules", "keep.js"))).toBe(true);
  });

  it("removes a clean worktree and a merged branch, and deletes the room items but keeps a note", async () => {
    const { worktree, branch } = await seed({ id: "ACM-1" });
    const report = await service.run(["ACM-1"], 30, "owner");
    expect(report.tasks[0]).toMatchObject({ id: "ACM-1", roomItems: 3 });
    expect(report.tasks[0]?.steps.map((s) => s.action)).toEqual(["remove", "remove"]);
    expect(await exists(worktree)).toBe(false);
    expect(await branches()).not.toContain(branch);
    expect(store.tasks.get("ACM-1")?.repos[0]?.worktree).toBeUndefined();
    // The task stays; only the note is left in the room.
    expect(store.tasks.get("ACM-1")?.status).toBe("done");
    const { items } = store.room.page("ACM-1", 50);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "system",
      text: expect.stringMatching(
        /^Cleaned up on 2026-09-30: removed worktree .*, deleted branch task\/acm-1, deleted 3 room items/,
      ),
    });
    expect(store.permissions.audit("ACM-1")).toEqual([
      expect.objectContaining({ kind: "cleanup", agent: "owner", decision: "allow" }),
    ]);
    // Nothing is left to offer, and the note is not counted as a log.
    expect((await service.preview(30)).tasks).toEqual([]);
  });

  it("keeps a worktree with uncommitted changes, its branch and its files", async () => {
    const { worktree, branch } = await seed({ id: "ACM-1", dirty: true });
    const report = await service.run(["ACM-1"], 30, "owner");
    expect(report.tasks[0]?.steps.map((s) => s.action)).toEqual(["skip", "skip"]);
    expect(await exists(join(worktree, "scratch.txt"))).toBe(true);
    expect(await branches()).toContain(branch);
    expect(store.tasks.get("ACM-1")?.repos[0]?.worktree).toBe(worktree);
  });

  it("removes the worktree of an unmerged branch but keeps the branch", async () => {
    const { worktree, branch } = await seed({ id: "ACM-1", ahead: true });
    const report = await service.run(["ACM-1"], 30, "owner");
    expect(report.tasks[0]?.steps).toEqual([
      expect.objectContaining({ kind: "worktree", action: "remove" }),
      expect.objectContaining({ kind: "branch", action: "skip" }),
    ]);
    expect(await exists(worktree)).toBe(false);
    expect(await branches()).toContain(branch);
  });

  it("keeps a branch whose merge request is recorded merged when nothing holds its commits", async () => {
    // Recorded by hand (markMerged force), with no remote to check: the commits exist only here.
    const { branch } = await seed({ id: "ACM-1", ahead: true, mr: "merged" });
    const report = await service.run(["ACM-1"], 30, "owner");
    expect(report.tasks[0]?.steps[1]).toMatchObject({
      kind: "branch",
      action: "skip",
      reason: "it is not in main here, and there is no remote origin to check",
    });
    expect(await branches()).toContain(branch);
  });

  it("keeps the branch of a merged MR when the remote has neither it nor its commits", async () => {
    // A squash merge on the host that deleted the branch: git cannot prove the commits are kept.
    await addRemote("origin");
    const { branch } = await seed({ id: "ACM-1", ahead: true, mr: "merged" });
    await git(source, "push", "--quiet", "origin", "main");
    const report = await service.run(["ACM-1"], 30, "owner");
    expect(report.tasks[0]?.steps[1]).toMatchObject({
      action: "skip",
      reason: "its commits are not in main, here or on origin, and origin has no branch that holds them",
    });
    expect(await branches()).toContain(branch);
  });

  it("checks the remote itself, not a tracking ref that claims the branch is pushed", async () => {
    await addRemote("origin");
    const { worktree, branch } = await seed({ id: "ACM-1", ahead: true, mr: "merged" });
    await git(source, "push", "--quiet", "origin", branch);
    await writeFile(join(worktree, "late.txt"), "late\n");
    await git(worktree, "add", ".");
    await git(worktree, "commit", "--quiet", "-m", "late");
    // A stale or moved tracking ref says the remote has the late commit too; it does not.
    await git(source, "update-ref", `refs/remotes/origin/${branch}`, branch);
    expect((await service.preview(30)).tasks[0]?.steps[1]).toMatchObject({ action: "remove" });
    const tip = await git(source, "rev-parse", branch);
    const report = await service.run(["ACM-1"], 30, "owner");
    expect(report.tasks[0]?.steps[1]).toMatchObject({ action: "skip" });
    expect(await git(source, "rev-parse", branch)).toBe(tip);
    // The check leaves no ref of its own behind, and does not move the tracking ref back.
    expect(await git(source, "for-each-ref", "refs/majhi")).toBe("");
  });

  it("keeps the branch when the remote cannot be reached", async () => {
    await git(source, "remote", "add", "origin", join(dir, "missing.git"));
    const { branch } = await seed({ id: "ACM-1", ahead: true, mr: "merged" });
    const report = await service.run(["ACM-1"], 30, "owner");
    expect(report.tasks[0]?.steps[1]?.reason).toMatch(
      /^it is not in main here and could not fetch origin\/main/,
    );
    expect(await branches()).toContain(branch);
  });

  it("keeps a branch whose merge request is still open", async () => {
    const { branch } = await seed({ id: "ACM-1", ahead: true, mr: "open" });
    await service.run(["ACM-1"], 30, "owner");
    expect(await branches()).toContain(branch);
  });

  it("keeps a branch the task did not create", async () => {
    const { branch } = await seed({ id: "ACM-1", createdBranch: false });
    const report = await service.run(["ACM-1"], 30, "owner");
    expect(await branches()).toContain(branch);
    expect(report.tasks[0]?.steps[1]).toMatchObject({ action: "skip", reason: "the task did not create it" });
  });

  it("never touches a task that is not done, or not old enough, even when asked for it", async () => {
    const review = await seed({ id: "ACM-1", status: "review" });
    const recent = await seed({ id: "ACM-2", updatedAt: RECENT });
    const report = await service.run(["ACM-1", "ACM-2", "ACM-9"], 30, "owner");
    expect(report.tasks.map((t) => t.skipped)).toEqual([
      "It is review, not done.",
      "It was closed less than 30 days ago.",
      "There is no such task.",
    ]);
    for (const { worktree, branch } of [review, recent]) {
      expect(await exists(worktree)).toBe(true);
      expect(await branches()).toContain(branch);
    }
    expect(store.room.count("ACM-1")).toBe(3);
    expect(store.room.count("ACM-2")).toBe(3);
  });

  it("checks again: a task reopened after the preview is left alone", async () => {
    await seed({ id: "ACM-1" });
    expect((await service.preview(30)).tasks).toHaveLength(1);
    store.tasks.setStatus("ACM-1", "review", undefined, NOW.toISOString());
    const report = await service.run(["ACM-1"], 30, "owner");
    expect(report.tasks[0]?.skipped).toBeDefined();
    expect(store.room.count("ACM-1")).toBe(3);
  });

  it("deletes a branch merged into a base the source checkout is not on", async () => {
    await git(source, "branch", "other");
    const { branch } = await seed({ id: "ACM-1", ahead: true });
    await git(source, "merge", "--quiet", "--no-ff", "-m", "merge", branch);
    await git(source, "checkout", "--quiet", "other");
    const report = await service.run(["ACM-1"], 30, "owner");
    expect(report.tasks[0]?.steps.map((s) => s.action)).toEqual(["remove", "remove"]);
    expect(await branches()).not.toContain(branch);
  });

  it("deletes a branch merged only into the remote base, on the project's MR remote", async () => {
    await addRemote("fork");
    remotes = { fork: { mr: true } };
    const { branch } = await seed({ id: "ACM-1", ahead: true });
    // The remote's main has the work; the local main does not.
    await git(source, "push", "--quiet", "fork", `${branch}:main`);
    await git(source, "fetch", "--quiet", "fork");
    expect(await git(source, "rev-parse", "main")).not.toBe(await git(source, "rev-parse", "fork/main"));
    await service.run(["ACM-1"], 30, "owner");
    expect(await branches()).not.toContain(branch);
  });

  it("keeps the branch of a merged MR when it holds commits that were never pushed", async () => {
    await addRemote("origin");
    const { worktree, branch } = await seed({ id: "ACM-1", ahead: true, mr: "merged" });
    await git(source, "push", "--quiet", "origin", branch);
    await writeFile(join(worktree, "late.txt"), "late\n");
    await git(worktree, "add", ".");
    await git(worktree, "commit", "--quiet", "-m", "late");
    const report = await service.run(["ACM-1"], 30, "owner");
    expect(report.tasks[0]?.steps[1]).toMatchObject({
      kind: "branch",
      action: "skip",
      reason: "it has commits that were never pushed",
    });
    expect(await branches()).toContain(branch);
  });

  it("deletes the branch of a merged MR when the remote branch holds everything", async () => {
    await addRemote("origin");
    const { branch } = await seed({ id: "ACM-1", ahead: true, mr: "merged" });
    await git(source, "push", "--quiet", "origin", branch);
    await service.run(["ACM-1"], 30, "owner");
    expect(await branches()).not.toContain(branch);
  });
});
