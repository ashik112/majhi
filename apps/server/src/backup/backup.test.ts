import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
});

describe("restore", () => {
  /** A restore that is refused: nothing pending, no restart, the live config as it was, no safety backup taken. */
  const refusedAndUntouched = async (service: BackupService, name: string) => {
    const before = readFileSync(join(home, "majhi.yaml"), "utf8");
    await expect(service.restore(name)).rejects.toThrow();
    expect(readPending(home)).toBeUndefined();
    expect(restarts).toBe(0);
    expect(readFileSync(join(home, "majhi.yaml"), "utf8")).toBe(before);
    expect(await readdir(join(home, "restore-staging")).catch(() => [])).toEqual([]);
    expect((await backup.list()).backups.filter((b) => b.kind === "before-restore")).toEqual([]);
  };

  it.each<[string, () => Promise<void>]>([
    [
      "a cut-off archive",
      async () => {
        const name = await backup.now();
        const file = join(home, "backups", name);
        const bytes = readFileSync(file);
        writeFileSync(file, bytes.subarray(0, bytes.length - 40));
        await refusedAndUntouched(backup, name);
      },
    ],
    [
      "a flipped bit",
      async () => {
        const name = await backup.now();
        const file = join(home, "backups", name);
        const flipped = Buffer.from(readFileSync(file));
        const at = Math.floor(flipped.length * 0.7);
        flipped[at] = (flipped[at] ?? 0) ^ 0x01;
        writeFileSync(file, flipped);
        await refusedAndUntouched(backup, name);
      },
    ],
    [
      "a backup sealed for another key",
      async () => {
        const name = await backup.now();
        await refusedAndUntouched(makeService({ key: async () => generateKey() }), name);
      },
    ],
    [
      "a backup from a newer migration",
      async () => {
        const future: DbSource[] = [
          {
            rel: "majhi.db",
            backup: async (dest) => {
              await store.raw.backup(dest);
              const copy = new Database(dest);
              copy
                .prepare(
                  "INSERT INTO migrations (id, name, applied_at) VALUES (99999, 'from the future', 'x')",
                )
                .run();
              copy.close();
            },
          },
        ];
        const name = await makeService({ databases: () => future }).now();
        await refusedAndUntouched(backup, name);
      },
    ],
    [
      "a database that fails SQLite's own integrity check",
      async () => {
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
      },
    ],
  ])(
    "changes nothing when the backup is damaged, too new or sealed for another key: %s",
    async (_name, run) => {
      await run();
    },
  );

  it("blocks migration when its safety backup cannot be written", async () => {
    const old = mkdtempSync(join(tmpdir(), "majhi-premigrate-fail-"));
    try {
      await writeFile(join(old, "key"), `${identity}\n`);
      const db = new Database(join(old, "majhi.db"));
      migrate(db, MIGRATIONS.slice(0, 5));
      db.close();
      await writeFile(join(old, "backups"), "not a directory");
      const env = {
        majhiHome: old,
        secretsKeyFile: join(old, "key"),
        version: "1",
        commit: "c",
      } as ServerEnv;
      await expect(prepareStart(env)).rejects.toThrow("Database migration blocked");
      const unchanged = new Database(join(old, "majhi.db"));
      expect(unchanged.prepare("SELECT max(id) FROM migrations").pluck().get()).toBe(MIGRATIONS[4]?.id);
      unchanged.close();
    } finally {
      await rm(old, { recursive: true, force: true });
    }
  });
});
