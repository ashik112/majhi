import type {
  Actor,
  Answer,
  DecideRequestInput,
  DecisionResult,
  MemorySettings,
  ProviderId,
} from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { UserError } from "../errors.ts";
import { type CurationTask, Curator } from "./curator.ts";
import { openMemoryDb } from "./db.ts";
import { HashEmbedder } from "./embedder.ts";
import { MAX_PROPOSALS_PER_TASK, MemoryService } from "./service.ts";
import { MemoryStore } from "./store.ts";

const owner: Actor = { kind: "owner" };
let clock = 0;
const now = () => new Date(Date.UTC(2026, 0, 1, 0, 0, clock++));

const TASK: CurationTask = { id: "ACM-1", org: "acme", projects: ["acme-api"] };
const SCOPES = ["global", "org:acme", "project:acme-api"];

/** An answer that counts, with its probability; its lift is as for two options. */
function sure(value: string | boolean, p: number): Answer {
  return {
    value,
    confidence: p,
    probabilities: { [String(value)]: p },
    gate: { accepted: true, reason: "test", lift: 2 * p - 1, margin: 1 },
  };
}
/** An answer the decision service would not let count. */
function unsure(value: string | boolean, p: number): Answer {
  return { ...sure(value, p), gate: { accepted: false, reason: "too close", lift: 0, margin: 0 } };
}

interface Call {
  request: DecideRequestInput;
  use: { use: string; task?: string | undefined; agent?: string | undefined };
}

/** Plays the decision provider: `answers` is what the next call says. */
function setup(initial: Partial<MemorySettings> = {}) {
  const memory = new MemoryService({
    store: new MemoryStore(openMemoryDb(":memory:")),
    embedder: new HashEmbedder(),
    now,
    embedWaitMs: 200,
  });
  const calls: Call[] = [];
  const outcomes: string[] = [];
  const box = {
    answers: {} as Record<string, Answer>,
    provider: "laya" as ProviderId,
    settings: { auto_threshold: 0.4, review_all: false, ...initial } as MemorySettings,
  };
  const curator = new Curator({
    memory,
    decisions: {
      decide: async (request, use) => {
        calls.push({ request, use });
        return {
          id: `dec_${calls.length}`,
          answers: box.answers,
          provider: box.provider,
          skipped: [],
          trimmed: false,
          estimated: false,
          durationMs: 1,
        } satisfies DecisionResult;
      },
      outcome: (_id, outcome) => void outcomes.push(outcome.text),
    },
    settings: async () => box.settings,
    task: (id) => (id === TASK.id ? TASK : undefined),
    allowed: async () => SCOPES,
  });
  memory.useCurator((fact) => curator.curate(fact));
  const propose = (text: string, scope = "project:acme-api") =>
    memory.propose({ text, scope, task: TASK.id, agent: "acme-builder" });
  const active = (text: string, scope = "project:acme-api") =>
    memory.add({ text, scope, pinned: false }, owner);
  const steps = (id: number) => memory.events({ fact: id }).map((e) => e.action);
  return { memory, curator, calls, outcomes, box, propose, active, steps };
}

const KEEP = { worth: sure("keep", 0.95), private: sure(false, 0.97) };

