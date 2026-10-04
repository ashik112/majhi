import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

export const JOURNAL_FILE = "restore-journal.json";
export const RESULT_FILE = "restore-result.json";
export const STAGING_DIR = "restore-staging";
export const ROLLBACK_DIR = "rollback";
/** Rollback folders kept: the last restore's, and the one before. */
const KEEP_ROLLBACKS = 2;

const UnitSchema = z.object({
  /** Path inside the majhi home. */
  rel: z.string(),
  /** A write-ahead log or shared-memory file: set aside with its database, never put back from the backup. */
  companion: z.boolean(),
});
type Unit = z.infer<typeof UnitSchema>;

/**
 * `staged`: a verified restore waits for the next start. `swapping`: the swap began, so a journal
 * found in this state means it was cut off. `done` and `rolled-back` are final.
 */
const JournalSchema = z.object({
  version: z.literal(1),
  id: z.string(),
  /** The backup the data comes from. */
  name: z.string(),
  state: z.enum(["staged", "swapping", "done", "rolled-back"]),
  at: z.string(),
  /** Absolute: the verified tree to move into the home. */
  staged: z.string(),
  /** Absolute: where the data it replaces is set aside. */
  rollback: z.string(),
  units: z.array(UnitSchema),
});
export type Journal = z.infer<typeof JournalSchema>;

const ResultSchema = z.object({ at: z.string(), ok: z.boolean(), detail: z.string() });
export type RestoreResult = z.infer<typeof ResultSchema>;

/** The one file operation the swap uses, so a test can make it fail at a chosen step. */
export interface SwapFs {
  rename(from: string, to: string): void;
}
const realFs: SwapFs = { rename: renameSync };

const DB_UNITS = new Set(["majhi.db", "memory/memory.db"]);

/**
 * What a staged tree replaces in the home: each top-level name (a file or a folder), except that
 * `memory/` is replaced by its database only, so nothing else kept there is touched. A database's
 * `-wal` and `-shm` files are set aside before it, because they belong to the file being replaced.
 */
export function unitsOf(stagedData: string): Unit[] {
  const units: Unit[] = [];
  for (const name of readdirSync(stagedData).sort()) {
    if (name === "memory") {
      if (existsSync(join(stagedData, "memory", "memory.db"))) addDb(units, "memory/memory.db");
      continue;
    }
    if (DB_UNITS.has(name)) addDb(units, name);
    else units.push({ rel: name, companion: false });
  }
  return units;
}

function addDb(units: Unit[], rel: string): void {
  units.push({ rel: `${rel}-wal`, companion: true }, { rel: `${rel}-shm`, companion: true });
  units.push({ rel, companion: false });
}

function writeJson(file: string, value: unknown): void {
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, file);
}

function readJournal(home: string): Journal | undefined {
  try {
    return JournalSchema.parse(JSON.parse(readFileSync(join(home, JOURNAL_FILE), "utf8")));
  } catch {
    return undefined;
  }
}

export function readPending(home: string): Journal | undefined {
  const journal = readJournal(home);
  return journal?.state === "staged" || journal?.state === "swapping" ? journal : undefined;
}

/** What the last restore did when majhi started on it. Undefined when none ran or it is old news. */
export function readResult(home: string, now: Date = new Date()): RestoreResult | undefined {
  try {
    const result = ResultSchema.parse(JSON.parse(readFileSync(join(home, RESULT_FILE), "utf8")));
    return now.getTime() - Date.parse(result.at) < 3 * 24 * 60 * 60 * 1000 ? result : undefined;
  } catch {
    return undefined;
  }
}

/** Records a verified tree to swap in at the next start. Nothing live is touched yet. */
export function stageSwap(home: string, request: { id: string; name: string; staged: string; now: Date }): Journal {
  const journal: Journal = {
    version: 1,
    id: request.id,
    name: request.name,
    state: "staged",
    at: request.now.toISOString(),
    staged: request.staged,
    rollback: join(home, ROLLBACK_DIR, request.id),
    units: unitsOf(request.staged),
  };
  writeJson(join(home, JOURNAL_FILE), journal);
  return journal;
}

