import { existsSync, renameSync, rmSync } from "node:fs";
import { copyFile, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { BackupKind, BackupList } from "@majhi/shared";
import Database from "better-sqlite3";
import { errorMessage, UserError } from "../errors.ts";
import { MIGRATIONS } from "../store/migrations.ts";

/** `<majhi home>/backups`: the snapshots of `majhi.db`. The `*.db` rule keeps them out of the config history. */
export const BACKUP_DIR = "backups";
/** A snapshot majhi picked to restore waits here, and the next start puts it in place. */
export const PENDING_SUFFIX = ".restore";
/** Snapshots kept of each kind. */
export const KEEP = 7;
/** A daily snapshot is due when the newest one is older than this. */
export const DAY_MS = 24 * 60 * 60 * 1000;
/** The first check after start. */
export const FIRST_CHECK_MS = 30_000;
/** How often majhi checks whether the daily snapshot is due. */
export const CHECK_MS = 60 * 60 * 1000;

const NAME = /^(daily|manual|before-restore)-(\d{8}T\d{6}Z)\.db$/;

export interface BackupServiceOptions {
  majhiHome: string;
  /** The open database. Snapshots use SQLite's online backup, so majhi keeps working meanwhile. */
  sqlite: () => Database.Database;
  /** The database file name inside the home. */
  dbFile: string;
  clock?: () => Date;
}

/** `20261002T031500Z`: sorts as time, and has no characters a file name dislikes. */
function stamp(at: Date): string {
  return at
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
}

function stampToIso(text: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(text);
  return m === null ? text : `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.000Z`;
}

/**
 * A daily snapshot of `majhi.db` (tasks, rooms, history), the newest 7 kept, and restore from the
 * Backups section of Hub setup (SPEC Phase 2c). The snapshot is checked before it is trusted, a
 * restore first snapshots what is there, and the file swap happens at the next start because the
 * open database cannot be replaced under the repos holding it.
 */
export class BackupService {
  private readonly dir: string;
  private readonly clock: () => Date;
  private first: NodeJS.Timeout | undefined;
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: BackupServiceOptions) {
    this.dir = join(options.majhiHome, BACKUP_DIR);
    this.clock = options.clock ?? (() => new Date());
  }

  /**
   * Takes the daily snapshot when it is due, then checks again every hour. The first check waits a
   * little, so a majhi that starts and stops at once (a restart loop, a test) never writes one.
   */
  start(): void {
    const check = () =>
      void this.ensureDaily().catch((err: unknown) =>
        console.error(`Could not back up majhi.db: ${errorMessage(err)}`),
      );
    this.first = setTimeout(() => {
      check();
      this.timer = setInterval(check, CHECK_MS);
      this.timer.unref();
    }, FIRST_CHECK_MS);
    this.first.unref();
  }

  stop(): void {
    if (this.first !== undefined) clearTimeout(this.first);
    if (this.timer !== undefined) clearInterval(this.timer);
    this.first = undefined;
    this.timer = undefined;
  }

  /** Waits for a snapshot in progress, so the database is not closed under it. */
  async settle(): Promise<void> {
    await this.running.catch(() => undefined);
  }

  async list(): Promise<BackupList> {
    const files = await this.files();
    const pending = await this.pending();
    const newestDaily = files.find((f) => f.kind === "daily");
    return {
      keep: KEEP,
      backups: files.map(({ name, kind, at, bytes }) => ({ name, kind, at, bytes })),
      ...(pending === undefined ? {} : { pending }),
      ...(newestDaily === undefined ? {} : { lastDaily: newestDaily.at }),
    };
  }

  /** Takes today's snapshot unless the newest daily one is less than a day old. Returns it when it did. */
  async ensureDaily(): Promise<string | undefined> {
    const newest = (await this.files()).find((f) => f.kind === "daily");
    if (newest !== undefined && this.clock().getTime() - Date.parse(newest.at) < DAY_MS) return undefined;
    return this.snapshot("daily");
  }

  /** A snapshot on request, kept like the daily ones. */
  async now(): Promise<string> {
    return this.snapshot("manual");
  }

  /**
   * Checks the snapshot, snapshots the current database as `before-restore`, and stages the snapshot
   * for the next start. The running database is left as it is.
   */
  async restore(name: string): Promise<{ restored: string; safety: string }> {
    const found = (await this.files()).find((f) => f.name === name);
    if (found === undefined) throw new UserError(`There is no backup named ${name}.`, 404);
    await checkSnapshot(join(this.dir, name));
    const safety = await this.snapshot("before-restore");
    const target = this.pendingFile();
    const staged = `${target}.part`;
    await copyFile(join(this.dir, name), staged);
    await rename(staged, target);
    return { restored: name, safety };
  }

  /** Drops a staged restore, so the next start keeps the current database. */
  async cancelRestore(): Promise<void> {
    await rm(this.pendingFile(), { force: true });
  }

  private pendingFile(): string {
    return join(this.options.majhiHome, `${this.options.dbFile}${PENDING_SUFFIX}`);
  }

  private async pending(): Promise<string | undefined> {
    try {
      await stat(this.pendingFile());
    } catch {
      return undefined;
    }
    return "A restore is waiting for the next start of majhi.";
  }

  private snapshot(kind: BackupKind): Promise<string> {
    const run = this.running.catch(() => undefined).then(() => this.take(kind));
    this.running = run;
    return run;
  }

  private async take(kind: BackupKind): Promise<string> {
    await mkdir(this.dir, { recursive: true });
    const name = await this.freeName(kind);
    const part = join(this.dir, `${name}.part`);
    try {
      await this.options.sqlite().backup(part);
      await rename(part, join(this.dir, name));
    } catch (err) {
      await rm(part, { force: true });
      throw err;
    }
    await this.prune(kind);
    return name;
  }

  /** Two snapshots in the same second would collide: the second waits for the next one. */
  private async freeName(kind: BackupKind): Promise<string> {
    let at = this.clock();
    const taken = new Set((await this.files()).map((f) => f.name));
    let name = `${kind}-${stamp(at)}.db`;
    while (taken.has(name)) {
      at = new Date(at.getTime() + 1000);
      name = `${kind}-${stamp(at)}.db`;
    }
    return name;
  }

  private async prune(kind: BackupKind): Promise<void> {
    const old = (await this.files()).filter((f) => f.kind === kind).slice(KEEP);
    for (const file of old) await rm(join(this.dir, file.name), { force: true });
  }

  /** The snapshots, newest first. Half-written ones (`.part`) do not match the name and are skipped. */
  private async files(): Promise<{ name: string; kind: BackupKind; at: string; bytes: number }[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const out: { name: string; kind: BackupKind; at: string; bytes: number }[] = [];
    for (const name of names) {
      const m = NAME.exec(name);
      if (m === null) continue;
      const info = await stat(join(this.dir, name));
      out.push({ name, kind: m[1] as BackupKind, at: stampToIso(m[2] ?? ""), bytes: info.size });
    }
    return out.sort((a, b) => (a.at === b.at ? b.name.localeCompare(a.name) : b.at.localeCompare(a.at)));
  }
}

