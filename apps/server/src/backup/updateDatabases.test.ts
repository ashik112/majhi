import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { restoreUpdateDatabases, snapshotUpdateDatabases } from "./updateDatabases.ts";

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
});
