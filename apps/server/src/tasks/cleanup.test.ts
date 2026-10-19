import { mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Task } from "@majhi/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventHub } from "../events/hub.ts";
import { RoomService } from "../room/service.ts";
import { Store } from "../store/index.ts";
import { git, makeRepo, tempDir } from "../testing/fixtures.ts";
import { seedStatus } from "../testing/status.ts";
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

describe("run", () => {
  it("keeps a worktree with uncommitted changes, its branch and its files", async () => {
    const { worktree, branch } = await seed({ id: "ACM-1", dirty: true });
    const report = await service.run(["ACM-1"], 30, "owner");
    expect(report.tasks[0]?.steps.map((s) => s.action)).toEqual(["skip", "skip"]);
    expect(await exists(join(worktree, "scratch.txt"))).toBe(true);
    expect(await branches()).toContain(branch);
    expect(store.tasks.get("ACM-1")?.repos[0]?.worktree).toBe(worktree);
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
});
