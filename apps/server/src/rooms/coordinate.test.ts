import { parseMentions } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import {
  asksOwner,
  firstTurn,
  type Member,
  pipelineStages,
  planTurn,
  type TurnEnd,
  verdictOf,
} from "./coordinate.ts";
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

describe("parseMentions", () => {
  it("finds known agents and owner in order, once each, lowercased", () => {
    expect(
      parseMentions("@Builder do it, then @reviewer. Thanks @builder @owner", ["builder", "reviewer"]),
    ).toEqual(["builder", "reviewer", "owner"]);
  });

  it("ignores mentions in code, in quotes, in emails and paths, and unknown handles", () => {
    const text = [
      "> @builder said this earlier",
      "Run `@builder` and see:",
      "```",
      "@reviewer inside code",
      "```",
      "mail me@builder.com, import @types/node, ask @nobody",
    ].join("\n");
    expect(parseMentions(text, ["builder", "reviewer"])).toEqual([]);
  });
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
    expect(plan.toOwner).toBe("@builder asked for you.");
  });
});

describe("planTurn: the loop guard", () => {
  it("pauses instead of handing on past the limit, and keeps the count", () => {
    const at = planTurn(turn({ mentions: ["builder"], state: { agentTurns: 11 } }));
    expect(at.handoffs).toHaveLength(1);
    expect(at.state.agentTurns).toBe(12);
    const over = planTurn(turn({ mentions: ["builder"], state: { agentTurns: 12 } }));
    expect(over.handoffs).toEqual([]);
    expect(over.pause).toMatch(/12 handoffs in a row changed no files/);
    expect(over.state.agentTurns).toBe(12);
  });

  it("counts every handoff of one message", () => {
    const plan = planTurn(turn({ mentions: ["builder", "web"], state: { agentTurns: 11 } }));
    expect(plan.handoffs).toEqual([]);
    expect(plan.pause).toBeDefined();
  });
});

describe("planTurn: pipeline", () => {
  it("runs each role once, in order, waiting for every builder", () => {
    expect(pipelineStages(team)).toEqual([["lead"], ["builder", "web"], ["reviewer"], ["tester"]]);
    const start = firstTurn("pipeline", team);
    expect(start.agents).toEqual(["lead"]);
    let state = start.state;
    const step = (from: string, mentions: string[] = []) => {
      const plan = planTurn(turn({ mode: "pipeline", from, mentions, state }));
      state = plan.state;
      return plan;
    };
    expect(step("lead", ["reviewer"]).handoffs).toEqual([
      { to: "builder", via: "pipeline" },
      { to: "web", via: "pipeline" },
    ]);
    expect(step("builder").handoffs).toEqual([]);
    // Someone outside the current step (the owner asked the tester something) moves nothing.
    expect(step("tester").handoffs).toEqual([]);
    expect(step("web").handoffs).toEqual([{ to: "reviewer", via: "pipeline" }]);
    expect(step("reviewer").handoffs).toEqual([{ to: "tester", via: "pipeline" }]);
    const last = step("tester");
    expect(last.handoffs).toEqual([]);
    expect(last.toOwner).toBe("Every step of the pipeline ran.");
  });

  it("holds the step when the agent asked the owner", () => {
    const plan = planTurn(
      turn({ mode: "pipeline", from: "lead", mentions: ["owner"], state: firstTurn("pipeline", team).state }),
    );
    expect(plan.handoffs).toEqual([]);
    expect(plan.state.stage).toBe(0);
    expect(plan.toOwner).toBeDefined();
  });
});

describe("planTurn: build and review loop", () => {
  const pair: Member[] = [
    { id: "builder", role: "Builder" },
    { id: "reviewer", role: "Reviewer" },
  ];
  const loop = (over: Partial<TurnEnd>) => planTurn(turn({ mode: "review-loop", team: pair, ...over }));

  it("starts with the builder and alternates until the reviewer approves", () => {
    expect(firstTurn("review-loop", pair).agents).toEqual(["builder"]);
    expect(loop({ from: "builder", state: { agentTurns: 0, round: 0 } }).handoffs).toEqual([
      { to: "reviewer", via: "review-loop" },
    ]);
    const back = loop({ from: "reviewer", verdict: "changes", state: { agentTurns: 1, round: 0 } });
    expect(back.handoffs).toEqual([{ to: "builder", via: "review-loop" }]);
    expect(back.state.round).toBe(1);
    const done = loop({ from: "reviewer", verdict: "approved", state: { agentTurns: 3, round: 1 } });
    expect(done.handoffs).toEqual([]);
    expect(done.toOwner).toBe("@reviewer approved the work.");
  });

  it("stops after the last round, and asks the owner when the verdict is unclear", () => {
    const capped = loop({ from: "reviewer", verdict: "changes", state: { agentTurns: 1, round: 4 } });
    expect(capped.handoffs).toEqual([]);
    expect(capped.pause).toMatch(/^5 review rounds without approval/);
    const unclear = loop({ from: "reviewer", verdict: "unclear", state: { agentTurns: 1, round: 0 } });
    expect(unclear.handoffs).toEqual([]);
    expect(unclear.toOwner).toMatch(/did not say/);
  });
});

describe("verdictOf", () => {
  it("reads approval and change requests, changes first", () => {
    expect(verdictOf("All good. APPROVED")).toBe("approved");
    expect(verdictOf("LGTM, ship it")).toBe("approved");
    expect(verdictOf("CHANGES NEEDED: the test is missing")).toBe("changes");
    expect(verdictOf("I cannot approve this yet, the handler leaks")).toBe("changes");
    expect(verdictOf("Not approved: see below")).toBe("changes");
    expect(verdictOf("I looked at the handler.")).toBeUndefined();
  });
});

describe("asksOwner", () => {
  it("counts a question or a request for a decision that is not for another agent", () => {
    expect(asksOwner("The branch is ready. Should I open the MR, or wait for you to check it?")).toBe(true);
    expect(asksOwner("Done with the parser. Please confirm the new flag name.")).toBe(true);
    expect(asksOwner("@owner the migration is ready")).toBe(true);
    expect(asksOwner("Your call: keep the old endpoint or drop it.")).toBe(true);
  });

  it("does not count a status, a question to an agent, or a question in code or a quote", () => {
    expect(asksOwner("All done. The fix is merged into the task branch and the tests pass.")).toBe(false);
    expect(asksOwner("@acme-builder can you add the missing null check?")).toBe(false);
    expect(asksOwner("Fixed it.\n```\nif (x?.y) return\n```\nThe `a ? b : c` stays.")).toBe(false);
    expect(asksOwner("> Why does it fail?\nIt failed on a missing import; fixed.")).toBe(false);
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
