import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { MIGRATIONS, migrate } from "./migrations.ts";

/** Migration 124: old rows paused by Autonomous turning off get their `paused_by`. */
describe("the paused by autonomy off migration", () => {
  it("marks only the captain's or Autonomous's owner-paused tasks paused next to a turn-off event", () => {
    const db = new Database(":memory:");
    migrate(
      db,
      MIGRATIONS.filter((m) => m.id < 124),
    );
    const cols = db.prepare("PRAGMA table_info(tasks)").all() as { name: string; notnull: number }[];
    const required = cols.filter((c) => c.notnull === 1).map((c) => c.name);
    const task = (id: string, status: string, reason: string | null, by: string | null, updated: string) => {
      const values: Record<string, unknown> = {
        id,
        title: id,
        status,
        paused_reason: reason,
        paused_by: by,
        updated_at: updated,
        created_at: updated,
      };
      for (const name of required) values[name] ??= name === "team" || name === "repos" ? "[]" : "";
      const names = Object.keys(values);
      db.prepare(
        `INSERT INTO tasks (${names.join(", ")}) VALUES (${names.map((n) => `@${n}`).join(", ")})`,
      ).run(values);
    };
    const at = "2026-10-04T19:20:00.000Z";
    // Paused a few seconds before or after the "Turned off" event: Autonomous did it.
    task("ACM-1", "paused", "owner", null, "2026-10-04T19:19:58.000Z");
    task("ACM-2", "paused", "owner", null, "2026-10-04T19:20:01.000Z");
    // Paused by hand an hour earlier, though it is an autonomous task: stays the owner's.
    task("ACM-3", "paused", "owner", null, "2026-10-04T18:20:00.000Z");
    // Not an autonomous task: stays the owner's.
    task("ACM-4", "paused", "owner", null, at);
    // Already says who.
    task("ACM-5", "paused", "owner", "captain", at);
    // Another reason, or running again: untouched.
    task("ACM-6", "paused", "limit", null, at);
    task("ACM-7", "running", null, null, at);
    const auto = db.prepare("INSERT INTO autonomy_tasks (task, since) VALUES (?, ?)");
    for (const id of ["ACM-1", "ACM-2", "ACM-3", "ACM-5", "ACM-6", "ACM-7"]) auto.run(id, at);
    const event = db.prepare("INSERT INTO autonomy_events (at, kind, text) VALUES (?, ?, ?)");
    event.run(at, "mode", "Turned off");
    // An unrelated mode event next to ACM-3's pause does not count.
    event.run("2026-10-04T18:19:00.000Z", "mode", "Turned on");

    expect(migrate(db)).toContain(124);
    const by = db.prepare("SELECT id, paused_by FROM tasks ORDER BY id").all();
    expect(by).toEqual([
      { id: "ACM-1", paused_by: "autonomy-off" },
      { id: "ACM-2", paused_by: "autonomy-off" },
      { id: "ACM-3", paused_by: null },
      { id: "ACM-4", paused_by: null },
      { id: "ACM-5", paused_by: "captain" },
      { id: "ACM-6", paused_by: null },
      { id: "ACM-7", paused_by: null },
    ]);
  });
});
