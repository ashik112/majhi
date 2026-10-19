import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../store/index.ts";
import { LoopGuard } from "./loop-guard.ts";
import { CaptainRepo } from "./repo.ts";

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
    const { guard, paused } = setup(memory());
    await answers(guard, "ACM-1", 2);
    expect(paused).toEqual([]);
    expect(await guard.answered("ACM-1")).toBe(true);
    expect(paused).toEqual(["ACM-1"]);
  });
});
