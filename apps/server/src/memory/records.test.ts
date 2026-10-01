import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Actor,
  BRIEF_WORDS,
  type Fact,
  type MemorySettings,
  type TaskRecord,
  type Thread,
} from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { wordCount } from "./brief-doc.ts";
import { CLEANUP_KEY, cleanupRepoDocFacts } from "./cleanup.ts";
import { type CurationTask, Curator, REPO_DOCS } from "./curator.ts";
import { openMemoryDb } from "./db.ts";
import { HashEmbedder } from "./embedder.ts";
import { renderMemorySection, TASK_MEMORY_CHARS } from "./recall.ts";
import { LESSON_DOC_COSINE, RepoDocs } from "./repo-docs.ts";
import { MemoryService } from "./service.ts";
import { MemoryStore } from "./store.ts";

const owner: Actor = { kind: "owner" };
let clock = 0;
const now = () => new Date(Date.UTC(2026, 0, 1, 0, 0, clock++));

function service() {
  return new MemoryService({
    store: new MemoryStore(openMemoryDb(":memory:")),
    embedder: new HashEmbedder(),
    now,
    embedWaitMs: 200,
  });
}

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const record = (task: string, org: string, project: string, done: string) => ({
  task,
  title: `Work on ${project}`,
  org,
  projects: [project],
  asked: `Change ${project}.`,
  done,
  decisions: "",
  outcome: "Merged into main.",
  left: "",
  repos: [],
});

describe("project briefs", () => {
  it("adds a version for each change, keeps every one, and restores an old one as the newest", () => {
    const m = service().project;
    expect(m.brief("acme-api")).toEqual({ versions: [] });
    const v1 = m.patchBrief(
      "acme-api",
      { "What it is": "The Acme api.", Architecture: "Handlers in src/." },
      { task: "ACM-1" },
    );
    expect(v1).toMatchObject({ version: 1, source: "built", task: "ACM-1" });
    const v2 = m.patchBrief("acme-api", { Architecture: "Handlers in src/handlers." }, { task: "ACM-2" });
    expect(v2).toMatchObject({ version: 2, source: "task" });
    expect(v2?.body).toContain("The Acme api.");
    expect(v2?.body).toContain("Handlers in src/handlers.");
    // Nothing changes: no version.
    expect(
      m.patchBrief("acme-api", { Architecture: "Handlers in src/handlers.", Other: "x" }, { task: "ACM-3" }),
    ).toBeUndefined();

    const v3 = m.restoreBrief("acme-api", 1);
    expect(v3).toMatchObject({ version: 3, source: "restored", restored_from: 1, body: v1?.body });
    expect(m.brief("acme-api").versions.map((v) => v.version)).toEqual([3, 2, 1]);
    // The version it replaced is still there, and restoring it is one more version.
    expect(m.restoreBrief("acme-api", 2).body).toBe(v2?.body);
    expect(() => m.restoreBrief("acme-api", 4)).toThrow(/already the brief/);
    expect(() => m.restoreBrief("acme-api", 9)).toThrow(/no brief version 9/);
    // Another project's brief is its own.
    expect(m.brief("globex-web").versions).toEqual([]);
  });

  it("keeps a brief under about 350 words of bullets", () => {
    const m = service().project;
    const long = "Word ".repeat(700);
    const brief = m.patchBrief("acme-api", { "What it is": long, Architecture: long }, { task: "ACM-1" });
    const bullets = (brief?.body ?? "").split("\n").filter((l) => l.startsWith("- "));
    expect(wordCount(bullets.join(" "))).toBeLessThanOrEqual(BRIEF_WORDS + 2 * bullets.length);
  });
});

describe("threads", () => {
  it("open, close by hand or by a done follow-up, and reopen", () => {
    const m = service().project;
    const a = m.openThread({ text: "Remove the old route", project: "acme-api", org: "acme", task: "ACM-1" });
    const b = m.openThread({
      text: "Add a timeout test",
      project: "acme-api",
      org: "acme",
      task: "ACM-1",
      followUp: "ACM-2",
    });
    expect(m.threads({ projects: ["acme-api"], status: "open" }).map((t) => t.id)).toEqual([b.id, a.id]);
    expect(m.closeFollowUps("ACM-2")).toBe(1);
    expect(m.thread(b.id)).toMatchObject({ status: "closed", closed_by: "follow-up:ACM-2" });
    expect(m.closeThread(a.id, "owner", "Not needed")).toMatchObject({
      status: "closed",
      closed_reason: "Not needed",
    });
    expect(() => m.closeThread(a.id, "owner")).toThrow(/already closed/);
    expect(m.reopenThread(a.id)).toMatchObject({ status: "open" });
    expect(m.thread(a.id)?.closed_by).toBeUndefined();
    expect(() => m.reopenThread(a.id)).toThrow(/already open/);
    expect(m.threads({ projects: ["globex-web"] })).toEqual([]);
  });
});

