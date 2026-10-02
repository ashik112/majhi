import type { AccountUsage } from "@majhi/shared";

/**
 * Parallel planning (SPEC Phase 3, lead orchestration): before a lead or the boss starts a task,
 * check whether it is safe next to the tasks already running. Pure functions only: the service
 * gathers the inputs (worktree diffs, running tasks, account usage) and acts on the verdict.
 */

// ---------------------------------------------------------------------------
// Paths

/** Directory depth that counts as "the same module": `apps/server/src/runs`. */
const MODULE_DEPTH = 4;

/** The module of a path: its directory cut to `MODULE_DEPTH` segments. Files at the root are `.`. */
export function moduleOf(path: string): string {
  const parts = normalizePath(path).split("/").filter(Boolean);
  const dir = parts.length > 0 && !looksLikeDir(path) ? parts.slice(0, -1) : parts;
  return dir.length === 0 ? "." : dir.slice(0, MODULE_DEPTH).join("/");
}

function normalizePath(path: string): string {
  return path.replace(/^\.\//, "").replace(/\/+/g, "/");
}

function looksLikeDir(path: string): boolean {
  return path.endsWith("/");
}

/**
 * Files and folders a task description names: tokens with a slash, or a file name with an
 * extension. Links and version numbers are skipped. In order of first mention, without repeats.
 */
export function likelyPaths(text: string): string[] {
  const out: string[] = [];
  const withoutLinks = text.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, " ");
  for (const raw of withoutLinks.match(/[\w@.~-]+(?:\/[\w@.~-]+)+\/?|[\w-]+\.[A-Za-z][A-Za-z0-9]{0,5}\b/g) ??
    []) {
    const path = normalizePath(raw.replace(/[.,;:]+$/, ""));
    if (path === "" || /^\d+(\.\d+)+$/.test(path) || path.startsWith("..")) continue;
    if (!path.includes("/") && /^(e\.g|i\.e|etc|vs)\./i.test(path)) continue;
    if (!out.includes(path)) out.push(path);
  }
  return out;
}

/** Whether one path is the other, or a folder that holds it. */
function related(a: string, b: string): boolean {
  const x = normalizePath(a).replace(/\/$/, "");
  const y = normalizePath(b).replace(/\/$/, "");
  return x === y || y.startsWith(`${x}/`) || x.startsWith(`${y}/`);
}

// ---------------------------------------------------------------------------
// Overlap

/** What a running task has changed (or, before it changes anything, what its description names). */
export interface Footprint {
  task: string;
  project: string;
  paths: string[];
  /** True when `paths` come from the worktree diff, false when guessed from the description. */
  changed: boolean;
  /** The files the worktree diff shows, without the ones the description names. Set when `changed`. */
  changedPaths?: string[];
}

export type OverlapLevel = "none" | "little" | "heavy" | "unknown";

export interface Overlap {
  level: OverlapLevel;
  /** Files or folders in both. */
  files: string[];
  /** Modules in both. */
  modules: string[];
}

/**
 * Compares what the new task is likely to touch with what one running task has. Heavy: they name
 * or changed the same file, or at least half of the new task's paths (two at least) sit in
 * modules the other task works in. Little: they only share a module. Unknown: either side has no
 * paths, so nothing can be said.
 */
export function overlapWith(likely: readonly string[], other: readonly string[]): Overlap {
  if (likely.length === 0 || other.length === 0) return { level: "unknown", files: [], modules: [] };
  const files = likely.filter((p) => other.some((q) => related(p, q)));
  const theirs = new Set(other.map(moduleOf));
  const shared = new Set<string>();
  let inShared = 0;
  for (const p of likely) {
    const m = moduleOf(p);
    if (theirs.has(m)) {
      shared.add(m);
      inShared++;
    }
  }
  const modules = [...shared];
  const level: OverlapLevel =
    files.length > 0 || (inShared >= 2 && inShared * 2 >= likely.length)
      ? "heavy"
      : modules.length > 0
        ? "little"
        : "none";
  return { level, files, modules };
}

