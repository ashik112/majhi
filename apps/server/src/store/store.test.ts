import type { Task } from "@majhi/shared";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { seedStatus } from "../testing/status.ts";
import { type RoomPayload, Store } from "./index.ts";
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
  it("opens with foreign keys on and creates every table", () => {
    const store = new Store(":memory:");
    expect(store.raw.pragma("foreign_keys", { simple: true })).toBe(1);
    const names = store.raw
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'room_search\\_%' ESCAPE '\\' AND name NOT LIKE 'kb\\_fts%' ESCAPE '\\' ORDER BY name",
      )
      .all()
      .map((r) => (r as { name: string }).name);
    expect(names).toEqual([
      "agenda_settings",
      "attachments",
      "audit",
      "automation_runs",
      "autonomy_budget_asks",
      "autonomy_day_caps",
      "autonomy_events",
      "autonomy_sizes",
      "autonomy_state",
      "autonomy_summaries",
      "autonomy_tasks",
      "budget_alerts",
      "budget_resumes",
      "captain_actions",
      "captain_cap_asks",
      "captain_chores",
      "captain_keys",
      "captain_lanes",
      "captain_loop_guard",
      "captain_runs",
      "captain_state",
      "chat_state",
      "clone_jobs",
      "crm_contacts",
      "crm_interactions",
      "crm_keys",
      "deadlines",
      "decision_calibration",
      "decision_evals",
      "decision_labels",
      "decision_links",
      "decision_recommendations",
      "decisions",
      "e2e_breaks",
      "e2e_runs",
      "e2e_seen",
      "findings",
      "goals",
      "handoff_deep",
      "handoff_history",
      "handoff_state",
      "kb_entries",
      "kb_versions",
      "migrations",
      "money_state",
      "morning_briefs",
      "ops_incidents",
      "ops_phone_sent",
      "ops_phone_tokens",
      "ops_samples",
      "ops_services",
      "ops_settings",
      "ops_state",
      "org_rates",
      "outbound_channels",
      "outbound_drafts",
      "outcomes",
      "playbook_custom",
      "playbook_runs",
      "playbook_state",
      "project_cards",
      "room_items",
      "room_search",
      "runs",
      "schedules",
      "scorecard_minutes",
      "sensor_cache",
      "task_allowances",
      "task_counters",
      "task_events",
      "task_links",
      "task_plans",
      "task_repos",
      "tasks",
      "tracker_links",
      "triggers",
      "trust_notices",
      "trust_state",
      "turns",
      "usage_events",
      "voice_profiles",
      "watch_samples",
      "watches",
    ]);
  });

  it("keeps token receipt events per task: one brief, deleted with the task, and a tools column on runs", () => {
    const store = new Store(":memory:");
    store.tasks.insert(task("ACME-1"));
    const e = store.usageEvents;
    expect(e.recordBrief("ACME-1", "builder", "2026-01-01T00:00:00.000Z", 900, 120)).toBe(true);
    expect(e.recordBrief("ACME-1", "reviewer", "2026-01-01T00:01:00.000Z", 1500, 300)).toBe(false);
    e.recordRecall("ACME-1", "builder", "2026-01-01T00:02:00.000Z", 80);
    e.recordCompaction({
      task: "ACME-1",
      agent: "builder",
      at: "2026-01-01T00:03:00.000Z",
      method: "native",
    });
    expect(e.forTask("ACME-1").map((r) => [r.kind, r.agent, r.tokens])).toEqual([
      ["brief", "builder", 900],
      ["memory", "builder", 120],
      ["recall", "builder", 80],
      ["compaction", "builder", null],
    ]);
    // A task that does not exist has no receipt to keep, and does not throw.
    expect(e.recordBrief("ACME-9", "builder", "2026-01-01T00:00:00.000Z", 1, 1)).toBe(false);
    const columns = store.raw.prepare("PRAGMA table_info(runs)").all() as { name: string }[];
    expect(columns.map((c) => c.name)).toContain("tools");
    store.raw.prepare("DELETE FROM tasks WHERE id = 'ACME-1'").run();
    expect(e.forTask("ACME-1")).toEqual([]);
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

describe("room search", () => {
  function seeded(): Store {
    const store = new Store(":memory:");
    store.tasks.insert(task("ACME-2"));
    store.tasks.insert(task("GLOBEX-1", { org: "globex" }));
    return store;
  }
  const words = (hit: { snippet: { text: string; hit: boolean }[] }, flag: boolean) =>
    hit.snippet.filter((p) => p.hit === flag).map((p) => p.text);

  it("finds messages and tool output across tasks, marks the matched words, and scopes to an org", () => {
    const store = seeded();
    store.room.upsert("ACME-2", "m1", { type: "agent", agent: "builder", text: "The migration is ready" });
    store.room.upsert("ACME-2", "t1", {
      type: "tool",
      agent: "builder",
      toolCallId: "c1",
      title: "Run tests",
      kind: "execute",
      status: "completed",
      locations: [],
      content: [{ type: "terminal", output: "2 failed: migrations.test.ts" }],
    });
    store.room.upsert("GLOBEX-1", "m2", { type: "system", level: "info", text: "Migration finished" });
    store.room.upsert("GLOBEX-1", "th", { type: "thought", agent: "lead", text: "migration secret plan" });

    const all = store.room.search("migrat", 10);
    expect(all.map((h) => `${h.task}/${h.item}`).sort()).toEqual(["ACME-2/m1", "ACME-2/t1", "GLOBEX-1/m2"]);
    const tool = all.find((h) => h.item === "t1");
    expect(tool).toMatchObject({ type: "tool", agent: "builder", taskTitle: "Title ACME-2", org: "acme" });
    expect(words(tool as never, true)).toEqual(["migrations"]);
    expect(store.room.search("migrat", 10, "globex").map((h) => h.item)).toEqual(["m2"]);
    expect(store.room.search("migration ready", 10).map((h) => h.item)).toEqual(["m1"]);
    expect(store.room.search("!!", 10)).toEqual([]);
  });

  it("follows edits, and forgets an item or a whole task when it goes", () => {
    const store = seeded();
    store.room.upsert("ACME-2", "m1", { type: "agent", agent: "builder", text: "drafting" });
    store.room.upsert("ACME-2", "m1", { type: "agent", agent: "builder", text: "finished the parser" });
    expect(store.room.search("drafting", 10)).toEqual([]);
    expect(store.room.search("parser", 10)).toHaveLength(1);
    store.tasks.remove("ACME-2");
    expect(store.room.search("parser", 10)).toEqual([]);
  });

  it("indexes the items that existed before the migration", () => {
    const db = new Database(":memory:");
    migrate(
      db,
      MIGRATIONS.filter((m) => m.id < 90),
    );
    db.prepare(
      "INSERT INTO tasks (id, title, brief, kind, status, folder, team, created_at, updated_at) VALUES ('ACME-2', 't', 'b', 'code', 'inbox', '/t', '[]', 'x', 'x')",
    ).run();
    db.prepare(
      "INSERT INTO room_items (task, id, seq, type, payload, at) VALUES ('ACME-2', 'm1', 1, 'owner', ?, 'x')",
    ).run(JSON.stringify({ text: "please fix the flaky test" }));
    migrate(db);
    const rows = db.prepare("SELECT rowid FROM room_search WHERE room_search MATCH 'flaky'").all();
    expect(rows).toHaveLength(1);
  });

  it("skips items whose payload is not JSON, before and after the migration", () => {
    const db = new Database(":memory:");
    migrate(
      db,
      MIGRATIONS.filter((m) => m.id < 90),
    );
    db.prepare(
      "INSERT INTO tasks (id, title, brief, kind, status, folder, team, created_at, updated_at) VALUES ('ACME-2', 't', 'b', 'code', 'inbox', '/t', '[]', 'x', 'x')",
    ).run();
    const insert = db.prepare(
      "INSERT INTO room_items (task, id, seq, type, payload, at) VALUES ('ACME-2', ?, ?, ?, ?, 'x')",
    );
    insert.run("t1", 1, "tool", "");
    insert.run("m1", 2, "owner", JSON.stringify({ text: "please fix the flaky test" }));
    migrate(db);
    expect(db.prepare("SELECT rowid FROM room_search WHERE room_search MATCH 'flaky'").all()).toHaveLength(1);
    insert.run("t2", 3, "tool", "not json");
    db.prepare("UPDATE room_items SET payload = '' WHERE id = 'm1'").run();
    expect(db.prepare("SELECT rowid FROM room_search WHERE room_search MATCH 'flaky'").all()).toEqual([]);
  });
});
