import type {
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
import { MemoryService } from "./service.ts";
import { MemoryStore } from "./store.ts";

/**
 * Memory escalation: where Laya is not sure about a waiting memory, the stand-in answers once, within the
 * day's budget, instead of leaving it to the owner. The providers are played by tables, so no model runs.
 */

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

});
