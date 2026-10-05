import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { applyBaseline, MIN_SQLITE_VERSION, versionAtLeast } from "./db.ts";
import { MIGRATIONS, migrate } from "./migrations.ts";

function task(db: Database.Database, id: string, status = "inbox"): void {
  db.prepare(
    "INSERT INTO tasks (id, title, brief, kind, status, folder, team, created_at, updated_at) VALUES (?, 't', 'b', 'code', ?, '/t', '[]', 'x', 'x')",
  ).run(id, status);
}

/** Migration 153: what waits for the owner is an indexed column, and a damaged payload cannot break it. */
describe("the hot lookup indexes migration", () => {
  it("reads pending from the payload on rows made before it, and a payload that is not JSON as not pending", () => {
    const db = new Database(":memory:");
    migrate(
      db,
      MIGRATIONS.filter((m) => m.id < 153),
    );
    task(db, "ACME-1");
    const put = db.prepare(
      "INSERT INTO room_items (task, id, seq, type, payload, at) VALUES ('ACME-1', ?, ?, ?, ?, 'x')",
    );
    put.run("a1", 1, "approval", JSON.stringify({ state: "pending", command: "ls" }));
    put.run("a2", 2, "approval", JSON.stringify({ state: "approved", command: "ls" }));
    put.run("a3", 3, "approval", "not json at all");
    put.run("a4", 4, "approval", "");
    expect(migrate(db)).toContain(153);
    const pending = db.prepare("SELECT id FROM room_items WHERE type = 'approval' AND pending = 1").all();
    expect(pending).toEqual([{ id: "a1" }]);
    // New writes and state changes are followed with no write to the column.
    put.run("a5", 5, "approval", JSON.stringify({ state: "pending" }));
    db.prepare("UPDATE room_items SET payload = ? WHERE id = 'a1'").run(
      JSON.stringify({ state: "approved" }),
    );
    expect(
      db
        .prepare("SELECT id FROM room_items WHERE type = 'approval' AND pending = 1 ORDER BY id")
        .all()
        .map((r) => (r as { id: string }).id),
    ).toEqual(["a5"]);
  });

});

describe("the SQLite baseline", () => {
  it("sets and reads back WAL, synchronous NORMAL, a busy timeout and foreign keys on a file database", () => {
    const dir = mkdtempSync(join(tmpdir(), "majhi-baseline-"));
    const db = new Database(join(dir, "t.db"));
    try {
      const b = applyBaseline(db);
      expect(b.journalMode).toBe("wal");
      expect(b.synchronous).toBe(1);
      expect(b.busyTimeoutMs).toBeGreaterThanOrEqual(5000);
      expect(b.foreignKeys).toBe(true);
      // The WAL-reset race is fixed from 3.51.3; the bundled SQLite must not be older.
      expect(b.versionOk).toBe(true);
      expect(versionAtLeast(b.version, MIN_SQLITE_VERSION)).toBe(true);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

});
