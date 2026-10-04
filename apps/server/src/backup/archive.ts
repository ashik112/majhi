import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BackupKind } from "@majhi/shared";
import Database from "better-sqlite3";
import type { ConfigHistory } from "../config/history.ts";
import { errorMessage, UserError } from "../errors.ts";
import { decryptStream, encryptStream, type Lock } from "./crypto.ts";
import {
  BUNDLE_FILE,
  checkFiles,
  DATA_DIR,
  Damaged,
  describeFiles,
  MANIFEST_FILE,
  type Manifest,
  readManifest,
} from "./manifest.ts";
import { packDir, unpackTo } from "./tar.ts";

/** Written into every manifest, so the owner knows what a backup does not hold. */
export const EXCLUDED = [
  "Account logins (accounts/) and agent working homes: sign in again after a restore on a new computer",
  "Connection credentials (connections/)",
  "The secrets key itself: it lives in the Keychain or keyring and in the passphrase export",
  "Task folders, worktrees and repositories: they live in git",
  "Model and tool caches",
];

/** Top-level names in the majhi home that never go into an archive, though git may not ignore them. */
const NEVER = new Set([
  "backups",
  "rollback",
  "restore-staging",
  "run",
  "cache",
  "accounts",
  "agent-homes",
  "connections",
  "logs",
  "bin",
]);

/**
 * What of the config folder an archive copies: the owner's settings, agents and skills. Everything
 * else in the majhi home is rebuilt or downloaded again (the Laya model, the e2e checkout, task
 * folders) and would make every archive hundreds of megabytes.
 */
const CONFIG_ROOTS = new Set(["majhi.yaml", ".gitignore", "agents", "skills"]);

/** Files up to this size are scanned for an age identity before they are copied. */
const KEY_SCAN_MAX = 4 * 1024 * 1024;

/** One database to snapshot. `rel` is where it lives inside the majhi home. */
export interface DbSource {
  rel: string;
  /** Writes a consistent copy of the database to `dest`. It must be safe while writes go on. */
  backup(dest: string): Promise<void>;
}

export interface CreateOptions {
  home: string;
  /** Folder that receives the archive. */
  dir: string;
  /** Scratch space for the unencrypted staging folder. Same disk as the home. */
  work: string;
  kind: BackupKind;
  lock: Lock;
  now: Date;
  version: { version: string; commit: string };
  databases: DbSource[];
  history: ConfigHistory;
  /** Called with the bytes written so far before each chunk lands. A test makes it throw to fake a full disk. */
  beforeWrite?: (written: number) => void | Promise<void>;
}

/** `20261004T031500Z`: sorts as time, and has no characters a file name dislikes. */
export function stamp(at: Date): string {
  return at
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
}

export const ARCHIVE_NAME =
  /^majhi-(daily|manual|before-update|before-migration|before-restore)-(\d{8}T\d{6}Z)\.age$/;

