import { describe, expect, it } from "vitest";
import { type Member, planTurn, type TurnEnd, unreviewed } from "./coordinate.ts";
import { WorktreeLocks } from "./locks.ts";

const team: Member[] = [
  { id: "lead", role: "Lead" },
  { id: "builder", role: "Builder" },
  { id: "web", role: "Builder" },
  { id: "reviewer", role: "Reviewer" },
  { id: "tester", role: "Tester" },
];
const limits = { maxAgentTurns: 12, reviewRounds: 5 };
const turn = (over: Partial<TurnEnd>): TurnEnd => ({
  mode: "lead",
  team,
  from: "lead",
  mentions: [],
  state: { agentTurns: 0 },
  limits,
  ...over,
});

describe("planTurn: lead delegates", () => {
  it("hands work to every mentioned teammate and counts the turns", () => {
    const plan = planTurn(turn({ mentions: ["builder", "web"] }));
    expect(plan.handoffs).toEqual([
      { to: "builder", via: "mention" },
      { to: "web", via: "mention" },
    ]);
    expect(plan.state.agentTurns).toBe(2);
  });

  it("never hands to the speaker or to agents outside the team, and flags @owner", () => {
    const plan = planTurn(turn({ from: "builder", mentions: ["builder", "stranger", "owner"] }));
    expect(plan.handoffs).toEqual([]);
    expect(plan.toOwner).toBeDefined();
  });

  it("wakes nobody for a waiting reply while the owner has a question pending, mentions or not", () => {
    const plan = planTurn(turn({ from: "builder", mentions: ["lead"], waiting: true }));
    expect(plan.handoffs).toEqual([]);
    expect(plan.state.agentTurns).toBe(0);
    for (const mode of ["pipeline", "review-loop"] as const)
      expect(planTurn(turn({ mode, from: "builder", waiting: true })).handoffs).toEqual([]);
  });
});

describe("planTurn: the loop guard", () => {
  it("past the limit wakes only the lead once, then pauses if the loop goes on", () => {
    const at = planTurn(turn({ mentions: ["builder"], state: { agentTurns: 11 } }));
    expect(at.handoffs).toHaveLength(1);
    expect(at.state.agentTurns).toBe(12);
    const first = planTurn(turn({ from: "builder", mentions: ["reviewer"], state: { agentTurns: 12 } }));
    expect(first.handoffs).toEqual([]);
    expect(first.pause).toBeUndefined();
    expect(first.nudge?.to).toBe("lead");
    expect(first.state).toMatchObject({ agentTurns: 0, nudged: true });
    const again = planTurn(
      turn({ from: "builder", mentions: ["reviewer"], state: { agentTurns: 12, nudged: true } }),
    );
    expect(again.handoffs).toEqual([]);
    expect(again.nudge).toBeUndefined();
    expect(again.pause).toBeDefined();
    expect(again.state.agentTurns).toBe(12);
  });

  it("counts every handoff of one message", () => {
    const plan = planTurn(turn({ mentions: ["builder", "web"], state: { agentTurns: 11 } }));
    expect(plan.handoffs).toEqual([]);
    expect(plan.nudge).toBeDefined();
  });
});

describe("unreviewed", () => {
  it("holds only when the worktrees changed since the last review, and not when either state is unknown", () => {
    expect(unreviewed({ fingerprint: "b", reviewedFingerprint: "a" })).toBe(true);
    expect(unreviewed({ fingerprint: "a", reviewedFingerprint: "a" })).toBe(false);
    // A room state from before reviews were recorded, or worktrees git could not read.
    expect(unreviewed({ fingerprint: "b" })).toBe(false);
    expect(unreviewed({ reviewedFingerprint: "a" })).toBe(false);
  });
});

describe("WorktreeLocks", () => {
  it("lets one owner edit a worktree at a time, first come first served", async () => {
    const locks = new WorktreeLocks();
    const order: string[] = [];
    const a = await locks.acquire(["/t/api"], "a");
    const waits: string[] = [];
    const b = locks.acquire(["/t/api"], "b", { onWait: (_p, holder) => waits.push(holder) }).then((r) => {
      order.push("b");
      return r;
    });
    const c = locks.acquire(["/t/api"], "c").then((r) => {
      order.push("c");
      return r;
    });
    // A different worktree is free at once: parallel builders on different repos.
    const d = await locks.acquire(["/t/web"], "d");
    expect(locks.holder("/t/web")).toBe("d");
    expect(waits).toEqual(["a"]);
    a();
    (await b)();
    (await c)();
    d();
    expect(order).toEqual(["b", "c"]);
    expect(locks.holder("/t/api")).toBeUndefined();
  });

  it("takes several worktrees in path order, so two owners cannot deadlock, and gives up on abort", async () => {
    const locks = new WorktreeLocks();
    const first = await locks.acquire(["/t/web", "/t/api"], "a");
    const controller = new AbortController();
    const waiting = locks.acquire(["/t/api", "/t/web"], "b", { signal: controller.signal });
    controller.abort();
    await expect(waiting).rejects.toThrow(/Stopped/);
    first();
    expect(locks.holder("/t/api")).toBeUndefined();
    expect(locks.holder("/t/web")).toBeUndefined();
    const again = await locks.acquire(["/t/api"], "b");
    again();
  });
});
