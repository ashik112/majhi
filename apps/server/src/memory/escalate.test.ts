import type {
  Actor,
  Answer,
  DecideRequestInput,
  DecisionResult,
  Fact,
  MemorySettings,
  ProviderId,
} from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { type CurationTask, Curator } from "./curator.ts";
import { openMemoryDb } from "./db.ts";
import { HashEmbedder } from "./embedder.ts";
import { ESCALATIONS_PER_DAY, unsureQuestions } from "./escalate.ts";
import { MemoryService } from "./service.ts";
import { MemoryStore } from "./store.ts";

/**
 * Memory escalation: where Laya is not sure about a waiting memory, the stand-in answers once, within the
 * day's budget, instead of leaving it to the owner. The providers are played by tables, so no model runs.
 */

const owner: Actor = { kind: "owner" };
let clock = 0;
const now = () => new Date(Date.UTC(2026, 0, 1, 0, 0, clock++));
const TASK: CurationTask = { id: "ACM-1", org: "acme", projects: ["acme-api"] };

const answer = (value: string | boolean, p: number, accepted = p >= 0.5): Answer => ({
  value,
  confidence: p,
  probabilities: { [String(value)]: p },
  gate: { accepted, reason: "test", lift: 2 * p - 1, margin: 1 },
});

interface Script {
  /** What Laya says: `kind` at `p`, or nothing usable (an answer under the bar). */
  laya: { kind: string; p: number; accepted?: boolean; relation?: [string, number] };
  /** What the stand-in says, or "down" for no answer, or "budget" for an exhausted day. */
  acp: { kind: string; p: number } | "down" | "budget" | "rules";
}

function setup(script: Script, escalate: { perDay: number } | false = { perDay: 3 }) {
  const memory = new MemoryService({
    store: new MemoryStore(openMemoryDb(":memory:")),
    embedder: new HashEmbedder(),
    now,
    embedWaitMs: 200,
  });
  const calls: { order: string; request: DecideRequestInput }[] = [];
  const teach: { decision: string; question: string; label: string }[] = [];
  const outcomes: { id: string; text: string }[] = [];
  const curator = new Curator({
    memory,
    escalate: escalate === false ? undefined : escalate,
    decisions: {
      decide: async (request, use) => {
        const order = (use.order ?? ["laya"]).join(",");
        calls.push({ order, request });
        const result = (
          provider: ProviderId,
          answers: Record<string, Answer>,
          id: string,
        ): DecisionResult => ({
          id,
          answers,
          provider,
          skipped: [],
          trimmed: false,
          estimated: provider === "acp",
          durationMs: 1,
        });
        if (order === "acp") {
          const a = script.acp;
          if (a === "down") throw new Error("no stand-in");
          if (a === "budget") throw new Error("The daily budget of 3 acp answers for memory is spent.");
          if (a === "rules") return result("rules", { verdict: answer("keep", 0.5) }, "dec_rules");
          return result("acp", { verdict: answer(a.kind, a.p), private: answer(false, 0.9) }, "dec_acp");
        }
        const l = script.laya;
        const answers: Record<string, Answer> = {
          verdict: answer(l.kind, l.p, l.accepted ?? l.p >= 0.5),
          private: answer(false, 0.97),
        };
        if (l.relation !== undefined) answers.relation = answer(l.relation[0], l.relation[1]);
        return result("laya", answers, "dec_laya");
      },
      outcome: (id, o) => void outcomes.push({ id, text: o.text }),
      teach: (decision, question, label) => void teach.push({ decision, question, label }),
    },
    settings: async () => ({ auto_threshold: 0.4, review_all: false }) as MemorySettings,
    task: (id) => (id === TASK.id ? TASK : undefined),
    allowed: async () => ["global", "org:acme", "project:acme-api"],
  });
  const review = async (text: string) => {
    const fact: Fact = await memory.propose({
      text,
      scope: "project:acme-api",
      task: TASK.id,
      agent: "acme-builder",
    });
    await curator.review(fact);
    return memory.get(fact.id)?.status;
  };
  return { memory, calls, teach, outcomes, review };
}

/** Under both the gate and one half: the review does not act on it. */
const UNSURE = { kind: "keep", p: 0.4, accepted: false } as const;