/** Newest applied migration id of a database file, or null when it has no migrations table. */
export function newestMigration(file: string): number | null {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare("SELECT MAX(id) AS id FROM migrations").get() as { id: number | null } | undefined;
    return row?.id ?? null;
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/**
 * Takes a consistent copy of everything majhi cannot rebuild, packs it (tar, gzip) and encrypts it
 * with age while it streams to disk. The archive is written under a `.part` name and renamed only
 * when every byte is on disk, so a full disk or a crash leaves no file that looks like a backup.
 */
export async function createBackup(
  opts: CreateOptions,
): Promise<{ name: string; bytes: number; manifest: Manifest }> {
  await mkdir(opts.work, { recursive: true });
  const stage = await mkdtemp(join(opts.work, "backup-"));
  const migrations: Manifest["migrations"] = { majhi: null, memory: null };
  try {
    const data = join(stage, DATA_DIR);
    await mkdir(data, { recursive: true });
    const taken = new Set<string>();
    for (const source of opts.databases) {
      const dest = join(data, source.rel);
      await mkdir(dirname(dest), { recursive: true });
      await source.backup(dest);
      taken.add(source.rel);
      const check = quickCheck(dest);
      if (check !== "ok") throw new Error(`The copy of ${source.rel} did not pass its check: ${check}`);
      migrations[source.rel === "majhi.db" ? "majhi" : "memory"] = newestMigration(dest);
    }

    // The encrypted secrets file travels as it is: never decrypted, and never next to its key.
    taken.add("secrets.age");
    await copyIfThere(join(opts.home, "secrets.age"), join(data, "secrets.age"));

    for (const rel of await opts.history.visibleFiles()) {
      const root = rel.split("/")[0] ?? "";
      if (taken.has(rel) || !CONFIG_ROOTS.has(root) || NEVER.has(root)) continue;
      const from = join(opts.home, rel);
      const info = await lstat(from).catch(() => undefined);
      if (info === undefined || !info.isFile()) continue;
      // Belt and braces: whatever the file is called, an age identity never goes into an archive.
      if (info.size <= KEY_SCAN_MAX && (await readFile(from)).includes("AGE-SECRET-KEY-")) continue;
      await mkdir(dirname(join(data, rel)), { recursive: true });
      await copyFile(from, join(data, rel));
    }
    await mkdir(join(stage, "meta"), { recursive: true });
    const bundled = await opts.history.bundleTo(join(stage, BUNDLE_FILE));

    const manifest: Manifest = {
      format: 1,
      createdAt: opts.now.toISOString(),
      kind: opts.kind,
      majhi: opts.version,
      migrations,
      config: { head: (await opts.history.head()) ?? null, bundle: bundled },
      files: await describeFiles(stage),
      excluded: EXCLUDED,
    };
    await writeFile(join(stage, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);

    await mkdir(opts.dir, { recursive: true });
    const name = await freeName(opts.dir, opts.kind, opts.now);
    const final = join(opts.dir, name);
    const bytes = await writeEncrypted(packDir(stage), opts.lock, `${final}.part`, final, opts.beforeWrite);
    return { name, bytes, manifest };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

async function copyIfThere(from: string, to: string): Promise<void> {
  try {
    await copyFile(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

function quickCheck(file: string): string {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return String(db.pragma("quick_check", { simple: true }));
  } finally {
    db.close();
  }
}

/** Two backups in the same second would collide: the later one takes the next second's name. */
async function freeName(dir: string, kind: BackupKind, at: Date): Promise<string> {
  let when = at;
  for (;;) {
    const name = `majhi-${kind}-${stamp(when)}.age`;
    try {
      await lstat(join(dir, name));
    } catch {
      return name;
    }
    when = new Date(when.getTime() + 1000);
  }
}

async function writeEncrypted(
  plain: import("node:stream").Readable,
  lock: Lock,
  part: string,
  final: string,
  beforeWrite: CreateOptions["beforeWrite"],
): Promise<number> {
  let written = 0;
  const handle = await open(part, "w", 0o600);
  try {
    const sealed = await encryptStream(plain, lock);
    for await (const chunk of sealed) {
      await beforeWrite?.(written);
      await handle.write(chunk as Buffer);
      written += (chunk as Buffer).length;
    }
    await handle.sync();
  } catch (err) {
    plain.destroy();
    await handle.close().catch(() => undefined);
    await rm(part, { force: true });
    throw err;
  }
  await handle.close();
  await rename(part, final);
  return written;
}

/**
 * Decrypts and unpacks an archive into `into` (an empty folder) and checks every file against the
 * manifest. A cut-off, edited or bit-flipped archive throws a `Damaged` error; a wrong key or
 * passphrase throws a plain one, so the caller can tell a broken backup from a locked one.
 */
export async function unpackArchive(file: string, lock: Lock, into: string): Promise<Manifest> {
  await mkdir(into, { recursive: true });
  try {
    const source = createReadStream(file);
    const plain = await decryptStream(source, lock);
    await unpackTo(plain, into);
    const manifest = await readManifest(into);
    await checkFiles(into, manifest);
    return manifest;
  } catch (err) {
    if (err instanceof UserError) throw err;
    throw new Damaged(`the file is cut off or has been changed (${errorMessage(err)})`);
  }
}
