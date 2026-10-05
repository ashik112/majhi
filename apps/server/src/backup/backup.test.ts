import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "@majhi/shared";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigHistory } from "../config/history.ts";
import type { ServerEnv } from "../env.ts";
import { openMemoryDb } from "../memory/db.ts";
import { generateKey, SecretStore } from "../secrets/store.ts";
import { Store } from "../store/index.ts";
import { MIGRATIONS, migrate } from "../store/migrations.ts";
import { type DbSource, unpackArchive } from "./archive.ts";
import { prepareStart } from "./boot.ts";
import { Locked } from "./crypto.ts";
import { walk } from "./manifest.ts";
import { BackupService } from "./service.ts";
import { applyPendingRestore, readPending } from "./swap.ts";

const SECRET_VALUE = "sk-ant-SUPER-SECRET-VALUE-0123456789";

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
let outside: string;
let store: Store;
let memory: Database.Database;
let history: ConfigHistory;
let secrets: SecretStore;
let identity: string;
let now: Date;
let restarts: number;
let failWrite: ((written: number) => void) | undefined;
let backup: BackupService;

function sources(): DbSource[] {
  return [
    { rel: "majhi.db", backup: async (dest) => void (await store.raw.backup(dest)) },
    { rel: "memory/memory.db", backup: async (dest) => void (await memory.backup(dest)) },
  ];
}

function makeService(
  over: {
    key?: () => Promise<string | undefined>;
    databases?: () => DbSource[];
    dir?: string;
    freeBytes?: (dir: string) => Promise<number>;
  } = {},
): BackupService {
  return new BackupService({
    majhiHome: home,
    databases: over.databases ?? sources,
    history,
    key: over.key ?? (async () => identity),
    version: { version: "1.2.3", commit: "abc1234" },
    clock: () => now,
    restart: () => {
      restarts++;
    },
    destinationEnv: { container: false },
    passphraseLogN: 10,
    beforeWrite: (written) => failWrite?.(written),
    freeBytes: over.freeBytes ?? (async () => 100 * 1024 ** 3),
  });
}

async function archives(dir = join(home, "backups")): Promise<string[]> {
  return (await readdir(dir).catch(() => [] as string[])).filter((n) => n.startsWith("majhi-")).sort();
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "majhi-backup-"));
  outside = mkdtempSync(join(tmpdir(), "majhi-synced-"));
  now = new Date("2026-10-01T03:00:00.000Z");
  restarts = 0;
  failWrite = undefined;
  store = Store.open(home);
  memory = openMemoryDb(join(home, "memory", "memory.db"));
  history = new ConfigHistory(home);
  await history.ensureRepo();
  await writeFile(join(home, "majhi.yaml"), "workspaces: {}\n");
  await mkdir(join(home, "agents"), { recursive: true });
  await writeFile(join(home, "agents", "builder.md"), "# builder\n");
  await mkdir(join(home, "skills", "review"), { recursive: true });
  await writeFile(join(home, "skills", "review", "SKILL.md"), "# review\n");
  await history.commit({
    files: ["majhi.yaml", "agents/builder.md", "skills/review/SKILL.md", ".gitignore"],
    message: "init: sample config",
    actor: { kind: "owner" },
  });
  // Credentials that must never enter an archive.
  await mkdir(join(home, "accounts", "claude-acme"), { recursive: true });
  await writeFile(join(home, "accounts", "claude-acme", "credentials.json"), '{"token":"ACCOUNT-TOKEN-XYZ"}');
  await mkdir(join(home, "connections"), { recursive: true });
  await writeFile(join(home, "connections", "x.json"), '{"token":"CONNECTION-TOKEN-XYZ"}');
  identity = await generateKey();
  await mkdir(join(home, "keys"), { recursive: true });
  await writeFile(join(home, "keys", "secrets.key"), `${identity}\n`);
  secrets = new SecretStore(home, join(home, "keys", "secrets.key"));
  await secrets.set("ANTHROPIC_API_KEY", SECRET_VALUE);
  store.tasks.insert(task("ACME-1"));
  backup = makeService();
});