describe("curation of a proposal", () => {
  it("marks a near-identical fact as the same without asking a model, and adds nothing active", async () => {
    const t = setup();
    const old = await t.active("Use pnpm to install packages in acme-api every time you build it");
    const fact = await t.propose("Use pnpm to install packages in acme-api every time you build it now");
    expect(t.calls).toHaveLength(0);
    expect(fact).toMatchObject({ status: "rejected", duplicate_of: old.id });
    const [event] = t.memory.events({ fact: fact.id, limit: 1 });
    expect(event).toMatchObject({ action: "duplicate", actor: "curation", from: "pending" });
    expect(event?.confidence).toBeGreaterThanOrEqual(0.92);
    expect(t.memory.list({ status: "active" })).toHaveLength(1);
  });

  it("keeps a fact on its own above the threshold, logged with reason, confidence and provider", async () => {
    const t = setup();
    t.box.answers = KEEP;
    const fact = await t.propose("Builds run with Node 22 in acme-api");
    expect(fact).toMatchObject({ status: "active", decided_by: "curation" });
    const [event] = t.memory.events({ fact: fact.id, limit: 1 });
    expect(event).toMatchObject({ action: "approved", actor: "curation", provider: "laya", from: "pending" });
    expect(event?.confidence).toBeCloseTo(0.95);
    expect(event?.reason).toBeTruthy();
    // One call, with the decision recorded on the task as a memory decision.
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]?.use).toMatchObject({ use: "memory", task: "ACM-1", agent: "acme-builder" });
    // No nearest fact, so the relation is not asked.
    expect(Object.keys(t.calls[0]?.request.questions ?? {})).toEqual(["worth", "private"]);
  });

  it("keeps a lesson the provider is not sure about, saying so, since only global lessons and contradictions wait", async () => {
    const t = setup();
    // It counts, but its lift over chance (0.3) is under memory's stricter 0.4.
    t.box.answers = { worth: sure("keep", 0.65), private: sure(false, 0.97) };
    const first = await t.propose("Builds run with Node 22 in acme-api");
    expect(first.status).toBe("active");
    const [event] = t.memory.events({ fact: first.id, limit: 1 });
    expect(event).toMatchObject({ action: "approved", actor: "curation", from: "pending" });
    expect(event?.confidence).toBeUndefined();
    expect(event?.reason).toContain("Undo drops it");
    // Unsure chatter is not dropped on a guess either.
    t.box.answers = { worth: unsure("chatter", 0.99), private: sure(false, 0.97) };
    expect((await t.propose("The api listens on port 8080 locally")).status).toBe("active");
    // The rules provider only guesses: its answers never count, and the lesson is kept.
    t.box.answers = { worth: unsure("keep", 0.5), private: unsure(false, 0.3) };
    expect((await t.propose("Migrations live in the db folder of acme-api")).status).toBe("active");
  });

  it("drops task chatter above the threshold, and keeps the fact as rejected", async () => {
    const t = setup();
    t.box.answers = { worth: sure("chatter", 0.9), private: sure(false, 0.97) };
    const fact = await t.propose("Waiting for the tests to finish now");
    expect(fact).toMatchObject({ status: "rejected", decided_by: "curation" });
    expect(t.steps(fact.id)).toEqual(["rejected", "proposed"]);
  });

  it("asks nothing and leaves everything pending when every fact is reviewed", async () => {
    const t = setup({ review_all: true });
    t.box.answers = KEEP;
    expect((await t.propose("Builds run with Node 22 in acme-api")).status).toBe("pending");
    expect(t.calls).toHaveLength(0);
  });

  it("waits for the owner on a global fact, until the captain's upkeep in Private decides it", async () => {
    const t = setup();
    t.box.answers = KEEP;
    const fact = await t.propose("Everyone signs commits with a hardware key", "global");
    expect(fact.status).toBe("pending");
    expect(t.calls).toHaveLength(0);
    // The waiting fact told whoever counts the backlog.
    const waited: number[] = [];
    t.memory.onWaiting((f) => waited.push(f.id));
    const other = await t.propose("Everyone writes plain commit messages", "global");
    expect(waited).toEqual([other.id]);
    // review_all still holds for the upkeep.
    t.box.settings = { ...t.box.settings, review_all: true };
    await t.curator.curate(fact, { upkeep: true });
    expect(t.memory.get(fact.id)?.status).toBe("pending");
    t.box.settings = { ...t.box.settings, review_all: false };
    await t.curator.curate(fact, { upkeep: true });
    expect(t.memory.get(fact.id)?.status).toBe("active");
    expect(t.calls).toHaveLength(1);
  });

  it("drops a fact a model suspects of a secret, sure or not", async () => {
    const t = setup();
    t.box.answers = { worth: sure("keep", 0.99), private: unsure(true, 0.6) };
    const suspected = await t.propose("The staging login is shared by the team");
    expect(suspected.status).toBe("rejected");
    expect(t.memory.events({ fact: suspected.id, limit: 1 })[0]?.reason).toContain("Undo keeps it");
    t.box.answers = { worth: sure("keep", 0.99), private: sure(true, 0.95) };
    const dropped = await t.propose("The deploy account is the one we all share");
    expect(dropped.status).toBe("rejected");
    // Not sure it is private: the rules found nothing, so it is kept.
    t.box.answers = { worth: sure("keep", 0.99), private: unsure(false, 0.6) };
    expect((await t.propose("Deploys go out on Tuesdays only in acme-api")).status).toBe("active");
  });

  it("rejects personal data by the rules, even when every fact is reviewed and the model says keep", async () => {
    const t = setup({ review_all: true });
    t.box.answers = KEEP;
    const fact = await t.propose("Ask jane.doe@example.com when the release is blocked");
    expect(fact.status).toBe("rejected");
    expect(t.calls).toHaveLength(0);
    const [event] = t.memory.events({ fact: fact.id, limit: 1 });
    expect(event).toMatchObject({ action: "rejected", actor: "curation", provider: "rules" });
    // A phone number is personal data too; an address and a version are not.
    expect((await t.propose("Call the on-call engineer on 555-123-4567")).status).toBe("rejected");
    expect((await t.propose("The staging host is 192.168.100.100 on the office network")).status).toBe(
      "pending",
    );
  });

  it("does not let the Housekeeper's candidates use up the agent's proposals", async () => {
    const t = setup({ review_all: true });
    await t.curator.curateCandidates(
      TASK,
      Array.from({ length: 8 }, (_, i) => ({
        text: `Candidate number ${i} about the build`,
        scope: "org:acme",
      })),
      "acme-builder",
    );
    expect(t.memory.list({ task: TASK.id })).toHaveLength(8);
    for (let i = 0; i < MAX_PROPOSALS_PER_TASK; i++) await t.propose(`Proposal ${i} about deploys in api`);
    await expect(t.propose("One more proposal about deploys")).rejects.toThrow(UserError);
  });
});

