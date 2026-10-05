import type {
  Answer,
  DecideRequestInput,
  DecisionOutcome,
  DecisionResult,
  MemorySettings,
} from "@majhi/shared";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { describe, expect, it } from "vitest";
import { migrate } from "../store/migrations.ts";
import { Curator } from "./curator.ts";
import { openMemoryDb } from "./db.ts";
import { HashEmbedder } from "./embedder.ts";
import { checkOwner } from "./extraction.ts";
import { MEMORY_MIGRATIONS } from "./migrations.ts";
import { Placer, type Registry } from "./placement.ts";
import { agentScopes, chatRecallScopes, recallScopes, writableScopes } from "./scopes.ts";
import { MemoryService } from "./service.ts";
import { MemoryStore } from "./store.ts";

const OWNER = { kind: "owner" } as const;
const REGISTRY: Registry = {
  orgs: [
    { id: "acme", name: "Acme" },
    { id: "globex", name: "Globex" },
  ],
  projects: [
    { id: "acme-api", org: "acme", about: "the orders API" },
    { id: "acme-web", org: "acme" },
    { id: "globex-billing", org: "globex" },
  ],
};
const PROJECT_ORGS = new Map(REGISTRY.projects.map((p) => [p.id, p.org]));
const ORGS = REGISTRY.orgs.map((o) => o.id);

/** Plays the decision provider: each question key answers from `say`, in order of the calls. */
function provider(say: Record<string, Answer>) {
  const calls: DecideRequestInput[] = [];
  const outcomes: { id: string; outcome: DecisionOutcome }[] = [];
  return {
    calls,
    outcomes,
    decisions: {
      decide: async (request: DecideRequestInput): Promise<DecisionResult> => {
        calls.push(request);
        const key = Object.keys(request.questions)[0] ?? "";
        const a = say[key];
        if (a === undefined) throw new Error("no provider");
        return {
          id: `dec_${calls.length}`,
          answers: { [key]: a },
          provider: "laya",
          skipped: [],
          trimmed: false,
          estimated: false,
          durationMs: 1,
        };
      },
      outcome: (id: string, outcome: DecisionOutcome) => void outcomes.push({ id, outcome }),
    },
  };
}

describe("where a fact goes", () => {
  it("never lets an org conversation write another org's scope, whatever is proposed or decided", async () => {
    expect(writableScopes({ org: "acme" }, PROJECT_ORGS, ORGS)).toEqual([
      "global",
      "org:acme",
      "project:acme-api",
      "project:acme-web",
    ]);
    const memory = service();
    const curator = new Curator({
      memory,
      decisions: provider({}).decisions,
      settings: async () => SETTINGS,
      task: () => undefined,
      allowed: async (t) => writableScopes(t, PROJECT_ORGS, ORGS),
      // A placer gone wrong: it names Globex.
      placer: { place: async () => ({ scope: "project:globex-billing", by: "decision", reason: "bad" }) },
    });
    await curator.curateCandidates(
      { id: "ACM-1", org: "acme", projects: [] },
      [
        { text: "Globex invoices use EUR.", scope: "org:globex", kind: "statement", source: "owner" },
        { text: "Invoices are numbered with no gaps.", scope: "project:globex-billing" },
      ],
      "boss",
    );
    expect(memory.list({}).map((f) => f.scope)).toEqual(["org:acme", "org:acme"]);
  });
});

const SETTINGS = { auto_threshold: 0.4, review_all: false } as MemorySettings;

function service() {
  return new MemoryService({
    store: new MemoryStore(openMemoryDb(":memory:")),
    embedder: new HashEmbedder(),
    embedWaitMs: 200,
  });
}

function curatorFor(memory: MemoryService, say: Record<string, Answer> = {}) {
  return new Curator({
    memory,
    decisions: provider(say).decisions,
    settings: async () => SETTINGS,
    task: () => undefined,
    allowed: async (t) => writableScopes(t, PROJECT_ORGS, ORGS),
    placer: new Placer({ decisions: provider(say).decisions, registry: async () => REGISTRY }),
  });
}

describe("what the owner said and what was inferred", () => {
  it("treats a quote the owner never said as an inferred lesson", () => {
    const owner = ["In acme-api, tenant only mode expects an X-Tenant header, remember that."];
    const [said, made] = checkOwner(
      [
        { text: "Tenant only mode expects an X-Tenant header.", kind: "statement", source: "owner" },
        { text: "Always deploy acme-web on Fridays after lunch.", kind: "statement", source: "owner" },
      ],
      owner,
    );
    expect(said).toMatchObject({ kind: "statement", source: "owner" });
    expect(made).toMatchObject({ kind: "lesson", source: "agent" });
  });
});

