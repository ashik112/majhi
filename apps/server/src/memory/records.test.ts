import { describe, expect, it } from "vitest";
import { openMemoryDb } from "./db.ts";
import { HashEmbedder } from "./embedder.ts";
import { MemoryService } from "./service.ts";
import { MemoryStore } from "./store.ts";

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
    expect(() => m.restoreBrief("acme-api", 4)).toThrow();
    expect(() => m.restoreBrief("acme-api", 9)).toThrow();
    // Another project's brief is its own.
    expect(m.brief("globex-web").versions).toEqual([]);
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
