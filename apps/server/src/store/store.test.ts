import type { Task } from "@majhi/shared";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { seedStatus } from "../testing/status.ts";
import { Store } from "./index.ts";
import { MIGRATIONS, type Migration, MigrationConflict, migrate } from "./migrations.ts";

function task(id: string, patch: Partial<Task> = {}): Task {
  return {
    id,
    title: `Title ${id}`,
    brief: "brief",
    kind: "code",
    org: "acme",
    status: "inbox",
    folder: `/tasks/${id}`,
    repos: [
      { project: "acme-api", source: "/w/api", base: "main", branch: `task/${id}`, createdBranch: true },
      { project: "acme-web", source: "/w/web", base: "develop", branch: "feat/x", createdBranch: false },
    ],
    team: ["builder"],
    mode: "lead",
    overrides: {},
    links: [{ type: "depends-on", task: "ACME-1", when: "merged" }],
    attachments: [{ id: "a1", kind: "link", name: "Spec", url: "https://e.com" }],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...patch,
  } as Task;
}

describe("migrations", () => {
  it("applies each migration once, in order, and records it", () => {
    const db = new Database(":memory:");
    const list: Migration[] = [
      { id: 2, name: "second", sql: "CREATE TABLE b (x INTEGER)" },
      { id: 1, name: "first", sql: "CREATE TABLE a (x INTEGER)" },
    ];
    expect(migrate(db, list)).toEqual([1, 2]);
    expect(migrate(db, list)).toEqual([]);
    const next = [...list, { id: 3, name: "third", sql: "ALTER TABLE a ADD COLUMN y TEXT" }];
    expect(migrate(db, next)).toEqual([3]);
    expect(db.prepare("SELECT id, name FROM migrations ORDER BY id").all()).toEqual([
      { id: 1, name: "first" },
      { id: 2, name: "second" },
      { id: 3, name: "third" },
    ]);
  });

  it("refuses two migrations with the same id, in the build or against the database", () => {
    const db = new Database(":memory:");
    const a: Migration = { id: 1, name: "add the widgets table", sql: "CREATE TABLE widgets (id INTEGER);" };
    const b: Migration = { id: 1, name: "add the gadgets table", sql: "CREATE TABLE gadgets (id INTEGER);" };
    expect(() => migrate(db, [a, b])).toThrow(MigrationConflict);
    expect(migrate(db, [a])).toEqual([1]);
    // Another branch shipped its own migration 1: this build must not skip it silently.
    expect(() => migrate(db, [b])).toThrow(/applied migration 1 as "add the widgets table"/);
    expect(migrate(db, [a])).toEqual([]);
  });

  it("rolls a failing migration back and does not record it", () => {
    const db = new Database(":memory:");
    const bad: Migration[] = [
      { id: 1, name: "bad", sql: "CREATE TABLE a (x INTEGER); CREATE TABLE a (y INTEGER)" },
    ];
    expect(() => migrate(db, bad)).toThrow();
    expect(db.prepare("SELECT count(*) AS n FROM migrations").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'a'").all()).toEqual([]);
  });
});

describe("store", () => {
  it("hands out task numbers per prefix without reusing them", () => {
    const { tasks } = new Store(":memory:");
    expect([
      tasks.allocateKey("GLX"),
      tasks.allocateKey("GLX"),
      tasks.allocateKey("LOCAL"),
      tasks.allocateKey("GLX"),
    ]).toEqual(["GLX-1", "GLX-2", "LOCAL-1", "GLX-3"]);
  });

  it("updates status, worktrees and attachments, and removes everything with the task", () => {
    const store = new Store(":memory:");
    store.tasks.insert(task("ACME-2"));
    seedStatus(store, "ACME-2", "paused", "owner", "2026-03-01T00:00:00.000Z");
    store.tasks.setWorktree("ACME-2", "acme-api", "/tasks/ACME-2/acme-api", false);
    store.tasks.addAttachments("ACME-2", [{ id: "a2", kind: "file", name: "x.txt", path: "x.txt" }]);
    const got = store.tasks.get("ACME-2");
    expect(got?.status).toBe("paused");
    expect(got?.pausedReason).toBe("owner");
    expect(got?.repos[0]).toMatchObject({ worktree: "/tasks/ACME-2/acme-api", createdBranch: false });
    expect(got?.attachments.map((a) => a.id)).toEqual(["a1", "a2"]);
    expect(store.tasks.openTasksUsing("acme-api")).toEqual(["ACME-2"]);
    store.room.upsert("ACME-2", "s1", { type: "system", level: "info", text: "hi" });
    store.tasks.remove("ACME-2");
    expect(store.tasks.get("ACME-2")).toBeUndefined();
    expect(store.room.page("ACME-2", 10).items).toEqual([]);
  });
});

describe("runs and permissions", () => {
  it("resumes the newest session and ends live runs", () => {
    const store = new Store(":memory:");
    store.tasks.insert(task("ACME-2"));
    const r1 = store.runs.start({
      task: "ACME-2",
      agent: "builder",
      sessionId: "s1",
      at: "2026-01-01T00:00:00.000Z",
    });
    store.runs.end(r1, "end", "2026-01-01T01:00:00.000Z");
    store.runs.start({
      task: "ACME-2",
      agent: "builder",
      sessionId: "s2",
      model: "m",
      effort: "e",
      at: "2026-01-02T00:00:00.000Z",
    });
    expect(store.runs.lastSessionId("ACME-2", "builder")).toBe("s2");
    expect(store.runs.lastSessionId("ACME-2", "other")).toBeUndefined();
    expect(store.runs.endAllLive("server-restart", "2026-01-03T00:00:00.000Z")).toBe(1);
    expect(store.runs.forTask("ACME-2").map((r) => [r.sessionId, r.stopReason])).toEqual([
      ["s1", "end"],
      ["s2", "server-restart"],
    ]);
  });

});

describe("start commit on task repos", () => {
  it("adds the column to an older database and keeps its rows readable", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "majhi-db-"));
    const file = join(dir, "majhi.db");
    const old = new Database(file);
    migrate(
      old,
      MIGRATIONS.filter((m) => m.id < 103),
    );
    old
      .prepare(
        "INSERT INTO tasks (id, title, brief, kind, status, folder, team, created_at, updated_at) VALUES ('ACME-1','t','b','code','review','/t/ACME-1','[]','x','x')",
      )
      .run();
    old
      .prepare(
        "INSERT INTO task_repos (task, project, source, base, branch, created_branch, pos) VALUES ('ACME-1','acme-api','/w/api','main','task/x',1,0)",
      )
      .run();
    old.close();

    const store = new Store(file);
    try {
      expect(store.tasks.get("ACME-1")?.repos[0]?.startCommit).toBeUndefined();
      store.tasks.setWorktree("ACME-1", "acme-api", "/t/ACME-1/acme-api", true, "abc1234");
      expect(store.tasks.get("ACME-1")?.repos[0]?.startCommit).toBe("abc1234");
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("merge request state on task repos", () => {
  it("adds its columns to a database made before migration 80 and reads them back", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "majhi-db-"));
    const file = join(dir, "majhi.db");
    const old = new Database(file);
    migrate(
      old,
      MIGRATIONS.filter((m) => m.id < 80),
    );
    old
      .prepare(
        "INSERT INTO tasks (id, title, brief, kind, status, folder, team, created_at, updated_at) VALUES ('ACME-1','t','b','code','review','/t/ACME-1','[]','x','x')",
      )
      .run();
    old
      .prepare(
        "INSERT INTO task_repos (task, project, source, base, branch, created_branch, pos) VALUES ('ACME-1','acme-api','/w/api','main','task/x',1,0)",
      )
      .run();
    old.close();

    const store = new Store(file);
    try {
      const before = store.tasks.get("ACME-1");
      expect(before?.repos[0]?.mr).toBeUndefined();
      expect(before?.repos[0]?.mergeOrder).toBeUndefined();

      store.tasks.setPushed("ACME-1", "acme-api", "2026-01-02T00:00:00.000Z");
      store.tasks.setMr("ACME-1", "acme-api", {
        url: "https://h/x/1",
        number: 1,
        state: "open",
        ci: "pending",
      });
      store.tasks.setMergeOrder("ACME-1", ["acme-api"]);
      expect(store.tasks.get("ACME-1")?.repos[0]).toMatchObject({
        pushedAt: "2026-01-02T00:00:00.000Z",
        mergeOrder: 0,
        mr: { url: "https://h/x/1", number: 1, state: "open", ci: "pending" },
      });
      store.tasks.setMergeOrder("ACME-1", null);
      expect(store.tasks.get("ACME-1")?.repos[0]?.mergeOrder).toBeUndefined();
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