afterEach(async () => {
  store.close();
  memory.close();
  await rm(home, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe("a backup", () => {
  it("holds the databases, config files, history and the sealed secrets, and passes its own check", async () => {
    // Big folders the config repo does not ignore: rebuilt or downloaded again, never archived.
    await mkdir(join(home, "laya"), { recursive: true });
    await writeFile(join(home, "laya", "model.gguf"), "weights");
    await mkdir(join(home, "e2e", "worktree"), { recursive: true });
    await writeFile(join(home, "e2e", "worktree", "package.json"), "{}");
    await writeFile(join(home, "update.json"), "{}");
    const name = await backup.now();
    expect(name).toMatch(/^majhi-manual-20261001T030000Z\.age$/);
    const list = await backup.list();
    expect(list.backups).toHaveLength(1);
    expect(list.backups[0]).toMatchObject({ lock: "key", kind: "manual", legacy: false });
    expect(list.destination).toMatchObject({ custom: false });

    const out = join(home, "run", "peek");
    const manifest = await unpackArchive(join(home, "backups", name), { kind: "key", identity }, out);
    expect(manifest.migrations.majhi).toBeGreaterThan(0);
    expect(manifest.migrations.memory).toBeGreaterThan(0);
    expect(manifest.config.bundle).toBe(true);
    expect(manifest.majhi).toEqual({ version: "1.2.3", commit: "abc1234" });
    const { files } = await walk(out);
    expect(files).toEqual(
      expect.arrayContaining([
        "data/majhi.db",
        "data/memory/memory.db",
        "data/secrets.age",
        "data/majhi.yaml",
        "data/agents/builder.md",
        "data/skills/review/SKILL.md",
        "meta/config.bundle",
        "manifest.json",
      ]),
    );
    // Not in an archive: logins, connection credentials, the key, the backups themselves.
    expect(
      files.some(
        (f) =>
          f.includes("accounts") ||
          f.includes("connections") ||
          f.includes("secrets.key") ||
          f.includes("backups") ||
          f.includes("laya") ||
          f.includes("e2e") ||
          f.includes("update.json"),
      ),
    ).toBe(false);
  });

  it("never holds a secret or the key in plain text, in the archive or around it", async () => {
    const name = await backup.now();
    const raw = await readFile(join(home, "backups", name));
    expect(raw.includes(SECRET_VALUE)).toBe(false);
    expect(raw.includes("AGE-SECRET-KEY-1")).toBe(false);
    expect(raw.includes("ACCOUNT-TOKEN-XYZ")).toBe(false);

    const out = join(home, "run", "peek");
    await unpackArchive(join(home, "backups", name), { kind: "key", identity }, out);
    const { files } = await walk(out);
    for (const f of files) {
      const bytes = await readFile(join(out, f));
      expect(bytes.includes(SECRET_VALUE), f).toBe(false);
      expect(bytes.includes("AGE-SECRET-KEY-1"), f).toBe(false);
      expect(bytes.includes("ACCOUNT-TOKEN-XYZ"), f).toBe(false);
      expect(bytes.includes("CONNECTION-TOKEN-XYZ"), f).toBe(false);
    }
    // Nothing is left in the scratch space either.
    expect(await readdir(join(home, "run", "backup-work")).catch(() => [])).toEqual([]);
  });

  it("is consistent while writes go on", async () => {
    const db = store.raw;
    db.exec("CREATE TABLE inv_a (n INTEGER); CREATE TABLE inv_b (n INTEGER);");
    let stop = false;
    let n = 0;
    // A writer that keeps two tables in step, one transaction at a time, between the backup's own steps.
    const writer = (async () => {
      while (!stop) {
        db.transaction(() => {
          n++;
          db.prepare("INSERT INTO inv_a VALUES (?)").run(n);
          db.prepare("INSERT INTO inv_b VALUES (?)").run(n);
        })();
        await new Promise((r) => setImmediate(r));
      }
    })();
    // Enough rows that the copy takes many steps.
    db.transaction(() => {
      const ins = db.prepare("INSERT INTO inv_a VALUES (?)");
      const ins2 = db.prepare("INSERT INTO inv_b VALUES (?)");
      for (let i = 0; i < 60_000; i++) {
        ins.run(-i);
        ins2.run(-i);
      }
    })();
    const name = await backup.now();
    stop = true;
    await writer;
    expect(n).toBeGreaterThan(0);

    const out = join(home, "run", "peek");
    await unpackArchive(join(home, "backups", name), { kind: "key", identity }, out);
    const copy = new Database(join(out, "data", "majhi.db"), { readonly: true });
    expect(copy.pragma("integrity_check", { simple: true })).toBe("ok");
    const a = copy.prepare("SELECT COUNT(*) AS c, SUM(n) AS s FROM inv_a").get();
    const b = copy.prepare("SELECT COUNT(*) AS c, SUM(n) AS s FROM inv_b").get();
    expect(a).toEqual(b);
    copy.close();
  });

  it("leaves no file that looks like a backup when the disk fills mid-write, and keeps the earlier ones", async () => {
    const good = await backup.now();
    now = new Date(now.getTime() + 60_000);
    failWrite = (written) => {
      if (written > 0) throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    };
    await expect(backup.now()).rejects.toThrow();
    expect(readdirSync(join(home, "backups")).sort()).toEqual([good]);
    const list = await backup.list();
    expect(list.backups.map((b) => b.name)).toEqual([good]);
    expect(list.lastError).toBeDefined();
    // The next good backup clears the error.
    failWrite = undefined;
    await backup.now();
    expect((await backup.list()).lastError).toBeUndefined();
  });

  it("refuses to start when it would leave less than the reserve free, and keeps the earlier backups", async () => {
    const first = await backup.now();
    const tight = makeService({ freeBytes: async () => 1024 ** 3 });
    await expect(tight.now()).rejects.toThrow();
    const names = (await tight.list()).backups.map((b) => b.name);
    expect(names).toEqual([first]);
    expect((await readdir(join(home, "backups"))).some((n) => n.endsWith(".part"))).toBe(false);
  });

  it("can be locked with a passphrase that majhi never keeps", async () => {
    const name = await backup.now("correct horse battery staple");
    expect((await backup.list()).backups[0]?.lock).toBe("passphrase");
    expect((await readFile(join(home, "backups", name))).includes("correct horse")).toBe(false);
    await expect(backup.verify(name)).rejects.toThrow();
    await expect(backup.verify(name, "wrong passphrase")).rejects.toBeInstanceOf(Locked);
    const { result } = await backup.verify(name, "correct horse battery staple");
    expect(result.ok).toBe(true);
    // A locked backup is not damaged: it is never recorded as a failed check.
    expect((await backup.list()).backups[0]?.verified?.ok).toBe(true);
  });
});

describe("verify", () => {
  it("restores into a temporary folder, checks it, and touches nothing live", async () => {
    const name = await backup.now();
    const before = readFileSync(join(home, "majhi.db"));
    const { result } = await backup.verify(name);
    expect(result.ok).toBe(true);
    expect(readFileSync(join(home, "majhi.db")).length).toBeGreaterThan(0);
    expect(before.length).toBeGreaterThan(0);
    expect(
      await readdir(join(home, "run")).then((n) => n.filter((x) => x.startsWith("backup-check"))),
    ).toEqual([]);
    expect((await backup.list()).lastVerify).toMatchObject({ name, ok: true });
  });

  it("reports a cut-off archive and a flipped bit as damaged, not as a crash", async () => {
    const name = await backup.now();
    const file = join(home, "backups", name);
    const bytes = readFileSync(file);

    writeFileSync(file, bytes.subarray(0, Math.floor(bytes.length / 2)));
    let { result } = await backup.verify(name);
    expect(result.ok).toBe(false);

    const flipped = Buffer.from(bytes);
    flipped[Math.floor(flipped.length * 0.7)] = (flipped[Math.floor(flipped.length * 0.7)] ?? 0) ^ 0x01;
    writeFileSync(file, flipped);
    ({ result } = await backup.verify(name));
    expect(result.ok).toBe(false);

    writeFileSync(file, "not an age file at all");
    ({ result } = await backup.verify(name));
    expect(result.ok).toBe(false);
    expect((await backup.list()).lastVerify?.ok).toBe(false);
  });

  it("says the key is wrong instead of calling the backup damaged", async () => {
    const name = await backup.now();
    const other = makeService({ key: async () => generateKey() });
    await expect(other.verify(name)).rejects.toBeInstanceOf(Locked);
    await expect(other.restore(name)).rejects.toBeInstanceOf(Locked);
    expect(readPending(home)).toBeUndefined();
    expect(restarts).toBe(0);
    expect((await other.list()).backups[0]?.verified).toBeUndefined();
  });

  it("refuses a backup from a newer migration, in verify and in restore", async () => {
    const future: DbSource[] = [
      {
        rel: "majhi.db",
        backup: async (dest) => {
          await store.raw.backup(dest);
          const copy = new Database(dest);
          copy
            .prepare("INSERT INTO migrations (id, name, applied_at) VALUES (99999, 'from the future', 'x')")
            .run();
          copy.close();
        },
      },
    ];
    const newer = makeService({ databases: () => future });
    const name = await newer.now();
    const { result } = await backup.verify(name);
    expect(result.ok).toBe(false);
    await expect(backup.restore(name)).rejects.toThrow();
    expect(readPending(home)).toBeUndefined();
    expect(restarts).toBe(0);
    // A refused backup is not damaged, so it still counts as a copy.
    expect((await backup.list()).backups.find((b) => b.name === name)?.verified?.ok).toBe(false);
  });

  it("refuses a database that fails SQLite's own integrity check", async () => {
    const broken: DbSource[] = [
      {
        rel: "majhi.db",
        backup: async (dest) => {
          await store.raw.backup(dest);
          // Overwrite part of the file after the first page: the copy opens but is not whole.
          const bytes = readFileSync(dest);
          for (let i = 4096 * 2; i < Math.min(bytes.length, 4096 * 6); i++) bytes[i] = 0xab;
          writeFileSync(dest, bytes);
        },
      },
    ];
    // The check at backup time already refuses to store a copy that does not pass.
    await expect(makeService({ databases: () => broken }).now()).rejects.toThrow();
    expect(await archives()).toEqual([]);
  });
});

describe("restore", () => {
  it("swaps the verified data in at the next start, keeps what it replaced, and restarts", async () => {
    const name = await backup.now();
    // Changes after the backup: they are what the restore undoes.
    store.tasks.insert(task("ACME-2"));
    await writeFile(join(home, "majhi.yaml"), "workspaces: { changed: true }\n");
    await secrets.set("LATER_KEY", "added-after-the-backup");
    now = new Date(now.getTime() + 60_000);

    const result = await backup.restore(name);
    expect(result).toMatchObject({ restored: name, restarting: true });
    expect(result.safety).toBeDefined();
    expect(restarts).toBe(1);
    // Nothing live changed yet, and a restore is waiting.
    expect(store.tasks.get("ACME-2")).toBeDefined();
    expect((await backup.list()).pending).toBeDefined();
    await expect(backup.restore(name)).rejects.toThrow();

    // The next start: close everything, swap, reopen.
    store.close();
    memory.close();
    expect(applyPendingRestore(home)).toBe(true);
    store = Store.open(home);
    memory = openMemoryDb(join(home, "memory", "memory.db"));

    expect(store.tasks.get("ACME-1")).toBeDefined();
    expect(store.tasks.get("ACME-2")).toBeUndefined();
    expect(readFileSync(join(home, "majhi.yaml"), "utf8")).toBe("workspaces: {}\n");
    expect(await secrets.get("LATER_KEY")).toBeUndefined();
    expect(await secrets.get("ANTHROPIC_API_KEY")).toBe(SECRET_VALUE);
    expect(store.raw.pragma("integrity_check", { simple: true })).toBe("ok");
    // The config history is the restored one and has no remote to push to.
    expect((await history.head())?.length).toBe(40);
    // What it replaced is kept.
    const rollback = readdirSync(join(home, "rollback"));
    expect(rollback).toHaveLength(1);
    const old = new Database(join(home, "rollback", rollback[0] ?? "", "majhi.db"), { readonly: true });
    expect(old.prepare("SELECT id FROM tasks WHERE id = 'ACME-2'").get()).toBeDefined();
    old.close();
    expect((await backup.list()).restored).toMatchObject({ ok: true });
  });

  it("changes nothing when the backup is damaged", async () => {
    const name = await backup.now();
    const file = join(home, "backups", name);
    const bytes = readFileSync(file);
    writeFileSync(file, bytes.subarray(0, bytes.length - 40));
    const before = readFileSync(join(home, "majhi.yaml"), "utf8");
    await expect(backup.restore(name)).rejects.toThrow();
    expect(readPending(home)).toBeUndefined();
    expect(restarts).toBe(0);
    expect(readFileSync(join(home, "majhi.yaml"), "utf8")).toBe(before);
    expect(await readdir(join(home, "restore-staging")).catch(() => [])).toEqual([]);
    // It did not even take the safety backup.
    expect((await backup.list()).backups.filter((b) => b.kind === "before-restore")).toEqual([]);
  });

  it("keeps the current secrets file when the backup's one cannot be opened with the current key", async () => {
    const good = readFileSync(join(home, "secrets.age"));
    // The archive holds a secrets file sealed under some other, earlier key.
    await writeFile(join(home, "secrets.age"), "sealed under an earlier key");
    const name = await backup.now();
    await writeFile(join(home, "secrets.age"), good);

    await backup.restore(name);
    store.close();
    memory.close();
    expect(applyPendingRestore(home)).toBe(true);
    store = Store.open(home);
    memory = openMemoryDb(join(home, "memory", "memory.db"));
    // The owner is not locked out of their API keys.
    expect(await secrets.get("ANTHROPIC_API_KEY")).toBe(SECRET_VALUE);
  });

  it("backs up before a database that is behind gets migrated, and not otherwise", async () => {
    const old = mkdtempSync(join(tmpdir(), "majhi-premigrate-"));
    try {
      await writeFile(join(old, "key"), `${identity}\n`);
      const file = join(old, "majhi.db");
      const db = new Database(file);
      migrate(db, MIGRATIONS.slice(0, 5));
      db.close();
      const env = {
        majhiHome: old,
        secretsKeyFile: join(old, "key"),
        version: "1",
        commit: "c",
      } as ServerEnv;
      await prepareStart(env);
      const made = (await readdir(join(old, "backups"))).filter((n) => n.includes("before-migration"));
      expect(made).toHaveLength(1);
      const out = join(old, "peek");
      const manifest = await unpackArchive(
        join(old, "backups", made[0] ?? ""),
        { kind: "key", identity },
        out,
      );
      expect(manifest.migrations.majhi).toBe(MIGRATIONS[4]?.id);
      // Once the database is current there is nothing to protect.
      const current = new Database(file);
      migrate(current);
      current.close();
      await rm(join(old, "backups"), { recursive: true });
      await prepareStart(env);
      expect(await readdir(old)).not.toContain("backups");
    } finally {
      await rm(old, { recursive: true, force: true });
    }
  });

  it("refuses a name that is not a backup", async () => {
    await expect(backup.restore("../../etc/passwd")).rejects.toThrow();
    await expect(backup.restore("majhi-daily-20260101T000000Z.age")).rejects.toThrow();
  });
});