describe("contradictions", () => {
  const OLD = "Use pnpm to install packages in acme-api";
  const NEW = "Do not use pnpm to install packages in acme-api";

  it("leaves a confident contradiction for the owner, and the old fact as it is", async () => {
    const t = setup();
    const old = await t.active(OLD);
    t.box.answers = { ...KEEP, relation: sure("contradicts", 0.93) };
    const fact = await t.propose(NEW);
    expect(fact.status).toBe("pending");
    expect(t.memory.get(old.id)?.status).toBe("active");
    // The nearest fact went into the state, and the relation was asked.
    expect(t.calls[0]?.request.state).toMatchObject({ candidate: NEW, nearest: OLD });
    expect(Object.keys(t.calls[0]?.request.questions ?? {})).toContain("relation");
  });

  it("leaves both as they are when the contradiction is not certain", async () => {
    const t = setup();
    const old = await t.active(OLD);
    t.box.answers = { ...KEEP, relation: sure("contradicts", 0.6) };
    const fact = await t.propose(NEW);
    expect(fact.status).toBe("pending");
    expect(t.memory.get(old.id)?.status).toBe("active");
  });

  it("does not let a narrower fact retire a wider one", async () => {
    const t = setup();
    const old = await t.active(OLD, "org:acme");
    t.box.answers = { ...KEEP, relation: sure("contradicts", 0.95) };
    const fact = await t.propose(NEW, "project:acme-api");
    expect(fact.status).toBe("pending");
    expect(t.memory.get(old.id)?.status).toBe("active");
  });

  it("merges a fact the model calls the same, and keeps an unrelated one", async () => {
    const t = setup();
    const old = await t.active(OLD);
    t.box.answers = { ...KEEP, relation: sure("same", 0.9) };
    const same = await t.propose(NEW);
    expect(same).toMatchObject({ status: "rejected", duplicate_of: old.id });
    t.box.answers = { ...KEEP, relation: sure("unrelated", 0.9) };
    const other = await t.propose("Do not use pnpm to install packages in acme-api either");
    expect(other.status).toBe("active");
  });
});

describe("candidates from the Housekeeper", () => {
  it("adds no row for a duplicate and logs it on the fact it matches", async () => {
    const t = setup();
    t.box.answers = KEEP;
    const old = await t.active("Use pnpm to install packages in acme-api every time you build it");
    const counts = await t.curator.curateCandidates(
      TASK,
      [
        {
          text: "Use pnpm to install packages in acme-api every time you build it now",
          scope: "project:acme-api",
        },
      ],
      "acme-builder",
    );
    expect(counts).toMatchObject({ candidates: 1, duplicates: 1, kept: 0 });
    expect(t.memory.list({})).toHaveLength(1);
    const [event] = t.memory.events({ fact: old.id, limit: 1 });
    expect(event).toMatchObject({ action: "duplicate", task: "ACM-1", actor: "curation" });
    expect(event?.from).toBeUndefined();
    expect(() => t.memory.undo(event?.id ?? 0, owner)).toThrow(/nothing to undo/);
  });

  it("stores no row for a secret or personal data, sends a scope the agents may not use to the org, and leaves inferred facts for review", async () => {
    const t = setup();
    t.box.answers = KEEP;
    const counts = await t.curator.curateCandidates(
      TASK,
      [
        { text: "Reach the owner at owner@example.com for access", scope: "org:acme" },
        { text: "Builds run with Node 22 in this repo", scope: "project:globex-web" },
        { text: "Tests run with the watch flag off in CI", scope: "org:acme" },
      ],
      "acme-builder",
    );
    expect(counts).toMatchObject({ candidates: 3, rejected: 1, pending: 2, kept: 0 });
    const facts = t.memory.list({ status: "pending" });
    expect(facts.map((f) => f.scope).sort()).toEqual(["org:acme", "org:acme"]);
    expect(facts.every((f) => f.agent === "acme-builder" && f.task === "ACM-1")).toBe(true);
    const proposed = t.memory.events({ task: "ACM-1" }).find((e) => e.action === "proposed");
    expect(proposed?.actor).toBe("housekeeper:acme-builder");
  });
});

