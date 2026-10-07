import { describe, expect, it } from "vitest";
import {
  capacityOf,
  type Holder,
  type Limits,
  noRoomLine,
  planGrants,
  runsTotal,
  type SlotRequest,
  Slots,
} from "./limits.ts";

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

describe("capacityOf", () => {
  it("counts held and queued runs per account and against agents_max", async () => {
    const s = new Slots({
      limits: async () => limits,
      canEvict: () => false,
      evict: () => {},
      onQueue: () => {},
    });
    await s.acquire(req("a", "claude-personal"));
    await s.acquire(req("b", "claude-personal"));
    await s.acquire(req("c", "claude-acme"));
    // Three more on the full account wait in line.
    for (const key of ["d", "e", "f"]) void s.acquire(req(key, "claude-personal"));
    await s.pump();
    const capacity = capacityOf(s.state(), limits, ["claude-globex"]);
    expect(capacity).toEqual({
      agents: { inUse: 3, waiting: 3, limit: 6, free: 0 },
      accounts: [
        { account: "claude-acme", inUse: 1, waiting: 0, limit: 2, free: 1 },
        { account: "claude-globex", inUse: 0, waiting: 0, limit: 2, free: 2 },
        { account: "claude-personal", inUse: 2, waiting: 3, limit: 2, free: 0 },
      ],
    });
    expect(noRoomLine(capacity, ["claude-personal"])).toBe(
      "No free slot on claude-personal: 2 of 2 in use, 3 waiting.",
    );
    // A free account still waits when majhi as a whole is full.
    expect(noRoomLine(capacity, ["claude-globex"])).toBe("No free agent slot: 3 of 6 in use, 3 waiting.");
  });

  it("finds room only when every account and majhi have a slot nobody waits for", () => {
    const one = { holders: [{ account: "claude-acme" }], waiting: [] };
    expect(noRoomLine(capacityOf(one, limits), ["claude-acme", "claude-globex"])).toBeUndefined();
    const queued = { holders: [{ account: "claude-acme" }], waiting: [{ account: "claude-acme" }] };
    expect(noRoomLine(capacityOf(queued, limits), ["claude-acme"])).toBe(
      "No free slot on claude-acme: 1 of 2 in use, 1 waiting.",
    );
    const full = { holders: [{ account: "a" }, { account: "b" }], waiting: [] };
    expect(noRoomLine(capacityOf(full, { agents_max: 2, per_account: 2 }), ["c"])).toBe(
      "No free agent slot: 2 of 2 in use.",
    );
  });
});

describe("machine-wide run cap", () => {
  const capped: Limits = { agents_max: 6, per_account: 6, per_task: 6, runs_total: 2 };
  const helper = (key: string, task: string): SlotRequest => ({ key, task, account: "z" });
  function capSlots() {
    const box = { limits: capped };
    const s = new Slots({
      limits: async () => box.limits,
      canEvict: () => false,
      evict: () => undefined,
      onQueue: () => undefined,
    });
    return s;
  }

  it("queues the extra start across accounts and starts it when a run ends", async () => {
    const s = capSlots();
    expect(await s.acquire(req("a", "x"))).toBe(true);
    expect(await s.acquire(req("b", "y"))).toBe(true);
    let started = false;
    const third = s.acquire(req("c", "w")).then((ok) => (started = ok));
    await s.pump();
    expect(started).toBe(false);
    expect(s.position("c")).toBe(1);
    s.release("a");
    expect(await third).toBe(true);
  });

  it("serves the owner's start before earlier captain starts", async () => {
    const s = capSlots();
    await s.acquire(req("a", "x"));
    await s.acquire(req("b", "y"));
    const order: string[] = [];
    const captain = s.acquire(req("c", "w")).then(() => order.push("captain"));
    const owner = s.acquire({ ...req("d", "v"), owner: true }).then(() => order.push("owner"));
    await s.pump();
    expect(s.position("d")).toBe(1);
    s.release("a");
    await owner;
    s.release("b");
    await captain;
    expect(order).toEqual(["owner", "captain"]);
  });

  it("counts helper agents of the same task", async () => {
    const s = capSlots();
    await s.acquire(helper("t1:lead", "t1"));
    await s.acquire(helper("t1:helper", "t1"));
    let started = false;
    void s.acquire(helper("t1:helper2", "t1")).then((ok) => (started = ok));
    await s.pump();
    expect(started).toBe(false);
    expect(capacityOf(s.state(), capped).agents).toEqual({ inUse: 2, waiting: 1, limit: 2, free: 0 });
  });

  it("never lets the machine-wide run total exceed agents_max", () => {
    expect(runsTotal({ agents_max: 6, per_account: 2, per_task: 3, idle_timeout: "3m" }, 24)).toBe(6);
    expect(
      runsTotal({ agents_max: 6, per_account: 2, per_task: 3, idle_timeout: "3m", runs_total: 9 }, 24),
    ).toBe(6);
  });
});
