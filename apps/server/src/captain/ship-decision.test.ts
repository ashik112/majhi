import { ALL_ASK, type Authority, type ShipFacts, type ShipRule } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { Store } from "../store/index.ts";
import { planOf } from "./authority-fixtures.ts";
import { createChores } from "./chores.ts";
import { LaneGate } from "./lane-gate.ts";
import type { CaptainPorts, ShipCheck } from "./ports.ts";
import { CaptainRepo } from "./repo.ts";
import { ChoreRunner, type Workspace } from "./runner.ts";

/**
 * The ship rules over the real chore and the real lane gate: the rows decide, a rule refines them by what
 * the task is, no rule lifts a guard, and the lane and the chore read one decision.
 */

const NOW = () => new Date("2026-10-04T10:00:00.000Z");
const DAY = "2026-10-04";

const bugRule: ShipRule = {
  id: "aaaaaaaa",
  when: { types: ["bug", "incident"], maxChangedLines: 200 },
  merge: "decide",
  deployStaging: "decide",
  deployProduction: "ask",
  tell: "decide",
};
const READY: ShipCheck = {
  ready: true,
  evidence: "checks pass",
  targets: [{ project: "api", into: "main", base: "main" }],
};
const bug: ShipFacts = { type: "bug", changedLines: 38, projects: ["api"] };
const feature: ShipFacts = { type: "feature", changedLines: 38, projects: ["api"] };

interface Setup {
  rows?: Authority;
  rules?: ShipRule[];
  facts?: ShipFacts;
  autonomous?: boolean;
  check?: () => ShipCheck;
  typing?: boolean;
  branches?: string[];
  /** The plan the second read gives, after the first: a rule changed in between. */
  later?: () => ShipFacts;
}

function setup(s: Setup = {}) {
  const rows = s.rows ?? { ...ALL_ASK, upkeep: "decide" };
  const repo = new CaptainRepo(new Store(":memory:").raw);
  const calls = { merged: 0, asked: 0, pushed: [] as boolean[] };
  let reads = 0;
  const ports = {
    typing: () => s.typing === true,
    answerTasks: async () => [],
    reviewTasks: async () => [{ id: "ACM-1", title: "Fix the coupon", heads: "abc" }],
    shipPlan: async () => {
      reads += 1;
      const facts = reads > 1 && s.later !== undefined ? s.later() : (s.facts ?? bug);
      return planOf(rows, { rules: s.rules ?? [], facts, autonomous: s.autonomous ?? true });
    },
    shipCheck: async () => s.check?.() ?? READY,
    ship: async (_org: string, _id: string, how: { push: boolean }) => {
      calls.merged += 1;
      calls.pushed.push(how.push);
      return { text: "Shipped ACM-1" };
    },
    shipReady: async () => {
      calls.asked += 1;
    },
    mrReady: async () => ({ ok: false as const, why: "No remote" }),
    openMrs: async () => ({ urls: [], host: "GitHub" }),
  } as unknown as CaptainPorts;
  const rules = {
    ...(s.rules === undefined ? {} : { ships: s.rules }),
    ...(s.branches === undefined ? {} : { branches: s.branches }),
  };
  const ws = (): Workspace => ({
    org: "acme",
    name: "Acme",
    mode: s.autonomous === false ? "off" : "on",
    authority: rows,
    rules,
    tz: "UTC",
    day: DAY,
    rulesOff: new Set(),
  });
  const runner = new ChoreRunner({
    repo,
    now: NOW,
    workspace: async () => ws(),
    stopped: () => false,
    tellOwner: () => undefined,
    laneTokens: () => 0,
    chores: createChores(ports, NOW),
  });
  const lane = new LaneGate({
    repo: new CaptainRepo(new Store(":memory:").raw),
    ports: ports as Pick<CaptainPorts, "reviewTasks" | "shipCheck" | "newRepos" | "shipPlan">,
    workspace: async () => ws(),
    now: NOW,
  });
  const chore = async () => {
    const r = await runner.startNow("acme", "ship");
    if (r.ran) await r.done;
  };
  return { chore, lane, calls };
}

const merge = { id: "ACM-1", into: "main" };

describe("a ship rule", () => {
  it("lets the captain merge a small bug with no click, where the row alone would ask", async () => {
    const t = setup({ rules: [bugRule] });
    await t.chore();
    expect(t.calls).toMatchObject({ merged: 1, asked: 0, pushed: [false] });
  });

  it("asks for a feature the same rule does not cover, and falls back to the row", async () => {
    const t = setup({ rules: [bugRule], facts: feature });
    await t.chore();
    expect(t.calls).toMatchObject({ merged: 0, asked: 1 });
  });

  it("asks for a bug over the line limit", async () => {
    const t = setup({ rules: [bugRule], facts: { ...bug, changedLines: 201 } });
    await t.chore();
    expect(t.calls).toMatchObject({ merged: 0, asked: 1 });
  });

  it("never merges when a guard fails, whatever the rule says", async () => {
    const failing: [string, Setup][] = [
      [
        "the checks are not green for the head",
        { check: () => ({ ready: false, why: "the hand-off check failed: tests" }) },
      ],
      [
        "a secret is in the diff",
        { check: () => ({ ready: false, why: "the diff of api holds what looks like a secret" }) },
      ],
      ["the owner is typing in the task", { typing: true }],
      ["the branch is not one the workspace ships to", { branches: ["release"] }],
      ["Autonomous is off", { autonomous: false }],
      ["the rule stopped covering it between the check and the act", { later: () => feature }],
    ];
    for (const [guard, over] of failing) {
      const t = setup({ rules: [bugRule], ...over });
      await t.chore();
      expect([guard, t.calls.merged]).toEqual([guard, 0]);
    }
  });

  it("pushes with the merge only where Push is the captain's", async () => {
    const t = setup({ rules: [bugRule], rows: { ...ALL_ASK, upkeep: "decide", push: "decide" } });
    await t.chore();
    expect(t.calls.pushed).toEqual([true]);
  });
});

describe("the lane and the chore", () => {
  const cases: [string, Setup, "merges" | "asks" | "rests"][] = [
    ["a small bug under the rule", { rules: [bugRule] }, "merges"],
    ["a feature the rule does not cover", { rules: [bugRule], facts: feature }, "asks"],
    ["a bug over the line limit", { rules: [bugRule], facts: { ...bug, changedLines: 500 } }, "asks"],
    ["no rules and the row on You", {}, "asks"],
    ["the row on Captain with no rules", { rows: { ...ALL_ASK, merge: "decide" } }, "merges"],
    ["Autonomous off", { rules: [bugRule], autonomous: false }, "rests"],
    ["a rule that leaves the merge to the owner", { rules: [{ ...bugRule, merge: "ask" }] }, "asks"],
  ];

  it.each(cases)("reach the same decision for %s", async (_name, over, outcome) => {
    const t = setup(over);
    await t.chore();
    // Off, the chore does not run at all: nothing merges and nothing is asked.
    expect([t.calls.merged, t.calls.asked]).toEqual(
      outcome === "merges" ? [1, 0] : outcome === "asks" ? [0, 1] : [0, 0],
    );
    const refused = await t.lane.check("acme", "tasks.merge", merge);
    expect(refused === undefined).toBe(outcome === "merges");
  });
});