/** A snapshot majhi can restore is a whole database, at a version this build knows. */
export async function checkSnapshot(file: string): Promise<void> {
  let db: Database.Database | undefined;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
    const check = db.pragma("integrity_check", { simple: true });
    if (check !== "ok") throw new UserError(`The backup is damaged: ${String(check)}.`, 409);
    const known = new Set(MIGRATIONS.map((m) => m.id));
    const rows = db.prepare("SELECT id FROM migrations").all() as { id: number }[];
    if (rows.length === 0) throw new UserError("The backup holds no majhi database.", 409);
    const newest = Math.max(...known);
    if (rows.some((r) => r.id > newest)) {
      throw new UserError("The backup is from a newer majhi than this one. Update majhi first.", 409);
    }
  } catch (err) {
    if (err instanceof UserError) throw err;
    throw new UserError(`The backup cannot be read: ${errorMessage(err)}`, 409);
  } finally {
    db?.close();
  }
}

/**
 * Called before the database opens: a staged restore replaces `majhi.db`, and the old file's
 * write-ahead log goes with it. Returns whether one was applied.
 */
export function applyPendingRestore(majhiHome: string, dbFile: string): boolean {
  const staged = join(majhiHome, `${dbFile}${PENDING_SUFFIX}`);
  if (!existsSync(staged)) return false;
  const target = join(majhiHome, dbFile);
  rmSync(`${target}-wal`, { force: true });
  rmSync(`${target}-shm`, { force: true });
  renameSync(staged, target);
  return true;
}