describe("undo", () => {
  it("puts back an automatic keep, drop and merge", async () => {
    const t = setup();
    await t.active("Use pnpm to install packages in acme-api");
    t.box.answers = { ...KEEP, relation: sure("unrelated", 0.93) };
    const kept = await t.propose("Do not use pnpm to install packages in acme-api");
    expect(kept.status).toBe("active");
    const log = (id: number, action: string) => {
      const e = t.memory.events({ fact: id }).find((x) => x.action === action && x.actor === "curation");
      if (e === undefined) throw new Error(`no ${action} on ${id}`);
      return e;
    };

    // The keep comes off: back to pending, with no start.
    expect(t.memory.undo(log(kept.id, "approved").id, owner)).toMatchObject({ status: "pending" });
    expect(t.memory.get(kept.id)?.valid_from).toBeUndefined();

    // A drop.
    t.box.answers = { worth: sure("chatter", 0.9), private: sure(false, 0.9) };
    const dropped = await t.propose("Waiting for the tests to finish now");
    expect(dropped.status).toBe("rejected");
    expect(t.memory.undo(log(dropped.id, "rejected").id, owner).status).toBe("pending");

    // A merge: pending again and no longer pointing at the other fact.
    const twin = await t.propose("Use pnpm to install packages in acme-api always");
    expect(twin.duplicate_of).toBeDefined();
    expect(t.memory.undo(log(twin.id, "duplicate").id, owner)).toMatchObject({ status: "pending" });
    expect(t.memory.get(twin.id)?.duplicate_of).toBeUndefined();

    // Each undo is logged, and the step it undid is marked.
    expect(t.memory.events({ fact: kept.id }).some((e) => e.action === "restored")).toBe(true);
    expect(log(kept.id, "approved").undone).toBe(true);
  });

  it("undoes the owner's approve, reject and forget too", async () => {
    const t = setup({ review_all: true });
    const fact = await t.propose("Builds run with Node 22 in acme-api");
    const last = (action: string) => {
      const e = t.memory.events({ fact: fact.id }).find((x) => x.action === action);
      if (e === undefined) throw new Error(`no ${action}`);
      return e;
    };
    t.memory.approve(fact.id, owner);
    expect(t.memory.undo(last("approved").id, owner).status).toBe("pending");
    t.memory.reject(fact.id, owner);
    expect(t.memory.undo(last("rejected").id, owner).status).toBe("pending");
    t.memory.approve(fact.id, owner);
    t.memory.forget(fact.id, owner);
    expect(t.memory.undo(last("retired").id, owner).status).toBe("active");
  });

  it("refuses to undo a step twice, a step that something later changed, or a step that moved nothing", async () => {
    const t = setup({ review_all: true });
    const fact = await t.propose("Builds run with Node 22 in acme-api");
    t.memory.approve(fact.id, owner);
    const approved = t.memory.events({ fact: fact.id }).find((e) => e.action === "approved");
    t.memory.forget(fact.id, owner);
    // Retired since: the later step comes off first.
    expect(() => t.memory.undo(approved?.id ?? 0, owner)).toThrow(/Undo the later step first/);
    const retired = t.memory.events({ fact: fact.id }).find((e) => e.action === "retired");
    t.memory.undo(retired?.id ?? 0, owner);
    expect(() => t.memory.undo(retired?.id ?? 0, owner)).toThrow(/already undone/);
    const proposed = t.memory.events({ fact: fact.id }).find((e) => e.action === "proposed");
    expect(() => t.memory.undo(proposed?.id ?? 0, owner)).toThrow(/cannot be undone/);
    expect(() => t.memory.undo(9999, owner)).toThrow(/no event/);
  });
});