describe("scope isolation", () => {
  it("never gives one org's records to a search in another org's scopes", async () => {
    const m = service().project;
    await m.putRecord(record("ACM-1", "acme", "acme-api", "Moved the health check to src/health.ts."));
    await m.putRecord(
      record("GLX-1", "globex", "globex-web", "Moved the health check to src/health.ts too."),
    );
    const globex = ["org:globex", "project:globex-web"];
    const found = await m.records({ query: "health check", scopes: globex, limit: 10 });
    expect(found.map((h) => h.record.task)).toEqual(["GLX-1"]);
    expect((await m.records({ scopes: globex, limit: 10 })).map((h) => h.record.task)).toEqual(["GLX-1"]);
    // A project filter never widens the scopes.
    expect(await m.records({ query: "health", scopes: globex, project: "acme-api", limit: 10 })).toEqual([]);
    // Global alone sees no record: records are never global.
    expect(await m.records({ query: "health check", scopes: ["global"], limit: 10 })).toEqual([]);
  });
});

describe("the Memory section of TASK.md", () => {
  const big = (n: number) => "a long sentence about the work ".repeat(n);
  const rec = (i: number): TaskRecord => ({
    id: i,
    task: `ACM-${i}`,
    title: `Task ${i} ${big(5)}`,
    org: "acme",
    projects: ["acme-api"],
    asked: big(40),
    done: big(80),
    decisions: big(40),
    outcome: big(20),
    left: big(40),
    repos: [
      { project: "acme-api", branch: "task/x", base: "main", merged: true, head: "abc1234", commits: 3 },
    ],
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
  });
  const thread = (i: number): Thread => ({
    id: i,
    text: big(10),
    project: "acme-api",
    task: "ACM-1",
    status: "open",
    created_at: "2026-09-01T00:00:00Z",
  });
  const lesson = (i: number): Fact => ({
    id: i,
    text: `Lesson ${i}: ${big(6)}`,
    scope: "project:acme-api",
    kind: "lesson",
    source: "agent",
    status: "active",
    pinned: false,
    use_count: 0,
    created_at: "2026-09-01T00:00:00Z",
  });
  const brief = `## What it is\n\n${big(100)}\n\n## Architecture\n\n${big(100)}\n\n## Current state\n\n${big(100)}`;

  it("stays within about 1500 tokens with every part too big, and keeps a heading for each part", () => {
    const { text, lessons } = renderMemorySection({
      briefs: [
        { project: "acme-api", body: brief },
        { project: "acme-web", body: brief },
      ],
      records: [1, 2, 3, 4, 5].map(rec),
      threads: Array.from({ length: 50 }, (_, i) => thread(i + 1)),
      lessons: Array.from({ length: 100 }, (_, i) => lesson(i + 1)),
    });
    expect(text.length).toBeLessThanOrEqual(TASK_MEMORY_CHARS);
    for (const heading of [
      "### Project brief: acme-api",
      "### Past tasks like this one",
      "### Open threads",
      "### Lessons",
    ])
      expect(text).toContain(heading);
    // Only the lessons that fit are counted as given, in their order.
    expect(lessons.length).toBeGreaterThan(0);
    expect(lessons.map((f) => f.id)).toEqual(lessons.map((_, i) => i + 1));
    expect(text).toContain(`Lesson ${lessons.length}:`);
    expect(text).not.toContain(`Lesson ${lessons.length + 1}:`);
  });

  it("holds any smaller cap, and is empty when there is nothing", () => {
    for (const cap of [300, 1000, 2500]) {
      const { text } = renderMemorySection(
        {
          briefs: [{ project: "acme-api", body: brief }],
          records: [rec(1)],
          threads: [thread(1)],
          lessons: [lesson(1)],
        },
        cap,
      );
      expect(text.length).toBeLessThanOrEqual(cap);
    }
    expect(renderMemorySection({ briefs: [], records: [], threads: [], lessons: [] }).text).toBe("");
  });
});

