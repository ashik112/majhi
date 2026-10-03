import { describe, expect, it } from "vitest";
import {
  fairOrder,
  type Holder,
  type Limits,
  planGrants,
  type SlotRequest,
  Slots,
  turnKey,
} from "./limits.ts";

const wide: Limits = { agents_max: 6, per_account: 6, per_task: 3 };

const w = (key: string, workspace: string, account = "x", owner = false): SlotRequest => ({
  key,
  task: key,
  account,
  workspace,
  owner,
});
const hold = (key: string, workspace: string, account = "x"): Holder => ({
  key,
  task: key,
  account,
  workspace,
  busy: true,
  lastUsed: 0,
});
const turns = () => ({ workspace: new Map<string, number>(), account: new Map<string, number>() });
const grants = (waiting: SlotRequest[], holders: Holder[], limit: Limits = wide) =>
  planGrants(fairOrder(waiting, holders, turns(), true), holders, limit).grant;

describe("fair slots across workspaces", () => {
  it("shares agents_max evenly across three workspaces with work", () => {
    const waiting = [
      ...["a1", "a2", "a3", "a4"].map((k) => w(k, "acme")),
      ...["g1", "g2", "g3", "g4"].map((k) => w(k, "globex")),
      ...["n1", "n2", "n3", "n4"].map((k) => w(k, "northwind")),
    ];
    const got = grants(waiting, []);
    expect(got).toHaveLength(6);
    const by = (p: string) => got.filter((k) => k.startsWith(p)).length;
    expect([by("a"), by("g"), by("n")]).toEqual([2, 2, 2]);
  });

  it("serves the workspace below its share first, the odd slot going in turn", () => {
    const holders = [hold("r1", "acme"), hold("r2", "acme"), hold("r3", "acme")];
    const waiting = [w("a4", "acme"), w("g1", "globex"), w("g2", "globex"), w("g3", "globex")];
    expect(grants(waiting, holders)).toEqual(["g1", "g2", "g3"]);
    // Four slots, acme holding one: globex goes first, then the two alternate (two each).
    expect(grants(waiting, holders.slice(0, 1), { ...wide, agents_max: 4 })).toEqual(["g1", "a4", "g2"]);
  });

  it("a workspace with nothing waiting leaves its share to the others", () => {
    const holders = [hold("g-run", "globex")];
    const waiting = ["a1", "a2", "a3", "a4", "a5"].map((k) => w(k, "acme"));
    expect(grants(waiting, holders)).toEqual(["a1", "a2", "a3", "a4", "a5"]);
  });

  it("the owner's own runs go first and nothing running is stopped", () => {
    const holders = ["r1", "r2", "r3", "r4"].map((k) => hold(k, "acme"));
    const waiting = [w("g1", "globex"), w("g2", "globex"), w("own", "acme", "x", true)];
    const plan = planGrants(fairOrder(waiting, holders, turns(), true), holders, wide);
    expect(plan.grant).toEqual(["own", "g1"]);
    expect(plan.evict).toEqual([]);
  });

  it("keeps first come first served when fairness is off, the owner still first", () => {
    const waiting = [w("a1", "acme"), w("a2", "acme"), w("g1", "globex"), w("o", "globex", "x", true)];
    expect(fairOrder(waiting, [], turns(), false).map((r) => r.key)).toEqual(["o", "a1", "a2", "g1"]);
  });

  it("keeps per-account limits as hard caps", () => {
    const waiting = [w("a1", "acme", "claude-a"), w("a2", "acme", "claude-a"), w("g1", "globex", "claude-g")];
    expect(grants(waiting, [], { ...wide, per_account: 1 }).sort()).toEqual(["a1", "g1"]);
  });

  it("workspaces that share an account take its slots in turn", () => {
    const waiting = [
      w("a1", "acme", "claude-shared"),
      w("a2", "acme", "claude-shared"),
      w("g1", "globex", "claude-shared"),
      w("g2", "globex", "claude-shared"),
    ];
    expect(fairOrder(waiting, [], turns(), true).map((r) => r.key)).toEqual(["a1", "g1", "a2", "g2"]);
    // With one slot on the account, the workspace that went last time does not go again.
    const t = turns();
    t.account.set(turnKey("claude-shared", "acme"), 5);
    t.workspace.set("acme", 5);
    const order = fairOrder(waiting, [], t, true);
    expect(order[0]?.key).toBe("g1");
    expect(planGrants(order, [], { ...wide, per_account: 1 }).grant).toEqual(["g1"]);
  });

  it("Slots gives the next free slot to the workspace below its share and stops nothing", async () => {
    const evicted: string[] = [];
    const s = new Slots({
      limits: async () => ({ agents_max: 4, per_account: 4, per_task: 3 }),
      canEvict: () => true,
      evict: (key) => evicted.push(key),
      fair: () => true,
      onQueue: () => {},
    });
    for (const k of ["a1", "a2", "a3", "a4"]) expect(await s.acquire(w(k, "acme"))).toBe(true);
    const granted: string[] = [];
    void s.acquire(w("a5", "acme")).then((ok) => ok && granted.push("a5"));
    void s.acquire(w("g1", "globex")).then((ok) => ok && granted.push("g1"));
    await s.pump();
    expect(granted).toEqual([]);
    s.release("a1");
    await s.pump();
    expect(granted).toEqual(["g1"]);
    expect(evicted).toEqual([]);
  });
});
