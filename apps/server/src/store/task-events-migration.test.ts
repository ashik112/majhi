import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "./migrations.ts";

/** Migration 156: the lifecycle's audit trail and outbox. */
describe("the task events migration", () => {
  it("removes a task's events with the task", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db);
    const at = "2026-10-05T10:00:00.000Z";
    db.prepare(
      "INSERT INTO tasks (id, title, brief, kind, status, folder, team, created_at, updated_at) VALUES ('ACM-1', 't', 'b', 'code', 'inbox', '/t', '[]', ?, ?)",
    ).run(at, at);
    db.prepare("INSERT INTO task_events (task, at, event, actor) VALUES ('ACM-1', ?, 'start', 'owner')").run(
      at,
    );
    db.prepare("DELETE FROM tasks WHERE id = 'ACM-1'").run();
    expect(db.prepare("SELECT count(*) AS n FROM task_events").get()).toEqual({ n: 0 });
  });
});