describe("shared recall", () => {
  it("gives a project fact from the captain chat to every agent of that project's org, never to another org", async () => {
    const memory = service();
    // The captain chat (no org) talked about acme-api; the owner said a rule about it.
    await curatorFor(memory).curateCandidates(
      { id: "BOSS-1", projects: ["acme-api"] },
      [
        {
          text: "Tenant only mode expects an X-Tenant header.",
          scope: "project:acme-api",
          kind: "statement",
          source: "owner",
        },
        {
          text: "Acme releases need a changelog line.",
          scope: "org:acme",
          kind: "statement",
          source: "owner",
        },
      ],
      "boss",
    );
    const all = memory.list({ status: "active" });
    expect(all.map((f) => f.scope).sort()).toEqual(["org:acme", "project:acme-api"]);

    // A later Acme task in acme-api, from any agent: both in TASK.md.
    const task = { org: "acme", repos: [{ project: "acme-api" }] };
    const recalled = await memory.recall(
      {
        id: "ACM-9",
        brief: "add the tenant header to the orders client, with a changelog line for the release",
      },
      recallScopes(task, PROJECT_ORGS),
    );
    expect(recalled.facts.map((f) => f.scope).sort()).toEqual(["org:acme", "project:acme-api"]);
    // The org lead with no repo of its own reads it through majhi-memory.
    const lead = agentScopes({ org: "acme", repos: [] }, PROJECT_ORGS);
    expect((await memory.search("tenant header", { scopes: lead })).map((h) => h.fact.scope)).toContain(
      "project:acme-api",
    );
    // An Acme chat that reads acme-api gets it too.
    const chat = chatRecallScopes({ org: "acme", repos: [] }, PROJECT_ORGS, ["acme-api"]);
    expect(chat).toContain("project:acme-api");

    // Globex never does, even when its chat names the Acme project.
    for (const scopes of [
      recallScopes({ org: "globex", repos: [{ project: "acme-api" }] }, PROJECT_ORGS),
      agentScopes({ org: "globex", repos: [] }, PROJECT_ORGS),
      chatRecallScopes({ org: "globex", repos: [] }, PROJECT_ORGS, ["acme-api"]),
    ]) {
      expect(scopes.some((s) => s === "org:acme" || s === "project:acme-api")).toBe(false);
      const hits = await memory.search("tenant header changelog", { scopes });
      expect(hits).toEqual([]);
    }
  });
});

describe("fact kinds and edits in the store", () => {
  it("marks facts the owner added before the migration as theirs, and leaves the rest as lessons", () => {
    const db = new Database(":memory:");
    sqliteVec.load(db);
    migrate(
      db,
      MEMORY_MIGRATIONS.filter((m) => m.id < 4),
    );
    const insert = db.prepare(
      "INSERT INTO facts (text, scope, agent, status, created_at) VALUES (?, 'org:acme', ?, 'active', '2026-09-01')",
    );
    insert.run("Acme deploys on Tuesdays.", "owner");
    insert.run("The pool is cold at start.", "acme-builder");
    migrate(db, MEMORY_MIGRATIONS);
    const facts = new MemoryStore(db).list({});
    expect(facts.map((f) => [f.text, f.kind, f.source])).toEqual([
      ["The pool is cold at start.", "lesson", "agent"],
      ["Acme deploys on Tuesdays.", "statement", "owner"],
    ]);
  });

  it("moves and rewords a fact, logs what changed, and searches the new words only", async () => {
    const memory = service();
    const fact = await memory.add(
      { text: "Orders use a cold pool.", scope: "org:acme", pinned: false },
      OWNER,
    );
    expect(fact).toMatchObject({ kind: "statement", source: "owner" });
    const edited = await memory.edit(
      fact.id,
      { text: "Tenant only mode expects an X-Tenant header.", scope: "project:acme-api" },
      OWNER,
    );
    expect(edited).toMatchObject({ scope: "project:acme-api", status: "active" });
    const [event] = memory.events({ fact: fact.id, limit: 1 });
    expect(event).toMatchObject({ action: "edited", actor: "owner" });
    expect(
      (await memory.search("tenant header", { scopes: ["project:acme-api"] })).map((h) => h.fact.id),
    ).toEqual([fact.id]);
    expect(await memory.search("cold pool orders", { scopes: ["project:acme-api", "org:acme"] })).toEqual([]);
    await expect(
      memory.edit(fact.id, { text: "The key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789" }, OWNER),
    ).rejects.toThrow();
  });
});
