import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../store/index.ts";
import { LoopGuard } from "./loop-guard.ts";
import { CaptainRepo } from "./repo.ts";
import { LOOP_GUARD_ANSWERS } from "./rules.ts";

/**
 * The loop guard: after LOOP_GUARD_ANSWERS captain answers to one task with no progress in between
 * (a new branch head or a status change), the task is paused for the owner. The count is stored.
 */

const dirs: string[] = [];
const stores: Store[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) s.close();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

/** Tasks with a status and a head, the way the guard reads progress; pauses are recorded. */
function setup(repo: CaptainRepo) {
  const tasks = new Map<string, { status: string; head: string }>([
    ["ACM-1", { status: "running", head: "a1" }],
    ["ACM-2", { status: "running", head: "b1" }],
  ]);
  const paused: string[] = [];
  const guard = new LoopGuard({
    repo,
    mark: async (id) => {
      const t = tasks.get(id);
      return t === undefined ? undefined : `${t.status}|${t.head}`;
    },
    pause: async (id) => {
      paused.push(id);
      const t = tasks.get(id);
      if (t !== undefined) t.status = "paused";
    },
  });
  return { tasks, paused, guard };
}

const memory = () => new CaptainRepo(new Store(":memory:").raw);

async function answers(guard: LoopGuard, task: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) await guard.answered(task);
}

describe("the loop guard", () => {
  it("pauses a task after three answers with no progress, and not before", async () => {
    expect(LOOP_GUARD_ANSWERS).toBe(3);
    const { guard, paused } = setup(memory());
    await answers(guard, "ACM-1", 2);
    expect(paused).toEqual([]);
    expect(await guard.answered("ACM-1")).toBe(true);
    expect(paused).toEqual(["ACM-1"]);
  });

  it("starts the count again after a commit", async () => {
    const { guard, paused, tasks } = setup(memory());
    await answers(guard, "ACM-1", 2);
    const t = tasks.get("ACM-1");
    if (t !== undefined) t.head = "a2";
    await answers(guard, "ACM-1", 2);
    expect(paused).toEqual([]);
    await guard.answered("ACM-1");
    expect(paused).toEqual(["ACM-1"]);
  });

  it("starts the count again after a status change", async () => {
    const { guard, paused, tasks } = setup(memory());
    await answers(guard, "ACM-1", 2);
    const t = tasks.get("ACM-1");
    if (t !== undefined) t.status = "review";
    await answers(guard, "ACM-1", 2);
    expect(paused).toEqual([]);
    if (t !== undefined) t.status = "running";
    await answers(guard, "ACM-1", 2);
    expect(paused).toEqual([]);
  });

  it("counts a task by itself: answers on another task do not add up", async () => {
    const { guard, paused } = setup(memory());
    await answers(guard, "ACM-1", 2);
    await answers(guard, "ACM-2", 2);
    expect(paused).toEqual([]);
    await guard.answered("ACM-2");
    expect(paused).toEqual(["ACM-2"]);
  });

  it("keeps the count over a restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "majhi-loop-guard-"));
    dirs.push(dir);
    const file = join(dir, "majhi.db");
    const open = () => {
      const store = new Store(file);
      stores.push(store);
      return new CaptainRepo(store.raw);
    };
    const first = setup(open());
    await answers(first.guard, "ACM-1", 2);
    const second = setup(open());
    expect(await second.guard.answered("ACM-1")).toBe(true);
    expect(second.paused).toEqual(["ACM-1"]);
  });

  it("pauses once when answers come at the same time, however many", async () => {
    const { guard, paused } = setup(memory());
    await guard.answered("ACM-1");
    await Promise.all([guard.answered("ACM-1"), guard.answered("ACM-1"), guard.answered("ACM-1")]);
    expect(paused).toEqual(["ACM-1"]);
  });

  it("pauses again only after the owner resumed it and the answers went on without progress", async () => {
    const { guard, paused, tasks } = setup(memory());
    await answers(guard, "ACM-1", 3);
    expect(paused).toEqual(["ACM-1"]);
    // Still paused, one more answer in flight: no second pause.
    await guard.answered("ACM-1");
    expect(paused).toEqual(["ACM-1"]);
    // The owner resumes (a status change), the loop goes on.
    const t = tasks.get("ACM-1");
    if (t !== undefined) t.status = "running";
    await answers(guard, "ACM-1", 3);
    expect(paused).toEqual(["ACM-1", "ACM-1"]);
  });

  it("guards nothing for a task that is gone", async () => {
    const { guard, paused } = setup(memory());
    await answers(guard, "ACM-9", 5);
    expect(paused).toEqual([]);
  });
});
