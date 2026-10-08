import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { restoreUpdateDatabases, snapshotUpdateDatabases, UPDATE_DATABASE_DIR } from "./updateDatabases.ts";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "majhi-update-db-"));
});
afterEach(() => rm(home, { recursive: true, force: true }));

function database(rel: string): Database.Database {
  const db = new Database(join(home, rel));
  db.pragma("journal_mode = WAL");
  db.exec("CREATE TABLE original (value TEXT); INSERT INTO original VALUES ('keep')");
  return db;
}

describe("update database rollback", () => {
  it("restores both databases after destructive migrations, including WAL writes", async () => {
    await mkdir(join(home, "memory"));
    for (const rel of ["majhi.db", "memory/memory.db"]) {
      const db = database(rel);
      db.close();
    }
    await snapshotUpdateDatabases(home);
    for (const rel of ["majhi.db", "memory/memory.db"]) {
      const db = new Database(join(home, rel));
      db.exec("DROP TABLE original; CREATE TABLE replacement (value TEXT)");
      db.close();
    }
    await writeFile(join(home, "majhi.yaml"), "keep settings");
    await restoreUpdateDatabases(home);
    // Recovery is safe to retry if the helper dies before clearing its update journal.
    await restoreUpdateDatabases(home);
    for (const rel of ["majhi.db", "memory/memory.db"]) {
      const db = new Database(join(home, rel));
      expect(db.prepare("SELECT value FROM original").pluck().get()).toBe("keep");
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name='replacement'").get()).toBeUndefined();
      db.close();
    }
    expect(await readFile(join(home, "majhi.yaml"), "utf8")).toBe("keep settings");
  });

  it("removes databases that did not exist before the update", async () => {
    const db = database("majhi.db");
    db.close();
    await snapshotUpdateDatabases(home);
    await mkdir(join(home, "memory"));
    const added = database("memory/memory.db");
    added.close();
    await restoreUpdateDatabases(home);
    expect(existsSync(join(home, "memory/memory.db"))).toBe(false);
  });

  it("refuses a damaged snapshot before changing either live database", async () => {
    const db = database("majhi.db");
    db.close();
    await snapshotUpdateDatabases(home);
    await writeFile(join(home, UPDATE_DATABASE_DIR, "majhi.db"), "damaged");
    await expect(restoreUpdateDatabases(home)).rejects.toThrow();
    const live = new Database(join(home, "majhi.db"));
    expect(live.prepare("SELECT value FROM original").pluck().get()).toBe("keep");
    live.close();
  });

  it("does not overwrite a snapshot still needed for recovery", async () => {
    const db = database("majhi.db");
    db.close();
    await snapshotUpdateDatabases(home);
    await expect(snapshotUpdateDatabases(home)).rejects.toThrow("recovery is still pending");
  });
});