export interface TaskOverlap extends Overlap {
  task: string;
  project: string;
}

/** The worst overlap per running task, over the projects both use. Tasks in other projects do not count. */
export function overlapsOf(
  likelyByProject: ReadonlyMap<string, readonly string[]>,
  footprints: readonly Footprint[],
): TaskOverlap[] {
  const worst = new Map<string, TaskOverlap>();
  const rank: Record<OverlapLevel, number> = { none: 0, unknown: 1, little: 2, heavy: 3 };
  for (const f of footprints) {
    const likely = likelyByProject.get(f.project);
    if (likely === undefined) continue;
    const o = { ...overlapWith(likely, f.paths), task: f.task, project: f.project };
    const before = worst.get(f.task);
    if (before === undefined || rank[o.level] > rank[before.level]) worst.set(f.task, o);
  }
  return [...worst.values()];
}

/** "apps/server/src/runs" style summary for a room line. */
export function describeOverlap(o: Overlap): string {
  const where = o.modules.length > 0 ? o.modules : o.files.map(moduleOf);
  // The repo root is not a place worth naming: say which files, or that they sit at the root.
  const rootFiles = o.files.filter((f) => moduleOf(f) === ".");
  const named = where.flatMap((m) =>
    m === "." ? (rootFiles.length > 0 ? rootFiles : ["files in the repo root"]) : [m],
  );
  return [...new Set(named)].slice(0, 3).join(", ");
}

// ---------------------------------------------------------------------------
// Limits

/** Share of a window one task is expected to use, by size. Rough on purpose: it only has to tell a full account from a free one. */
export const COST_PCT = { small: 8, normal: 15, large: 25 } as const;
/** A task takes about a fifth of the share in the weekly window that it takes in the 5-hour one. */
const WEEKLY_DIVISOR = 5;
/** What each task already running on the account still uses before it ends, as a share of the 5-hour window. */
const RUNNING_TAIL_PCT = 5;
/** An account is out when the projection goes past this. */
export const LIMIT_CEILING_PCT = 95;

export type TaskSize = keyof typeof COST_PCT;

export function sizeOf(text: string, paths: readonly string[]): TaskSize {
  if (text.length >= 2000 || paths.length >= 6) return "large";
  if (text.length <= 400 && paths.length <= 2) return "small";
  return "normal";
}

export interface AccountLoad {
  /** Null for accounts without usage numbers (API keys) or when the read failed: they always fit. */
  usage: Pick<AccountUsage, "window" | "weekly"> | null;
  /** Tasks running on the account now. */
  running: number;
}

export interface Fit {
  fits: boolean;
  /** "the 5-hour window would reach 97%" */
  why?: string;
  /** When the blocking window resets. */
  resetsAt?: string;
}

/** Whether the account has room for one more task of this size next to the ones running. */
export function fitsAccount(load: AccountLoad, size: TaskSize): Fit {
  const usage = load.usage;
  if (usage === null) return { fits: true };
  const cost = COST_PCT[size];
  const tail = load.running * RUNNING_TAIL_PCT;
  const checks: { name: string; used: number; add: number; resetsAt: string | undefined }[] = [];
  if (usage.window !== undefined)
    checks.push({
      name: "5-hour window",
      used: usage.window.usedPct,
      add: cost + tail,
      resetsAt: usage.window.resetsAt,
    });
  if (usage.weekly !== undefined)
    checks.push({
      name: "weekly window",
      used: usage.weekly.usedPct,
      add: (cost + tail) / WEEKLY_DIVISOR,
      resetsAt: usage.weekly.resetsAt,
    });
  for (const c of checks) {
    const projected = c.used + c.add;
    if (projected > LIMIT_CEILING_PCT) {
      return {
        fits: false,
        why: `the ${c.name} is at ${Math.round(c.used)}% and this would take it to about ${Math.round(projected)}%`,
        ...(c.resetsAt === undefined ? {} : { resetsAt: c.resetsAt }),
      };
    }
  }
  return { fits: true };
}

