import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { MIGRATIONS, migrate } from "./migrations.ts";

/** Migration 154: findings of removed sources are dismissed once, and the tracker comment channel is gone. */
describe("the removed sources migration", () => {
  it("dismisses only open findings of removed sources and deletes the tracker comment channel rows", () => {
    const db = new Database(":memory:");
    migrate(
      db,
      MIGRATIONS.filter((m) => m.id < 154),
    );
    const at = "2026-10-04T10:00:00.000Z";
    const finding = (id: number, source: string, status: string) =>
      db
        .prepare(
          `INSERT INTO findings (id, org, source, title, detail, evidence, severity, dedupe_key, status, by, seen, created_at, updated_at, last_seen)
           VALUES (?, 'acme', ?, 't', '', '[]', 'low', ?, ?, 'captain', 1, ?, ?, ?)`,
        )
        .run(id, source, `k${id}`, status, at, at, at);
    finding(1, "radar", "open");
    finding(2, "ci", "open");
    finding(3, "dependency", "open");
    finding(4, "radar", "task");
    finding(5, "security", "open");
    finding(6, "setup", "open");
    db.prepare(
      "INSERT INTO outbound_channels (org, channel) VALUES ('acme', 'tracker-comment'), ('acme', 'email')",
    ).run();
    db.prepare(
      "INSERT INTO trust_state (org, key) VALUES ('acme', 'outbound:tracker-comment'), ('acme', 'outbound:email')",
    ).run();

    expect(migrate(db)).toContain(154);
    expect(db.prepare("SELECT id, status FROM findings ORDER BY id").all()).toEqual([
      { id: 1, status: "dismissed" },
      { id: 2, status: "dismissed" },
      { id: 3, status: "dismissed" },
      { id: 4, status: "task" },
      { id: 5, status: "open" },
      { id: 6, status: "open" },
    ]);
    expect(db.prepare("SELECT channel FROM outbound_channels").all()).toEqual([{ channel: "email" }]);
    expect(db.prepare("SELECT key FROM trust_state").all()).toEqual([{ key: "outbound:email" }]);
  });
});
