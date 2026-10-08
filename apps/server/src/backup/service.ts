import { existsSync } from "node:fs";
import {
  access,
  constants,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  statfs,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  BACKUP_KEEP_DAILY,
  BACKUP_KEEP_SAFETY,
  BACKUP_KEEP_WEEKLY,
  type BackupInfo,
  type BackupKind,
  type BackupList,
  type BackupVerify,
} from "@majhi/shared";
import Database from "better-sqlite3";
import type { ConfigHistory } from "../config/history.ts";
import { errorMessage, UserError } from "../errors.ts";
import { decrypts } from "../secrets/store.ts";
import {
  ARCHIVE_NAME,
  createBackup,
  type DbSource,
  newestMigration,
  stamp,
  unpackArchive,
} from "./archive.ts";
import { type Lock, Locked, lockOf } from "./crypto.ts";
import { checkDestination, type DestinationEnv, hostDestinationEnv, probeWritable } from "./destination.ts";
import { Damaged, type Manifest } from "./manifest.ts";
import { selectPrune } from "./retention.ts";
import {
  type BackupState,
  defaultDir,
  destinationOf,
  readSettings,
  readState,
  writeSettings,
  writeState,
} from "./state.ts";
import { cancelStaged, readPending, readResult, STAGING_DIR, stageSwap } from "./swap.ts";
import { validateStaged } from "./validate.ts";

export const DAY_MS = 24 * 60 * 60 * 1000;
export const WEEK_MS = 7 * DAY_MS;
/** The first check after start. */
export const FIRST_CHECK_MS = 30_000;
/** How often majhi checks whether the daily backup or the weekly check is due. */
export const CHECK_MS = 60 * 60 * 1000;
/** A safety copy is skipped when a backup this fresh exists: an update right after a backup needs no second one. */
export const FRESH_MS = 5 * 60 * 1000;

const LEGACY_NAME = /^(daily|manual|before-restore)-(\d{8}T\d{6}Z)\.db$/;

interface Entry {
  name: string;
  path: string;
  kind: BackupKind;
  at: string;
  bytes: number;
  lock: BackupInfo["lock"];
  legacy: boolean;
}

export interface BackupServiceOptions {
  majhiHome: string;
  /** The databases to copy. The live service hands over its open connections. */
  databases: () => DbSource[];
  history: ConfigHistory;
  /** The age identity that locks scheduled backups: the secrets key. Undefined when there is none. */
  key: () => Promise<string | undefined>;
  version: { version: string; commit: string };
  clock?: () => Date;
  /** Ends this process so the supervisor starts it again onto the staged restore. Absent when nothing would restart it. */
  restart?: () => void;
  destinationEnv?: DestinationEnv;
  /** Test hook: scrypt cost of passphrase-locked backups. Production uses the age default. */
  passphraseLogN?: number;
  /** Test hook: runs before each chunk of an archive is written. */
  beforeWrite?: (written: number) => void | Promise<void>;
  /** Test hook: free bytes on the disk that holds a folder. */
  freeBytes?: (dir: string) => Promise<number>;
}

/** Room a backup always leaves on the disk, so it never fills the disk majhi and the agents work on. */
const DISK_RESERVE = 2 * 1024 ** 3;

async function diskFree(dir: string): Promise<number> {
  const fs = await statfs(dir);
  return fs.bavail * fs.bsize;
}

/** `20261004T031500Z` back to an ISO time. */
function stampToIso(text: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(text);
  return m === null ? text : `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.000Z`;
}

/** Database sources that open their own connection, for a backup before majhi has its databases open. */
export function fileSources(home: string): DbSource[] {
  const rels = ["majhi.db", "memory/memory.db"];
  return rels.map((rel) => ({
    rel,
    async backup(dest: string) {
      const db = new Database(join(home, rel), { fileMustExist: true });
      try {
        await db.backup(dest);
      } finally {
        db.close();
      }
    },
  }));
}

/**
 * The default folder is made by the first backup, so on a fresh install it may not exist yet: that is
 * fine while its nearest existing parent is writable. A folder the owner picked must exist.
 */