// ---------------------------------------------------------------------------
// Verdict

export interface Candidate {
  agent: string;
  account: string;
}

export interface RunningTask {
  id: string;
  /** Milliseconds since it started running. */
  runningMs: number;
}

export interface PlanInput {
  size: TaskSize;
  /** The agent the task would start with. */
  agent: Candidate;
  /** Other agents that could take it, on any account, best first. */
  alternatives: readonly Candidate[];
  load: (account: string) => AccountLoad;
  overlaps: readonly TaskOverlap[];
  /** Running tasks by id, for the wait estimate. */
  running: readonly RunningTask[];
}

export type Verdict =
  | { action: "start"; note?: string }
  | { action: "switch"; agent: Candidate; because: string }
  | { action: "wait"; on: string[]; because: string }
  | { action: "queue"; because: string; until?: string }
  | { action: "ask"; on: string[]; module: string; waitMs: number };

/** Asking beats waiting quietly when the wait would be this long. */
export const ASK_WAIT_MS = 60 * 60_000;
const MIN_WAIT_MS = 10 * 60_000;

/**
 * How long a wait on these tasks would take: a running task is taken to be about half way, so as
 * long again as it has run so far, at least ten minutes. Several tasks: the longest.
 */
export function estimateWaitMs(on: readonly string[], running: readonly RunningTask[]): number {
  const times = on.map((id) => running.find((r) => r.id === id)?.runningMs ?? 0);
  return Math.max(MIN_WAIT_MS, ...times);
}

/**
 * One answer for a task about to start. Heavy overlap in the same module waits (or asks the owner
 * when the wait is long); little or none starts. Then limits: an account that would run out hands
 * the task to another account's agent if one fits, else the task queues.
 */
export function planStart(input: PlanInput): Verdict {
  const heavy = input.overlaps.filter((o) => o.level === "heavy");
  if (heavy.length > 0) {
    const on = heavy.map((o) => o.task);
    const waitMs = estimateWaitMs(on, input.running);
    const first = heavy[0];
    if (waitMs >= ASK_WAIT_MS && first !== undefined)
      return { action: "ask", on, module: describeOverlap(first), waitMs };
    return {
      action: "wait",
      on,
      because: `it overlaps ${on.join(", ")} in ${describeOverlap(heavy[0] ?? emptyOverlap)}`,
    };
  }

  const own = fitsAccount(input.load(input.agent.account), input.size);
  if (own.fits) {
    const little = input.overlaps.filter((o) => o.level === "little");
    return little.length === 0
      ? { action: "start" }
      : {
          action: "start",
          note: `little overlap with ${little.map((o) => o.task).join(", ")} (${describeOverlap(little[0] ?? emptyOverlap)})`,
        };
  }
  for (const alt of input.alternatives) {
    if (alt.account === input.agent.account) continue;
    if (fitsAccount(input.load(alt.account), input.size).fits) {
      return {
        action: "switch",
        agent: alt,
        because: `${input.agent.account} is short: ${own.why ?? "it would run out"}`,
      };
    }
  }
  return {
    action: "queue",
    because: `${input.agent.account} is short (${own.why ?? "it would run out"}) and no other account fits`,
    ...(own.resetsAt === undefined ? {} : { until: own.resetsAt }),
  };
}

const emptyOverlap: Overlap = { level: "none", files: [], modules: [] };

/**
 * Whether a "waits for" link can go: the two tasks have known paths and share nothing, not even
 * a module. Unknown means keep it.
 */
export function linkIsRedundant(overlap: Overlap | undefined): boolean {
  return overlap !== undefined && overlap.level === "none";
}

/** "about 2 hours", "about 40 minutes". */
export function humanWait(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 90) return `about ${minutes < 10 ? minutes : Math.round(minutes / 5) * 5} minutes`;
  const hours = Math.round(ms / 3_600_000);
  return `about ${hours} hours`;
}
