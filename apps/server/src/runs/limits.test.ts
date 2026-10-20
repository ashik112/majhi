import { describe, expect, it } from "vitest";
import { type Limits, runsTotal, type SlotRequest, Slots } from "./limits.ts";

const limits: Limits = { agents_max: 6, per_account: 2, per_task: 3 };
const req = (key: string, account = "x", task = key): SlotRequest => ({ key, task, account });

describe("Slots", () => {
  function slots(current: Limits = limits) {
    const evicted: string[] = [];
    let line = new Map<string, number>();
    let now = 0;
    const box = { limits: current };
    const s = new Slots({
      limits: async () => box.limits,
      canEvict: () => true,
      evict: (key) => evicted.push(key),
      onQueue: (p) => {
        line = p;
      },
      now: () => ++now,
    });
    return { s, evicted, line: () => line, box };
  }

  it("queues a third start on one account, shows its place, and starts it when a slot frees", async () => {
    const { s, line } = slots();
    expect(await s.acquire(req("a"))).toBe(true);
    expect(await s.acquire(req("b"))).toBe(true);
    let third = false;
    const pending = s.acquire(req("c")).then((ok) => {
      third = ok;
    });
    const fourth = s.acquire(req("d"));
    await s.pump();
    expect(third).toBe(false);
    expect(line()).toEqual(
      new Map([
        ["c", 1],
        ["d", 2],
      ]),
    );
    expect(s.position("d")).toBe(2);
    s.release("a");
    await pending;
    expect(third).toBe(true);
    expect(line()).toEqual(new Map([["d", 1]]));
    s.release("d");
    expect(await fourth).toBe(false);
  });
});

describe("machine-wide run cap", () => {
  it("never lets the machine-wide run total exceed agents_max", () => {
    const rest = {
      per_account: 2,
      per_task: 3,
      idle_timeout: "3m",
      tasks_running: 4,
      open_by_others: 5,
      captain_tasks: 2,
      captain_task_cost: { small: 2, medium: 5, large: 12 },
      worktrees: 15,
      env_wait: "30m",
    };
    expect(runsTotal({ agents_max: 6, ...rest }, 24)).toBe(6);
    expect(runsTotal({ agents_max: 6, ...rest, runs_total: 9 }, 24)).toBe(6);
  });
});