describe("memory escalation", () => {
  it("does not ask the stand-in when Laya is sure", async () => {
    const t = setup({ laya: { kind: "keep", p: 0.95 }, acp: "down" });
    expect(await t.review("Run pnpm db:migrate before starting the acme-api server")).toBe("active");
    expect(t.calls.map((c) => c.order)).toEqual(["laya"]);
  });

  it("lets the stand-in settle what Laya was unsure about, and labels Laya's decision with its answer", async () => {
    const t = setup({ laya: UNSURE, acp: { kind: "one-off", p: 0.9 } });
    expect(await t.review("Symptom: the build failed twice this afternoon with a timeout")).toBe("rejected");
    expect(t.calls.map((c) => c.order)).toEqual(["laya", "acp"]);
    expect(t.teach).toEqual([{ decision: "dec_laya", question: "verdict", label: "one-off" }]);
  });

  it("leaves the memory to the owner when the stand-in is down, out of budget, or only guesses", async () => {
    for (const acp of ["down", "budget", "rules"] as const) {
      const t = setup({ laya: UNSURE, acp });
      expect(await t.review(`A fact that nobody can settle ${acp}`)).toBe("pending");
      expect(t.teach).toEqual([]);
    }
  });

  it("leaves it to the owner when the stand-in is unsure too", async () => {
    const t = setup({ laya: UNSURE, acp: { kind: "keep", p: 0.3 } });
    expect(await t.review("A fact both are unsure about")).toBe("pending");
    expect(t.outcomes.some((o) => /still unsure/.test(o.text))).toBe(true);
  });

  it("without the setting, behaves as before: nothing is escalated", async () => {
    const t = setup({ laya: UNSURE, acp: { kind: "keep", p: 0.99 } }, false);
    expect(await t.review("A fact nobody escalates")).toBe("pending");
    expect(t.calls.map((c) => c.order)).toEqual(["laya"]);
  });

  it("never escalates a judgment call, which the owner makes by design", async () => {
    const t = setup({ laya: { kind: "ask", p: 0.95 }, acp: { kind: "keep", p: 0.99 } });
    expect(await t.review("This would change how every agent behaves in many tasks")).toBe("pending");
    expect(t.calls.map((c) => c.order)).toEqual(["laya"]);
  });

  it("never escalates a contradiction: the owner says which of the two holds", async () => {
    const t = setup({ laya: { kind: "keep", p: 0.9, relation: ["contradicts", 0.95] }, acp: "down" });
    await t.memory.add(
      {
        text: "Run database migrations with pnpm db:migrate before starting the acme-api server every time",
        scope: "project:acme-api",
        pinned: true,
      },
      owner,
    );
    const status = await t.review(
      "Start the acme-api server first, then run database migrations with pnpm db:migrate",
    );
    expect(status).toBe("pending");
    expect(t.calls.map((c) => c.order)).toEqual(["laya"]);
  });

  it("asks the stand-in once per memory, and asks it for the unsure questions only", () => {
    const sure = (a: Answer) => a.gate?.accepted === true || a.confidence >= 0.5;
    expect(
      unsureQuestions({ verdict: answer("keep", 0.9), private: answer(false, 0.9) }, sure, false),
    ).toEqual([]);
    expect(
      unsureQuestions({ verdict: answer("keep", 0.2, false), private: answer(false, 0.9) }, sure, false),
    ).toEqual(["verdict"]);
    // An unsure "no" on private is let through; an unsure "yes" is looked at again.
    expect(
      unsureQuestions({ verdict: answer("keep", 0.9), private: answer(false, 0.2, false) }, sure, false),
    ).toEqual([]);
    expect(
      unsureQuestions({ verdict: answer("keep", 0.9), private: answer(true, 0.2, false) }, sure, false),
    ).toEqual(["private"]);
    // The relation only matters when there is a nearest fact.
    expect(
      unsureQuestions({ verdict: answer("keep", 0.9), relation: answer("same", 0.2, false) }, sure, false),
    ).toEqual([]);
    expect(
      unsureQuestions({ verdict: answer("keep", 0.9), relation: answer("same", 0.2, false) }, sure, true),
    ).toEqual(["relation"]);
  });

  it("has a daily budget of its own", () => {
    expect(ESCALATIONS_PER_DAY).toBeGreaterThan(0);
    expect(ESCALATIONS_PER_DAY).toBeLessThanOrEqual(100);
  });
});
