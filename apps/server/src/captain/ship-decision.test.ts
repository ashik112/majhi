import type { Authority } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { Store } from "../store/index.ts";
import { FULL, planOf, RUNS } from "./authority-fixtures.ts";
import { createChores } from "./chores.ts";
import { LaneGate } from "./lane-gate.ts";
import type { CaptainPorts, ShipCheck } from "./ports.ts";
import { CaptainRepo } from "./repo.ts";
import { ChoreRunner, type Workspace } from "./runner.ts";

/**
 * The workspace's level over the real chore and the real lane gate: the level decides, no level lifts a
 * guard, and the lane and the chore read one decision.
 */

const NOW = () => new Date("2026-10-04T10:00:00.000Z");
const DAY = "2026-10-04";

const READY: ShipCheck = {
  ready: true,
  evidence: "checks pass",
  targets: [{ project: "api", into: "main", base: "main" }],
};
interface Setup {
  rows?: Authority;
  autonomous?: boolean;
  check?: () => ShipCheck;
  typing?: boolean;
  branches?: string[];
}

function setup(s: Setup = {}) {
  const rows = s.rows ?? RUNS;
  const repo = new CaptainRepo(new Store(":memory:").raw);
  const calls = { merged: 0, asked: 0, pushed: [] as boolean[] };
  const ports = {
    typing: () => s.typing === true,
    answerTasks: async () => [],
    reviewTasks: async () => [{ id: "ACM-1", title: "Fix the coupon", heads: "abc" }],
    shipPlan: async () => planOf(rows),
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
  const rules = s.branches === undefined ? {} : { branches: s.branches };
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

describe("the level at ship time", () => {
  it("never merges when a guard fails, whatever the level says", async () => {
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
    ];
    for (const [guard, over] of failing) {
      const t = setup({ rows: FULL, ...over });
      await t.chore();
      expect([guard, t.calls.merged]).toEqual([guard, 0]);
    }
  });
});
