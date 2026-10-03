import type { Actor, Answer, DecideRequestInput, DecisionResult, Fact, MemorySettings } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { type CurationTask, Curator } from "./curator.ts";
import { openMemoryDb } from "./db.ts";
import { HashEmbedder } from "./embedder.ts";
import { MemoryService } from "./service.ts";
import { MemoryStore } from "./store.ts";

/**
 * The captain's memory review: with a real bar, most waiting memories are dropped or merged, few are
 * kept, and only a judgment call is left for the owner. The provider is played by a table from the
 * candidate's text to the kind it sorts it into, so no model runs.
 */
const owner: Actor = { kind: "owner" };
let clock = 0;
const now = () => new Date(Date.UTC(2026, 0, 1, 0, 0, clock++));
const TASK: CurationTask = { id: "ACM-1", org: "acme", projects: ["acme-api"] };

const answer = (value: string | boolean, p = 0.9): Answer => ({
  value,
  confidence: p,
  probabilities: { [String(value)]: p },
  gate: { accepted: p >= 0.5, reason: "test", lift: 2 * p - 1, margin: 1 },
});

interface Verdict {
  kind: string;
  relation?: string;
  confidence?: number;
}

function setup(verdicts: Record<string, Verdict>, docs: Record<string, string> = {}) {
  const memory = new MemoryService({
    store: new MemoryStore(openMemoryDb(":memory:")),
    embedder: new HashEmbedder(),
    now,
    embedWaitMs: 200,
  });
  const asked: DecideRequestInput[] = [];
  const curator = new Curator({
    memory,
    decisions: {
      decide: async (request) => {
        asked.push(request);
        const text = String((request.state as { candidate: string }).candidate);
        const v = verdicts[text] ?? { kind: "keep" };
        const answers: Record<string, Answer> = {
          verdict: answer(v.kind, v.confidence ?? 0.9),
          private: answer(false, 0.97),
        };
        if (v.relation !== undefined) answers.relation = answer(v.relation);
        return {
          id: `dec_${asked.length}`,
          answers,
          provider: "laya",
          skipped: [],
          trimmed: false,
          estimated: false,
          durationMs: 1,
        } satisfies DecisionResult;
      },
      outcome: () => {},
    },
    settings: async () => ({ auto_threshold: 0.4, review_all: false }) as MemorySettings,
    task: (id) => (id === TASK.id ? TASK : undefined),
    allowed: async () => ["global", "org:acme", "project:acme-api"],
    inDocs: async (_task, text) => Object.entries(docs).find(([part]) => text.includes(part))?.[1],
  });
  const propose = (text: string) =>
    memory.propose({ text, scope: "project:acme-api", task: TASK.id, agent: "acme-builder" });
  const review = async (fact: Fact) => ({ ...(await curator.review(fact)), id: fact.id });
  return { memory, asked, propose, review };
}

const PINNED = "Run database migrations with pnpm db:migrate before starting the acme-api server every time";

