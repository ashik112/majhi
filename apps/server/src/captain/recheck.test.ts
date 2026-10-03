import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { MIGRATIONS, migrate } from "../store/migrations.ts";

/**
 * The one-time recheck: a memory the old curator handed to the owner is looked at once more by the
 * memory chore, and one handed over after the memory fix is left alone.
 */
function insert(db: Database.Database, key: string, chore: string, outcome: string, at: string): void {
  db.prepare(
    "INSERT INTO captain_actions (key, org, chore, day, at, text, reason, outcome) VALUES (?, 'private', ?, '2026-10-03', ?, 'x', 'y', ?)",
  ).run(key, chore, at, outcome);
}

describe("recheck of memories handed to the owner", () => {
  it("frees only the memories the old rule handed over, once, and keeps their log lines", () => {
    const db = new Database(":memory:");
    migrate(
      db,
      MIGRATIONS.filter((m) => m.id < 124),
    );
    insert(db, "memory:7", "memory", "asked", "2026-10-02T10:00:00.000Z");
    insert(db, "memory:8", "memory", "done", "2026-10-02T10:00:00.000Z");
    insert(db, "memory:9", "memory", "asked", "2026-10-04T10:00:00.000Z");
    insert(db, "ship:ready:ACM-1:abc", "ship", "asked", "2026-10-02T10:00:00.000Z");
    expect(
      migrate(
        db,
        MIGRATIONS.filter((m) => m.id <= 124),
      ),
    ).toEqual([124]);
    const keys = (db.prepare("SELECT key FROM captain_actions ORDER BY id").all() as { key: string }[]).map(
      (r) => r.key,
    );
    expect(keys).toEqual(["memory:7:handed-before-recheck", "memory:8", "memory:9", "ship:ready:ACM-1:abc"]);
    // It does not run twice: a memory handed over again by the new rule keeps its key.
    insert(db, "memory:7", "memory", "asked", "2026-10-05T10:00:00.000Z");
    expect(migrate(db, MIGRATIONS)).toEqual([]);
    expect(db.prepare("SELECT count(*) AS n FROM captain_actions WHERE key = 'memory:7'").get()).toEqual({
      n: 1,
    });
  });
});