describe("lessons that restate the repo docs", () => {
  const RULE = "Commit messages never mention AI assistants or add Co-Authored-By trailers.";
  const TASK: CurationTask = { id: "ACM-1", org: "acme", projects: ["acme-api"] };

  async function setup() {
    const repo = await mkdtemp(join(tmpdir(), "majhi-docs-"));
    dirs.push(repo);
    await writeFile(join(repo, "CLAUDE.md"), `# Rules\n\n- ${RULE}\n- Plain, direct writing in UI copy.\n`);
    await writeFile(join(repo, "README.md"), "# Acme api\n\nThe Acme api serves orders over HTTP.\n");
    const memory = service();
    const docs = new RepoDocs({ embed: (t) => memory.embed(t) });
    const curator = new Curator({
      memory,
      decisions: {
        decide: async () => {
          throw new Error("no provider");
        },
        outcome: () => undefined,
      },
      settings: async () => ({ auto_threshold: 0.4, review_all: false }) as MemorySettings,
      task: (id) => (id === TASK.id ? TASK : undefined),
      allowed: async () => ["global", "org:acme", "project:acme-api"],
      inDocs: async (_t, text) =>
        (await docs.match(text, await docs.chunks([repo]), LESSON_DOC_COSINE))?.chunk.file,
    });
    memory.useCurator((fact) => curator.curate(fact));
    return { repo, memory, docs, curator };
  }

  it("stores no Housekeeper lesson the docs already say, and drops such a proposal with Undo", async () => {
    const { memory, curator } = await setup();
    const counts = await curator.curateCandidates(
      TASK,
      [
        {
          text: "Commit messages never mention AI assistants, and never add Co-Authored-By trailers.",
          scope: "project:acme-api",
        },
        {
          text: "The orders endpoint times out when the pool is cold; warm it in the test setup.",
          scope: "project:acme-api",
        },
      ],
      "acme-builder",
    );
    expect(counts).toMatchObject({ candidates: 2, in_docs: 1, pending: 1 });
    expect(memory.list({}).map((f) => f.text)).toEqual([
      "The orders endpoint times out when the pool is cold; warm it in the test setup.",
    ]);

    const proposed = await memory.propose({
      text: RULE,
      scope: "project:acme-api",
      task: "ACM-1",
      agent: "acme-builder",
    });
    expect(proposed.status).toBe("rejected");
    const [step] = memory.events({ fact: proposed.id, limit: 1 });
    expect(step).toMatchObject({ action: "rejected", provider: REPO_DOCS, from: "pending" });
    expect(step?.reason).toContain("CLAUDE.md");
    expect(memory.undo(step?.id ?? 0, owner).status).toBe("pending");
  });

  it("rejects old pending facts near-identical to the docs once, logged and undoable, and leaves the rest", async () => {
    const { repo, memory, docs } = await setup();
    const store = memory;
    // Old facts, written before the rework: pending, not curated.
    const add = (text: string, scope: string) =>
      store.addCandidate({ text, scope, task: "ACM-1", agent: "acme-builder" });
    const restated = await add(RULE, "project:acme-api");
    const orgWide = await add("The Acme api serves orders over HTTP.", "org:acme");
    const kept = await add("The orders endpoint times out when the pool is cold.", "project:acme-api");
    const active = await memory.add({ text: RULE, scope: "project:acme-api", pinned: false }, owner);
    const projects = async () => [{ id: "acme-api", path: repo, org: "acme" }];

    expect(await cleanupRepoDocFacts({ memory, repoDocs: docs, projects })).toBe(2);
    expect(memory.get(restated.id)?.status).toBe("rejected");
    expect(memory.get(orgWide.id)?.status).toBe("rejected");
    expect(memory.get(kept.id)?.status).toBe("pending");
    // Only pending facts are touched.
    expect(memory.get(active.id)?.status).toBe("active");
    const [step] = memory.events({ fact: restated.id, limit: 1 });
    expect(step).toMatchObject({ action: "rejected", actor: "curation", provider: REPO_DOCS });
    expect(step?.reason).toMatch(/^Already in the repo docs \(CLAUDE\.md\)/);
    expect(memory.undo(step?.id ?? 0, owner).status).toBe("pending");

    // It runs once.
    expect(memory.project.meta(CLEANUP_KEY)).toBeDefined();
    expect(await cleanupRepoDocFacts({ memory, repoDocs: docs, projects })).toBe(0);
    expect(memory.get(restated.id)?.status).toBe("pending");
  });
});

describe("a record's merge status", () => {
  it("reads a repo merged after the record was written as merged, and saves it", async () => {
    const m = service().project;
    const repo = { project: "acme-api", branch: "task/acm-1-fix", base: "main", merged: false, commits: 2 };
    await m.putRecord({ ...record("ACM-1", "acme", "acme-api", "Fixed it."), repos: [repo] });

    let merged = false;
    const asked: string[] = [];
    m.setLanded(async (task) => {
      asked.push(task);
      return merged;
    });
    const list = async () => (await m.records({ project: "acme-api", limit: 10 }))[0]?.record.repos[0];
    expect(await list()).toMatchObject({ merged: false });

    merged = true;
    expect(await list()).toMatchObject({ merged: true });
    // Saved: the stored record says so, and git is not asked again.
    expect(m.record("ACM-1")?.repos[0]).toMatchObject({ merged: true });
    expect((await m.recordNow("ACM-1"))?.repos[0]).toMatchObject({ merged: true });
    expect(asked).toEqual(["ACM-1", "ACM-1"]);
  });
});