/** Drops a staged restore and its folder. False when none waits (or it already began). */
export function cancelStaged(home: string): boolean {
  const journal = readJournal(home);
  if (journal?.state !== "staged") return false;
  rmSync(dirname(journal.staged), { recursive: true, force: true });
  rmSync(join(home, JOURNAL_FILE), { force: true });
  return true;
}

function ensureParent(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

/**
 * Puts everything back as it was: for each unit, the set-aside original returns, and a new copy
 * that was already placed goes back to staging. It looks at the files, not at how far the swap got,
 * so it works the same after a crash at any step.
 */
function undo(home: string, journal: Journal, fs: SwapFs): void {
  for (const unit of [...journal.units].reverse()) {
    const live = join(home, unit.rel);
    const aside = join(journal.rollback, unit.rel);
    const staged = join(journal.staged, unit.rel);
    if (existsSync(aside)) {
      if (existsSync(live)) {
        ensureParent(staged);
        fs.rename(live, staged);
      }
      fs.rename(aside, live);
    } else if (!unit.companion && existsSync(live) && !existsSync(staged)) {
      ensureParent(staged);
      fs.rename(live, staged);
    }
  }
}

function forward(home: string, journal: Journal, fs: SwapFs): void {
  for (const unit of journal.units) {
    const live = join(home, unit.rel);
    const aside = join(journal.rollback, unit.rel);
    const staged = join(journal.staged, unit.rel);
    if (existsSync(live)) {
      ensureParent(aside);
      fs.rename(live, aside);
    }
    if (!unit.companion) {
      ensureParent(live);
      fs.rename(staged, live);
    }
  }
}

function finish(home: string, journal: Journal, state: "done" | "rolled-back", result: RestoreResult): void {
  writeJson(join(home, RESULT_FILE), result);
  writeJson(join(home, JOURNAL_FILE), { ...journal, state });
  if (state === "done") rmSync(dirname(journal.staged), { recursive: true, force: true });
  pruneRollbacks(home);
}

/** Keeps the newest rollback folders; older ones were safety nets for restores long past. */
function pruneRollbacks(home: string): void {
  const dir = join(home, ROLLBACK_DIR);
  if (!existsSync(dir)) return;
  const old = readdirSync(dir).sort().reverse().slice(KEEP_ROLLBACKS);
  for (const name of old) rmSync(join(dir, name), { recursive: true, force: true });
}

/**
 * Runs first thing at start, before anything opens a file. A staged restore is swapped in: each
 * unit's current data moves to the rollback folder and the verified copy takes its place. If any
 * step fails, or a previous start died halfway, everything is put back and the failure is recorded
 * for the Backups section. Returns whether a restore was applied.
 */
export function applyPendingRestore(home: string, fs: SwapFs = realFs, now: () => Date = () => new Date()): boolean {
  const journal = readJournal(home);
  if (journal === undefined) return false;
  if (journal.state === "staged") {
    writeJson(join(home, JOURNAL_FILE), { ...journal, state: "swapping" });
    try {
      forward(home, journal, fs);
    } catch (err) {
      const detail = `The restore could not be applied (${err instanceof Error ? err.message : String(err)}). Your data is as it was.`;
      return abortSwap(home, journal, fs, detail, now);
    }
    finish(home, journal, "done", {
      at: now().toISOString(),
      ok: true,
      detail: `Restored from ${journal.name}. The data it replaced is kept in ${journal.rollback}.`,
    });
    return true;
  }
  if (journal.state === "swapping") {
    // A start died between the first and the last move: nothing says it finished, so go back.
    abortSwap(home, journal, fs, "A restore was cut off before it finished. Your data is as it was.", now);
  }
  return false;
}

function abortSwap(home: string, journal: Journal, fs: SwapFs, detail: string, now: () => Date): false {
  try {
    undo(home, journal, fs);
  } catch (err) {
    // The journal stays in `swapping`, so the next start tries to put things back again.
    console.error(`majhi could not undo a failed restore: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
  finish(home, journal, "rolled-back", { at: now().toISOString(), ok: false, detail });
  return false;
}