describe("the captain's memory review", () => {
  it("drops one-offs and generic notes, merges copies, keeps durable facts and leaves only a contradiction", async () => {
    const texts = {
      durableA: "Invoices in acme-api are rounded half to even before tax is added, never after it",
      durableB: "The acme-api staging deploy needs the VPN profile named acme-stg to be connected",
      copyOfA: "Invoices in acme-api are rounded half to even before tax is added, never after it, always",
      symptom: "Symptom: agents waking each other in loops with no-op messages containing mentions",
      inDocs: "Explicit git worktree prune deletes live entries regardless of gc config",
      generic: "Duplicate work caught early by querying main before acting",
      majhi: "Agents in a task room are woken when another message mentions their handle",
      flaky: "The checkout test is flaky when it starts within 200 ms of the clock tick",
      contradiction: "Start the acme-api server first, then run database migrations with pnpm db:migrate",
    };
    const t = setup(
      {
        [texts.durableA]: { kind: "keep" },
        [texts.durableB]: { kind: "keep" },
        [texts.symptom]: { kind: "one-off" },
        [texts.generic]: { kind: "generic" },
        [texts.majhi]: { kind: "majhi" },
        [texts.flaky]: { kind: "flaky" },
        [texts.contradiction]: { kind: "keep", relation: "contradicts" },
      },
      { "git worktree prune": "AGENTS.md" },
    );
    const pinned = await t.memory.add({ text: PINNED, scope: "project:acme-api", pinned: true }, owner);

    const done: Record<string, { reason?: string; id: number }> = {};
    for (const [name, text] of Object.entries(texts)) {
      done[name] = await t.review(await t.propose(text));
    }
    const status = (name: string) => t.memory.get(done[name]?.id ?? 0)?.status;

    // Kept: only the two durable facts. Dropped: the symptom, the docs restatement, generic advice,
    // majhi's own behaviour and the flaky note. Merged: the copy. Waiting: the contradiction.
    expect(["durableA", "durableB"].map(status)).toEqual(["active", "active"]);
    expect(["symptom", "inDocs", "generic", "majhi", "flaky"].map(status)).toEqual([
      "rejected",
      "rejected",
      "rejected",
      "rejected",
      "rejected",
    ]);
    expect(status("copyOfA")).toBe("rejected");
    expect(t.memory.get(done.copyOfA?.id ?? 0)?.duplicate_of).toBe(done.durableA?.id);
    expect(status("contradiction")).toBe("pending");
    expect(t.memory.get(pinned.id)?.status).toBe("active");

    // Each step has a reason the log can show.
    expect(done.symptom?.reason).toBe("a one-off symptom of one task");
    expect(done.inDocs?.reason).toBe("already in the repo docs (AGENTS.md)");
    expect(done.generic?.reason).toBe("generic advice");
    expect(done.majhi?.reason).toBe("restates how majhi itself works");
    expect(done.flaky?.reason).toBe("a flaky or timing note");
    expect(done.copyOfA?.reason).toMatch(/^the same as fact/);
    expect(done.contradiction?.reason).toBe(`it may contradict fact ${pinned.id}`);

    // The tally: keep 2, merge 1, drop 5, ask 1.
    const all = Object.keys(texts).map(status);
    const tally = {
      keep: all.filter((s) => s === "active").length,
      drop: ["symptom", "inDocs", "generic", "majhi", "flaky"].length,
      merge: 1,
      ask: all.filter((s) => s === "pending").length,
    };
    expect(tally).toEqual({ keep: 2, drop: 5, merge: 1, ask: 1 });
    // No model was asked about the docs restatement or the copy.
    expect(t.asked).toHaveLength(Object.keys(texts).length - 2);
  });

  it("undoes a drop, which brings the fact back to waiting", async () => {
    const text = "Symptom: the deploy hangs for a minute after the cache warms up in acme-api";
    const t = setup({ [text]: { kind: "one-off" } });
    const fact = await t.propose(text);
    await t.review(fact);
    expect(t.memory.get(fact.id)?.status).toBe("rejected");
    const [event] = t.memory.events({ fact: fact.id, limit: 1 });
    expect(event?.action).toBe("rejected");
    t.memory.undo(event?.id ?? 0, owner);
    expect(t.memory.get(fact.id)?.status).toBe("pending");
  });

  it("leaves a broad rule, an unsure answer and a missing provider for the owner, and never keeps on a guess", async () => {
    const broad = "From now on every change in acme-api must go through a pull request";
    const vague = "The acme-api team likes small commits on Fridays";
    const t = setup({
      [broad]: { kind: "ask" },
      [vague]: { kind: "keep", confidence: 0.3 },
    });
    const a = await t.review(await t.propose(broad));
    const b = await t.review(await t.propose(vague));
    expect(t.memory.get(a.id)?.status).toBe("pending");
    expect(a.reason).toBe("it would change how agents behave broadly");
    expect(t.memory.get(b.id)?.status).toBe("pending");
    expect(b.reason).toBe("not sure what it is");
  });
});
