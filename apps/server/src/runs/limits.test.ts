import { describe, expect, it } from "vitest";
import { type Holder, type Limits, planGrants, type SlotRequest, Slots } from "./limits.ts";

const limits: Limits = { agents_max: 6, per_account: 2, per_task: 3 };
const req = (key: string, account = "x", task = key): SlotRequest => ({ key, task, account });
const holder = (key: string, account = "x", busy = true, lastUsed = 0, task = key): Holder => ({
  key,
  task,
  account,
  busy,
  lastUsed,
});

describe("planGrants", () => {
  it("grants what fits and keeps the rest waiting", () => {
    expect(planGrants([req("a"), req("b"), req("c")], [], limits)).toEqual({ grant: ["a", "b"], evict: [] });
  });

  it("keeps request order: a later start never passes an earlier one on the same account", () => {
    const plan = planGrants([req("c"), req("d", "y"), req("e")], [holder("a"), holder("b")], limits);
    expect(plan.grant).toEqual(["d"]);
  });

  it("holds every later start while the global limit is full", () => {
    const plan = planGrants([req("c", "y"), req("d", "z")], [holder("a", "x"), holder("b", "w")], {
      ...limits,
      agents_max: 2,
    });
    expect(plan.grant).toEqual([]);
  });

  it("applies per_task", () => {
    const plan = planGrants([req("c", "y", "T")], [holder("a", "x", true, 0, "T")], {
      ...limits,
      per_task: 1,
    });
    expect(plan.grant).toEqual([]);
  });

  it("stops the least recently used idle process in the way, never a busy one", () => {
    const plan = planGrants([req("c")], [holder("a", "x", false, 5), holder("b", "x", false, 1)], limits);
    expect(plan).toEqual({ grant: ["c"], evict: ["b"] });
    expect(planGrants([req("c")], [holder("a"), holder("b")], limits)).toEqual({ grant: [], evict: [] });
    // An idle process on another account does not help an account limit.
    expect(planGrants([req("c")], [holder("a"), holder("b"), holder("z", "y", false)], limits).grant).toEqual(
      [],
    );
  });
});

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

  it("applies new limits live", async () => {
    const { s, box } = slots();
    await s.acquire(req("a"));
    await s.acquire(req("b"));
    const third = s.acquire(req("c"));
    box.limits = { ...limits, per_account: 3 };
    await s.pump();
    expect(await third).toBe(true);
  });

  it("stops an idle holder for a waiting start", async () => {
    const { s, evicted } = slots();
    await s.acquire(req("a"));
    await s.acquire(req("b"));
    s.mark("a", false);
    expect(await s.acquire(req("c"))).toBe(true);
    expect(evicted).toEqual(["a"]);
    expect(s.holds("a")).toBe(false);
  });
});