async function writableOrCreatable(path: string, custom: boolean): Promise<void> {
  try {
    await access(path, constants.W_OK);
  } catch (err) {
    if (custom || (err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    let parent = dirname(path);
    while (!existsSync(parent) && dirname(parent) !== parent) parent = dirname(parent);
    await access(parent, constants.W_OK);
  }
}

/**
 * Backs up everything majhi cannot rebuild into one encrypted archive: the databases (online copies,
 * so majhi keeps working), the config history and its agent and skill files, and the encrypted
 * secrets file. Daily, plus before an update or a migration; weekly it restores the newest one into
 * a temporary folder to prove it works. Restore swaps in a verified copy at the next start and keeps
 * what it replaces. SPEC 5.18.
 */
export class BackupService {
  private first: NodeJS.Timeout | undefined;
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<unknown> = Promise.resolve();
  private busy: BackupList["busy"];
  private readonly clock: () => Date;
  private readonly env: DestinationEnv;

  constructor(private readonly options: BackupServiceOptions) {
    this.clock = options.clock ?? (() => new Date());
    this.env = options.destinationEnv ?? hostDestinationEnv();
  }

  /** Checks shortly after start and then every hour; a majhi that starts and stops at once never writes a backup. */
  start(): void {
    const tick = () =>
      void this.scheduled().catch((err: unknown) => console.error(`Backup failed: ${errorMessage(err)}`));
    this.first = setTimeout(() => {
      tick();
      this.timer = setInterval(tick, CHECK_MS);
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

  /** Waits for work in progress, so the databases are not closed under it. */
  async settle(): Promise<void> {
    await this.running.catch(() => undefined);
  }

  private get home(): string {
    return this.options.majhiHome;
  }

  /** The daily backup when due, then the weekly check when due. */
  async scheduled(): Promise<void> {
    await this.exclusive("verify", () => this.sweepLeftovers());
    await this.ensureDaily().catch((err: unknown) => {
      console.error(`Daily backup failed: ${errorMessage(err)}`);
    });
    await this.ensureWeeklyCheck();
  }

  async list(): Promise<BackupList> {
    const [dest, state, files] = await Promise.all([
      destinationOf(this.home),
      readState(this.home),
      this.files(),
    ]);
    const unreachable = await writableOrCreatable(dest.path, dest.custom).then(
      () => undefined,
      () => `majhi cannot write to ${dest.path} right now.`,
    );
    const newestDaily = files.find((f) => f.kind === "daily");
    const pending = readPending(this.home);
    const restored = readResult(this.home, this.clock());
    return {
      keep: { daily: BACKUP_KEEP_DAILY, weekly: BACKUP_KEEP_WEEKLY, safety: BACKUP_KEEP_SAFETY },
      backups: files.map((f) => {
        const verified = state.verifies[f.name];
        return {
          name: f.name,
          kind: f.kind,
          at: f.at,
          bytes: f.bytes,
          lock: f.lock,
          legacy: f.legacy,
          ...(verified === undefined
            ? {}
            : { verified: { at: verified.at, ok: verified.ok, detail: verified.detail } }),
        };
      }),
      destination: {
        path: dest.path,
        custom: dest.custom,
        ...(unreachable === undefined ? {} : { error: unreachable }),
      },
      ...(files[0] === undefined ? {} : { lastAt: files[0].at }),
      ...(newestDaily === undefined ? {} : { lastDaily: newestDaily.at }),
      nextAt: new Date(
        newestDaily === undefined ? this.clock().getTime() : Date.parse(newestDaily.at) + DAY_MS,
      ).toISOString(),
      ...(state.lastVerify === undefined ? {} : { lastVerify: state.lastVerify }),
      ...(state.lastError === undefined ? {} : { lastError: state.lastError }),
      ...(pending === undefined ? {} : { pending: "A restore is ready. majhi restarts onto it." }),
      ...(restored === undefined ? {} : { restored }),
      ...(this.busy === undefined ? {} : { busy: this.busy }),
    };
  }

  /** Takes today's backup unless the newest daily one is less than a day old. Returns its name when it did. */
  async ensureDaily(): Promise<string | undefined> {
    const newest = (await this.files()).find((f) => f.kind === "daily");
    if (newest !== undefined && this.clock().getTime() - Date.parse(newest.at) < DAY_MS) return undefined;
    return this.exclusive("backup", () => this.take("daily"));
  }

  /** A backup on request. With a passphrase it opens only with that passphrase, which majhi does not keep. */
  async now(passphrase?: string): Promise<string> {
    return this.exclusive("backup", () => this.take("manual", passphrase));
  }

  /**
   * The safety copy before majhi changes itself. Skipped when a backup under five minutes old exists.
   * Throws when it cannot be taken: the caller decides whether to go on without it.
   */
  async before(kind: "before-update" | "before-migration"): Promise<string | undefined> {
    return this.exclusive("backup", async () => {
      const newest = (await this.files())[0];
      if (
        newest !== undefined &&
        !newest.legacy &&
        newest.lock === "key" &&
        this.clock().getTime() - Date.parse(newest.at) < FRESH_MS
      ) {
        const checked = await this.check(newest, undefined);
        if (checked.result.ok) return undefined;
      }
      const name = await this.take(kind);
      const entry = (await this.files()).find((file) => file.name === name);
      if (entry === undefined) throw new UserError("The safety backup is missing.", 409);
      const checked = await this.check(entry, undefined);
      if (!checked.result.ok)
        throw new UserError(`The safety backup could not be verified: ${checked.result.detail}`, 409);
      return name;
    });
  }

  /**
   * Restores a backup into a temporary folder and checks it end to end, then deletes the folder.
   * Nothing live is touched. The result is kept for the Backups section and Health.
   */
  async verify(name?: string, passphrase?: string): Promise<{ name: string; result: BackupVerify }> {
    const files = await this.files();
    const entry = name === undefined ? files[0] : files.find((f) => f.name === name);
    if (entry === undefined) {
      throw new UserError(
        name === undefined ? "There is no backup to check yet." : `There is no backup named ${name}.`,
        404,
      );
    }
    return this.exclusive("verify", () => this.check(entry, passphrase));
  }

  /**
   * Checks the backup, copies the data it would replace into a safety backup, stages the verified
   * copy and restarts majhi. The swap itself runs at the start of the next process, before any file
   * is open (swap.ts), and is undone on any failure.
   */
  async restore(
    name: string,
    passphrase?: string,
  ): Promise<{ restored: string; safety: string; restarting: boolean }> {
    return this.exclusive("restore", async () => {
      if (readPending(this.home) !== undefined) throw new UserError("A restore is already waiting.", 409);
      const entry = (await this.files()).find((f) => f.name === name);
      if (entry === undefined) throw new UserError(`There is no backup named ${name}.`, 404);
      const id = stamp(this.clock());
      const root = join(this.home, STAGING_DIR, id);
      try {
        await this.prepare(entry, passphrase, root);
        await this.keepCurrentSecretsIfLocked(root);
      } catch (err) {
        await rm(root, { recursive: true, force: true });
        throw err;
      }
      let safety: string;
      try {
        safety = await this.take("before-restore");
      } catch (err) {
        await rm(root, { recursive: true, force: true });
        throw new UserError(
          `The restore did not start: majhi could not back up the current data first (${errorMessage(err)}).`,
          409,
        );
      }
      stageSwap(this.home, { id, name: entry.name, staged: join(root, "data"), now: this.clock() });
      this.options.restart?.();
      return { restored: entry.name, safety, restarting: this.options.restart !== undefined };
    });
  }

  /** Drops a restore that has not started. */
  async cancelRestore(): Promise<boolean> {
    return cancelStaged(this.home);
  }

  /** Sets the backup folder, or null for the default. The folder must be writable now. */
  async setDestination(input: string | null): Promise<string> {
    if (input === null) {
      await writeSettings(this.home, {});
      const path = defaultDir(this.home);
      await probeWritable(path);
      return path;
    }
    const path = await checkDestination(this.home, input, this.env);
    const settings = await readSettings(this.home);
    await writeSettings(this.home, { ...settings, destination: path });
    return path;
  }

  /** Serializes everything that reads or writes archives and shows what runs in the list. */
  private exclusive<T>(label: NonNullable<BackupList["busy"]>, work: () => Promise<T>): Promise<T> {
    const run = this.running
      .catch(() => undefined)
      .then(async () => {
        this.busy = label;
        try {
          // Every operation is serialized: no active backup can own this crash-left scratch data.
          await rm(join(this.home, "run", "backup-work"), { recursive: true, force: true });
          return await work();
        } finally {
          this.busy = undefined;
        }
      });
    this.running = run;
    return run;
  }

  private async lockFor(passphrase: string | undefined): Promise<Lock> {
    if (passphrase !== undefined) {
      const logN = this.options.passphraseLogN;
      return { kind: "passphrase", passphrase, ...(logN === undefined ? {} : { logN }) };
    }
    const identity = await this.options.key();
    if (identity === undefined) {
      throw new UserError(
        "majhi has no secrets key yet, so it cannot lock a backup. Set up secrets first.",
        409,
      );
    }
    return { kind: "key", identity };
  }

  private async take(kind: BackupKind, passphrase?: string): Promise<string> {
    try {
      const lock = await this.lockFor(passphrase);
      const dest = await destinationOf(this.home);
      await this.sweepParts(dest.path).catch(() => undefined);
      await this.ensureRoom(existsSync(dest.path) ? dest.path : this.home);
      const made = await createBackup({
        home: this.home,
        dir: dest.path,
        work: join(this.home, "run", "backup-work"),
        kind,
        lock,
        now: this.clock(),
        version: this.options.version,
        databases: this.options
          .databases()
          .filter((d) => d.rel === "majhi.db" || d.rel === "memory/memory.db"),
        history: this.options.history,
        ...(this.options.beforeWrite === undefined ? {} : { beforeWrite: this.options.beforeWrite }),
      });
      await this.setError(undefined);
      await this.prune().catch((err: unknown) =>
        console.error(`Could not prune backups: ${errorMessage(err)}`),
      );
      return made.name;
    } catch (err) {
      await this.setError(errorMessage(err));
      throw err;
    }
  }

  /**
   * Refuses a backup that would leave less than the reserve free: the databases are copied once to a
   * work folder and once more into the archive, so it needs about twice their size.
   */
  private async ensureRoom(dir: string): Promise<void> {
    let data = 0;
    for (const rel of [
      "majhi.db",
      "majhi.db-wal",
      join("memory", "memory.db"),
      join("memory", "memory.db-wal"),
    ]) {
      data += (await stat(join(this.home, rel)).catch(() => undefined))?.size ?? 0;
    }
    const free = await (this.options.freeBytes ?? diskFree)(dir);
    const need = data * 2 + DISK_RESERVE;
    if (free < need) {
      const gb = (n: number) => `${(n / 1024 ** 3).toFixed(1)} GB`;
      throw new UserError(
        `Not enough disk space for a backup: ${gb(free)} free, it needs ${gb(need)} to leave ${gb(DISK_RESERVE)} for your work. Free some space or pick another backup folder.`,
        409,
      );
    }
  }

  private async setError(detail: string | undefined): Promise<void> {
    const state = await readState(this.home);
    if (detail === undefined) delete state.lastError;
    else state.lastError = { at: this.clock().toISOString(), detail };
    await writeState(this.home, state).catch(() => undefined);
  }

  /** Deletes what the retention rules drop. A backup that failed its check is not counted as good. */
  private async prune(): Promise<void> {
    const state = await readState(this.home);
    const files = await this.files();
    const drop = selectPrune(
      files.map((f) => ({
        name: f.name,
        kind: f.kind,
        at: f.at,
        usable: state.verifies[f.name]?.damaged !== true,
      })),
      { daily: BACKUP_KEEP_DAILY, weekly: BACKUP_KEEP_WEEKLY, safety: BACKUP_KEEP_SAFETY },
    );
    for (const name of drop) {
      const entry = files.find((f) => f.name === name);
      if (entry !== undefined) await rm(entry.path, { force: true });
      delete state.verifies[name];
    }
    if (drop.length > 0) await writeState(this.home, state);
  }

  /** Unpacks and validates a backup into `root`. Throws `Locked` when the key or passphrase does not open it. */
  private async prepare(
    entry: Entry,
    passphrase: string | undefined,
    root: string,
  ): Promise<{ manifest: Manifest; detail: string }> {
    await mkdir(root, { recursive: true });
    if (entry.legacy) {
      await mkdir(join(root, "data"), { recursive: true });
      await copyFile(entry.path, join(root, "data", "majhi.db"));
      const manifest: Manifest = {
        format: 1,
        createdAt: entry.at,
        kind: entry.kind,
        majhi: { version: "unknown", commit: "unknown" },
        migrations: { majhi: newestMigration(join(root, "data", "majhi.db")), memory: null },
        config: { head: null, bundle: false },
        files: [],
        excluded: [],
      };
      return { manifest, detail: await validateStaged(root, manifest) };
    }
    const lock = await this.lockToOpen(entry, passphrase);
    const manifest = await unpackArchive(entry.path, lock, root);
    return { manifest, detail: await validateStaged(root, manifest) };
  }

  private async lockToOpen(entry: Entry, passphrase: string | undefined): Promise<Lock> {
    if (entry.lock === "none") throw new Damaged("it is not an encrypted majhi backup");
    if (entry.lock === "passphrase") {
      if (passphrase === undefined)
        throw new Locked("This backup is locked with a passphrase. Type it to continue.", 400);
      return { kind: "passphrase", passphrase };
    }
    const identity = await this.options.key();
    if (identity === undefined) {
      throw new Locked(
        "This backup is locked with the secrets key, which this computer does not have. Restore the key first.",
        409,
      );
    }
    return { kind: "key", identity };
  }

  /**
   * A backup from before a key change holds a secrets file the current key cannot open. Restoring
   * it would lock the owner out of their API keys, so the current file stays.
   */
  private async keepCurrentSecretsIfLocked(root: string): Promise<void> {
    const file = join(root, "data", "secrets.age");
    const identity = await this.options.key();
    if (identity === undefined) return;
    const sealed = await readFile(file).catch(() => undefined);
    if (sealed === undefined) return;
    if (!(await decrypts(identity, sealed))) {
      console.warn("The backup's secrets file is locked with a different key, so the current one stays.");
      await rm(file, { force: true });
    }
  }

  private async check(
    entry: Entry,
    passphrase: string | undefined,
  ): Promise<{ name: string; result: BackupVerify }> {
    const scratch = await mkdtemp(await scratchBase(this.home));
    let result: BackupVerify;
    let damaged = false;
    try {
      const { detail } = await this.prepare(entry, passphrase, scratch);
      result = { at: this.clock().toISOString(), ok: true, detail };
    } catch (err) {
      if (err instanceof Locked) throw err;
      damaged = err instanceof Damaged;
      result = { at: this.clock().toISOString(), ok: false, detail: errorMessage(err) };
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
    await this.remember(entry.name, result, damaged);
    return { name: entry.name, result };
  }

  private async remember(name: string, result: BackupVerify, damaged: boolean): Promise<void> {
    const state: BackupState = await readState(this.home);
    state.verifies[name] = { ...result, damaged };
    state.lastVerify = { ...result, name };
    await writeState(this.home, state).catch(() => undefined);
  }

  /** Checks the newest key-locked backup when the last check is a week old. */
  private async ensureWeeklyCheck(): Promise<void> {
    const state = await readState(this.home);
    if (state.lastVerify !== undefined && this.clock().getTime() - Date.parse(state.lastVerify.at) < WEEK_MS)
      return;
    const target = (await this.files()).find((f) => f.lock === "key");
    if (target === undefined) return;
    try {
      await this.exclusive("verify", () => this.check(target, undefined));
    } catch (err) {
      if (!(err instanceof Locked)) throw err;
      await this.remember(
        target.name,
        { at: this.clock().toISOString(), ok: false, detail: err.message },
        false,
      );
    }
  }

  /** Half-written archives of a run that died (a restart mid-backup), older than an hour. */
  private async sweepParts(dir: string): Promise<void> {
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      if (!name.endsWith(".age.part")) continue;
      const info = await stat(join(dir, name)).catch(() => undefined);
      // File times are real time, so this uses the real clock.
      if (info !== undefined && Date.now() - info.mtimeMs > 60 * 60 * 1000) {
        await rm(join(dir, name), { force: true });
      }
    }
  }

  /** Half-written archives and abandoned staging folders from a run that died. */
  private async sweepLeftovers(): Promise<void> {
    const dest = await destinationOf(this.home);
    await this.sweepParts(dest.path);
    const staging = join(this.home, STAGING_DIR);
    const waiting = readPending(this.home)?.id;
    for (const id of await readdir(staging).catch(() => [] as string[])) {
      if (id !== waiting) await rm(join(staging, id), { recursive: true, force: true });
    }
  }

  /** Archives in the backup folder and older plain copies in the default one, newest first. */
  private async files(): Promise<Entry[]> {
    const dest = await destinationOf(this.home);
    const out: Entry[] = [];
    for (const name of await readdir(dest.path).catch(() => [] as string[])) {
      const m = ARCHIVE_NAME.exec(name);
      if (m === null) continue;
      const path = join(dest.path, name);
      const info = await stat(path).catch(() => undefined);
      if (info === undefined || info.size === 0) continue;
      out.push({
        name,
        path,
        kind: m[1] as BackupKind,
        at: stampToIso(m[2] ?? ""),
        bytes: info.size,
        lock: await lockOf(path).catch(() => "none" as const),
        legacy: false,
      });
    }
    const old = defaultDir(this.home);
    for (const name of await readdir(old).catch(() => [] as string[])) {
      const m = LEGACY_NAME.exec(name);
      if (m === null) continue;
      const info = await stat(join(old, name)).catch(() => undefined);
      if (info === undefined) continue;
      out.push({
        name,
        path: join(old, name),
        kind: m[1] as BackupKind,
        at: stampToIso(m[2] ?? ""),
        bytes: info.size,
        lock: "none",
        legacy: true,
      });
    }
    return out.sort((a, b) => (a.at === b.at ? b.name.localeCompare(a.name) : b.at.localeCompare(a.at)));
  }
}

async function scratchBase(home: string): Promise<string> {
  const run = join(home, "run");
  await mkdir(run, { recursive: true });
  return join(run, "backup-check-");
}
