import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { Store } from "./index.ts";
import { MIGRATIONS, type Migration, migrate } from "./migrations.ts";

describe("migrations", () => {
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
