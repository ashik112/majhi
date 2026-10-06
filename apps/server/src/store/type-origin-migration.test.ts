import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "./index.ts";
import { MIGRATIONS, migrate } from "./migrations.ts";

/** Migration 176: tasks made before types and origins stay readable, untyped and with no origin. */

const AT = "2026-10-05T10:00:00.000Z";
let dir: string | undefined;
afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/** A database as it was before migration 176, with its old tasks in it. */
function oldDatabase(): string {
  dir = mkdtempSync(join(tmpdir(), "majhi-origin-"));
  const file = join(dir, "majhi.db");
  const db = new Database(file);
  db.pragma("foreign_keys = ON");
  migrate(
    db,
    MIGRATIONS.filter((m) => m.id < 176),
  );
  const insert = db.prepare(
    "INSERT INTO tasks (id, title, brief, kind, status, folder, team, created_at, updated_at) VALUES (?, ?, ?, 'code', ?, '/t', '[]', ?, ?)",
  );
  insert.run("ACM-1", "Fix the cart badge", "Fix the cart badge", "running", AT, AT);
  insert.run("ACM-2", "Write the tests", "Write the tests", "inbox", AT, AT);
  db.prepare("INSERT INTO task_links (task, type, other) VALUES ('ACM-2', 'parent', 'ACM-1')").run();
  db.close();
  return file;
}

describe("the task type and origin migration", () => {
  it("keeps every old task readable with no type and no origin, and a child still names its parent", () => {
    const store = new Store(oldDatabase());
    try {
      const task = store.tasks.get("ACM-1");
      expect(task?.title).toBe("Fix the cart badge");
      expect(task?.typing).toBeUndefined();
      expect(task?.origin).toBeUndefined();
      const rows = store.tasks.list(true);
      expect(rows.map((r) => [r.id, r.typing, r.origin, r.trail.length])).toEqual([
        ["ACM-2", undefined, { kind: "parent", task: "ACM-1", name: "Fix the cart badge" }, 0],
        ["ACM-1", undefined, undefined, 1],
      ]);
    } finally {
      store.close();
    }
  });

  it("reads a half-written or unknown type as untyped and an origin that does not parse as none", () => {
    const store = new Store(oldDatabase());
    try {
      const sql = store.raw;
      sql.prepare("UPDATE tasks SET type = 'bug', type_by = NULL WHERE id = 'ACM-1'").run();
      sql
        .prepare(
          "UPDATE tasks SET type = 'epic', type_by = 'owner', origin = '{\"kind\":\"nope\"}' WHERE id = 'ACM-2'",
        )
        .run();
      expect(store.tasks.get("ACM-1")?.typing).toBeUndefined();
      expect(store.tasks.get("ACM-2")?.typing).toBeUndefined();
      expect(store.tasks.get("ACM-2")?.origin).toBeUndefined();
      expect(store.tasks.list(true)).toHaveLength(2);
      sql.prepare("UPDATE tasks SET type = 'bug', type_by = 'owner' WHERE id = 'ACM-1'").run();
      expect(store.tasks.get("ACM-1")?.typing).toEqual({ type: "bug", by: "owner" });
    } finally {
      store.close();
    }
  });
});
