import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "@majhi/shared";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DB_FILE_NAME, Store } from "../store/index.ts";
import { BACKUP_DIR, BackupService, checkSnapshot, DAY_MS, KEEP, PENDING_SUFFIX } from "./service.ts";

function task(id: string): Task {
  return {
    id,
    title: `Title ${id}`,
    brief: "brief",
    kind: "code",
    org: "acme",
    status: "inbox",
    folder: `/tasks/${id}`,
    repos: [],
    team: [],
    mode: "lead",
    overrides: {},
    links: [],
    attachments: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  } as Task;
}

let home: string;
let store: Store;
let now: Date;
let backup: BackupService;

function open(): void {
  store = Store.open(home);
  backup = new BackupService({
    majhiHome: home,
    sqlite: () => store.raw,
    dbFile: DB_FILE_NAME,
    clock: () => now,
  });
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "majhi-backup-"));
  now = new Date("2026-10-01T03:00:00.000Z");
  open();
});

afterEach(async () => {
  store.close();
  await rm(home, { recursive: true, force: true });
});

describe("daily snapshot", () => {
  it("copies the database while it is open, and takes one a day", async () => {
    store.tasks.insert(task("ACME-1"));
    const name = await backup.ensureDaily();
    expect(name).toBe("daily-20261001T030000Z.db");
    expect(await backup.ensureDaily()).toBeUndefined();
    now = new Date(now.getTime() + DAY_MS - 1);
    expect(await backup.ensureDaily()).toBeUndefined();
    now = new Date(now.getTime() + 1);
    expect(await backup.ensureDaily()).toBe("daily-20261002T030000Z.db");

    const copy = new Database(join(home, BACKUP_DIR, name ?? ""), { readonly: true });
    expect(copy.prepare("SELECT id FROM tasks").all()).toEqual([{ id: "ACME-1" }]);
    copy.close();
  });

  it("keeps the newest 7 of each kind and no half-written files", async () => {
    for (let day = 0; day < KEEP + 3; day++) {
      await backup.ensureDaily();
      now = new Date(now.getTime() + DAY_MS);
    }
    await backup.now();
    const { backups } = await backup.list();
    const daily = backups.filter((b) => b.kind === "daily");
    expect(daily).toHaveLength(KEEP);
    expect(daily[0]?.name).toBe("daily-20261010T030000Z.db");
    expect(backups.filter((b) => b.kind === "manual")).toHaveLength(1);
    expect((await readdir(join(home, BACKUP_DIR))).filter((n) => n.endsWith(".part"))).toEqual([]);
  });

  it("does not overwrite a snapshot taken in the same second", async () => {
    const a = await backup.now();
    const b = await backup.now();
    expect(a).not.toBe(b);
    expect((await backup.list()).backups).toHaveLength(2);
  });
});

describe("restore", () => {
  it("stages a checked snapshot, snapshots the current database, and swaps at the next open", async () => {
    store.tasks.insert(task("ACME-1"));
    const name = await backup.now();
    store.tasks.insert(task("ACME-2"));

    const done = await backup.restore(name);
    expect(done.restored).toBe(name);
    expect(done.safety).toMatch(/^before-restore-/);
    // The running database is untouched until majhi restarts.
    expect(store.tasks.get("ACME-2")).toBeDefined();
    expect((await backup.list()).pending).toBeDefined();

    store.close();
    open();
    expect(store.tasks.get("ACME-1")).toBeDefined();
    expect(store.tasks.get("ACME-2")).toBeUndefined();
    expect((await backup.list()).pending).toBeUndefined();
    expect((await readdir(home)).some((n) => n.endsWith(PENDING_SUFFIX))).toBe(false);

    // What the restore replaced can be restored in turn.
    await backup.restore(done.safety);
    store.close();
    open();
    expect(store.tasks.get("ACME-2")).toBeDefined();
  });

  it("can drop a staged restore", async () => {
    store.tasks.insert(task("ACME-1"));
    const name = await backup.now();
    store.tasks.insert(task("ACME-2"));
    await backup.restore(name);
    await backup.cancelRestore();
    store.close();
    open();
    expect(store.tasks.get("ACME-2")).toBeDefined();
  });

  it("refuses an unknown name, a path, and a file that is not a majhi database", async () => {
    await expect(backup.restore("daily-20200101T000000Z.db")).rejects.toThrow(/no backup/);
    await expect(backup.restore("../majhi.db")).rejects.toThrow(/no backup/);
    const junk = join(home, "junk.db");
    await writeFile(junk, "not a database");
    await expect(checkSnapshot(junk)).rejects.toThrow(/cannot be read|damaged/);
    const empty = new Database(join(home, "empty.db"));
    empty.exec("CREATE TABLE migrations (id INTEGER PRIMARY KEY, name TEXT, applied_at TEXT)");
    empty.close();
    await expect(checkSnapshot(join(home, "empty.db"))).rejects.toThrow(/no majhi database/);
  });

  it("refuses a snapshot from a newer majhi", async () => {
    const name = await backup.now();
    const file = join(home, BACKUP_DIR, name);
    const db = new Database(file);
    db.prepare("INSERT INTO migrations (id, name, applied_at) VALUES (99999, 'future', 'now')").run();
    db.close();
    await expect(backup.restore(name)).rejects.toThrow(/newer majhi/);
    expect((await backup.list()).pending).toBeUndefined();
  });
});
