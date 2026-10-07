import { ALL_ASK, type Authority } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { Store } from "../store/index.ts";
import { planOf } from "./authority-fixtures.ts";
import { createChores } from "./chores.ts";
import type { CaptainPorts } from "./ports.ts";
import { CaptainRepo } from "./repo.ts";
import { ChoreRunner } from "./runner.ts";

/**
 * The captain's own echo (D10). There is no guard that drops events the captain caused. A run the echo
 * starts finds every key already taken, so it reads the state and does and asks nothing: no ship, no
 * card answered, no lane turn, no memory looked at again.
 */

const RUNS: Authority = {
  ...ALL_ASK,
  merge: "decide",
  approvals: "decide",
  questions: "decide",
  upkeep: "decide",
};

/** Ports where every read answers and every port that acts or asks a model is counted. */
function world() {
  const calls: string[] = [];
  // These ports answer at once; the others return a promise.
  const sync = new Set(["approvals", "questions", "typing"]);
  const reads = new Set([
    "reviewTasks",
    "shipCheck",
    "shipPlan",
    "answerTasks",
    "approvals",
    "questions",
    "typing",
    "cardVerdict",
    "laneRest",
  ]);
  const stubs: Record<string, (...args: never[]) => unknown> = {
    reviewTasks: () => [{ id: "ACM-1", title: "Fix login", heads: "app@abc123", bases: "app@def456" }],
    shipCheck: () => ({
      ready: true,
      evidence: "checks pass",
      targets: [{ project: "app", into: "main", base: "main" }],
    }),
    shipPlan: () => planOf(RUNS),
    answerTasks: () => [],
    approvals: () => [
      {
        task: "ACM-1",
        item: "c1",
        agent: "acme-builder",
        command: "orgs.update",
        input: {},
        summary: "A change",
      },
    ],
    questions: () => [
      {
        task: "ACM-1",
        item: "q1",
        agent: "acme-builder",
        kind: "choice",
        text: "Go on?",
        options: [{ id: "yes", label: "Yes", effect: "none" }],
      },
    ],
    cardVerdict: () => ({ decision: "approved", why: "within the limits" }),
    decideCard: () => ({ ok: true }),
    ship: () => ({ text: "Shipped ACM-1", undoNote: "simulated" }),
    answer: () => ({ answered: true }),
    laneRest: () => undefined,
    askLane: () => ({ sent: true }),
    typing: () => false,
  };
  const ports = new Proxy({} as Record<string, unknown>, {
    get: (_t, name: string) => {
      const stub = stubs[name];
      if (stub === undefined) return undefined;
      if (sync.has(name))
        return (...args: never[]) => {
          calls.push(name);
          return stub(...args);
        };
      return async (...args: never[]) => {
        calls.push(name);
        return stub(...args);
      };
    },
  }) as unknown as CaptainPorts;
  const repo = new CaptainRepo(new Store(":memory:").raw);
  const now = () => new Date("2026-10-04T12:00:00.000Z");
  const runner = new ChoreRunner({
    repo,
    now,
    workspace: async () => ({
      org: "acme",
      name: "Acme",
      mode: "on",
      authority: RUNS,
      rules: undefined,
      tz: "UTC",
      day: "2026-10-04",
    }),
    stopped: () => false,
    tellOwner: () => {},
    laneTokens: () => 0,
    chores: createChores(ports, now),
  });
  const acted = () => calls.filter((c) => !reads.has(c));
  return { runner, repo, calls, acted };
}

describe("a run the captain's own echo starts", () => {
  it("finds every key taken: it acts and asks nothing the second time", async () => {
    const w = world();
    // The first pass ships the task, decides the card and asks the lane about the question.
    for (const chore of ["ship", "cards", "questions"] as const) await w.runner.start("acme", chore, "first");
    expect(w.acted().toSorted()).toEqual(["askLane", "decideCard", "ship"]);
    const lines = w.repo.allActions().length;
    w.calls.length = 0;
    // The echo: the same state is read again (the task still shows in review, the cards still show).
    for (const chore of ["ship", "cards", "questions"] as const) {
      expect(await w.runner.start("acme", chore, "its own echo")).toBe("done");
    }
    expect(w.acted()).toEqual([]);
    expect(w.repo.allActions()).toHaveLength(lines);
  });
});
