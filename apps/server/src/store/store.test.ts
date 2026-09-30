import type { Task } from "@majhi/shared";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { type RoomPayload, Store } from "./index.ts";
import { MIGRATIONS, type Migration, migrate } from "./migrations.ts";

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
  it("opens with foreign keys on and creates every table", () => {
    const store = new Store(":memory:");
    expect(store.raw.pragma("foreign_keys", { simple: true })).toBe(1);
    const names = store.raw
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((r) => (r as { name: string }).name);
    expect(names).toEqual([
      "attachments",
      "audit",
      "decisions",
      "migrations",
      "room_items",
      "runs",
      "task_allowances",
      "task_counters",
      "task_links",
      "task_plans",
      "task_repos",
      "tasks",
      "turns",
    ]);
  });

  it("uses WAL on a file database", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "majhi-db-"));
    const store = Store.open(dir);
    expect(store.raw.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(store.raw.pragma("busy_timeout", { simple: true })).toBe(5000);
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("hands out task numbers per prefix without reusing them", () => {
    const { tasks } = new Store(":memory:");
    expect([
      tasks.allocateKey("GLX"),
      tasks.allocateKey("GLX"),
      tasks.allocateKey("LOCAL"),
      tasks.allocateKey("GLX"),
    ]).toEqual(["GLX-1", "GLX-2", "LOCAL-1", "GLX-3"]);
  });

  it("round-trips a task and lists it with its repos", () => {
    const { tasks } = new Store(":memory:");
    const t = task("ACME-2");
    tasks.insert(t);
    expect(tasks.get("ACME-2")).toEqual(t);
    expect(tasks.get("ACME-9")).toBeUndefined();
    tasks.insert(task("ACME-3", { updatedAt: "2026-02-01T00:00:00.000Z", repos: [], status: "done" }));
    expect(tasks.list(false).map((s) => s.id)).toEqual(["ACME-2"]);
    expect(tasks.list(true).map((s) => s.id)).toEqual(["ACME-3", "ACME-2"]);
    expect(tasks.list(true)[1]?.repos).toEqual([
      { project: "acme-api", branch: "task/ACME-2" },
      { project: "acme-web", branch: "feat/x" },
    ]);
  });

  it("updates status, worktrees and attachments, and removes everything with the task", () => {
    const store = new Store(":memory:");
    store.tasks.insert(task("ACME-2"));
    store.tasks.setStatus("ACME-2", "paused", "owner", "2026-03-01T00:00:00.000Z");
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

describe("room items", () => {
  const owner = (text: string, queued = false): RoomPayload => ({
    type: "owner",
    text,
    attachments: [],
    queued,
    to: "builder",
  });

  it("bumps seq on every write, keeps `at`, and replaces by id", () => {
    const store = new Store(":memory:");
    store.tasks.insert(task("ACME-2"));
    const a = store.room.upsert("ACME-2", "a", { type: "agent", agent: "builder", text: "he" });
    const b = store.room.upsert("ACME-2", "b", { type: "system", level: "info", text: "x" });
    const a2 = store.room.upsert("ACME-2", "a", { type: "agent", agent: "builder", text: "hello" });
    expect([a.seq, b.seq, a2.seq]).toEqual([1, 2, 3]);
    expect(a2.at).toBe(a.at);
    expect(b.at > a.at).toBe(true);
    expect(store.room.get("ACME-2", "a")).toEqual(a2);
    expect(store.room.page("ACME-2", 10).items.map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("pages older items newest first with a more flag", () => {
    const store = new Store(":memory:");
    store.tasks.insert(task("ACME-2"));
    for (let i = 1; i <= 5; i++)
      store.room.upsert("ACME-2", `i${i}`, { type: "system", level: "info", text: `${i}` });
    const first = store.room.page("ACME-2", 2);
    expect(first.items.map((i) => i.id)).toEqual(["i5", "i4"]);
    expect(first.more).toBe(true);
    const second = store.room.page("ACME-2", 2, 4);
    expect(second.items.map((i) => i.id)).toEqual(["i3", "i2"]);
    expect(second.more).toBe(true);
    expect(store.room.page("ACME-2", 5, 2)).toEqual({
      items: [expect.objectContaining({ id: "i1" })],
      more: false,
    });
  });

  it("finds queued owner items in the order sent, and pending permissions", () => {
    const store = new Store(":memory:");
    store.tasks.insert(task("ACME-2"));
    store.room.upsert("ACME-2", "o1", owner("one", true));
    store.room.upsert("ACME-2", "o2", owner("two", true));
    store.room.upsert("ACME-2", "o3", owner("three", false));
    store.room.upsert("ACME-2", "o1", owner("one", true));
    expect(store.room.queuedFor("ACME-2", "builder").map((i) => i.id)).toEqual(["o1", "o2"]);
    expect(store.room.queuedFor("ACME-2", "other")).toEqual([]);
    store.room.upsert("ACME-2", "p1", {
      type: "permission",
      agent: "builder",
      title: "Run ls",
      options: [{ id: "y", name: "Allow", kind: "allow_once" }],
      state: "pending",
    });
    expect(store.room.pendingPermissions().map((i) => i.id)).toEqual(["p1"]);
  });

  it("rejects a payload that breaks the contract", () => {
    const store = new Store(":memory:");
    store.tasks.insert(task("ACME-2"));
    // biome-ignore lint/suspicious/noExplicitAny: proves the store checks what it is given
    expect(() => store.room.upsert("ACME-2", "x", { type: "agent" } as any)).toThrow();
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

  it("logs decisions and remembers allowances per task and kind", () => {
    const store = new Store(":memory:");
    store.tasks.insert(task("ACME-2"));
    store.permissions.log({
      task: "ACME-2",
      agent: "builder",
      kind: "edit",
      title: "Edit a.ts",
      decision: "allow",
      by: "rule",
      at: "t",
    });
    expect(store.permissions.audit("ACME-2")).toHaveLength(1);
    expect(store.permissions.allowed("ACME-2", "execute")).toBe(false);
    store.permissions.allow("ACME-2", "execute");
    store.permissions.allow("ACME-2", "execute");
    expect(store.permissions.allowed("ACME-2", "execute")).toBe(true);
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
