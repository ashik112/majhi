import { createHash } from "node:crypto";
import type { Task, TaskSize, TaskSizeLimit } from "@majhi/shared";
import type Database from "better-sqlite3";
import type { TaskRating } from "../decisions/api.ts";
import type { Difficulty } from "../runs/difficulty.ts";

/**
 * How much work a task is, for autonomous mode's pick rules (PRV-74 follow-up). The decision provider
 * (Laya) rates the task's text the way it does for an `auto` model pick; the rating is cached per task
 * and rated again when the title or brief change.
 */

/** A task's size as the rules read it. `size` is absent when it is not known. */
export interface SizeOf {
  size?: TaskSize;
  /** How it is known, one line: "Laya rated it medium (0.62)". */
  note: string;
}

/** The text a size is rated from. */
export interface SizeInput {
  id?: string | undefined;
  title: string;
  brief: string;
  kind: Task["kind"];
  repos: readonly string[];
}

/** Asks the decision provider. Undefined: no provider answered. */
export type SizeRater = (task: SizeInput) => Promise<TaskRating | undefined>;

/** A rating that was not sure enough, or none, is asked again after this long (Laya may be ready by then). */
const RETRY_UNKNOWN_MS = 6 * 60 * 60_000;

/** Laya's levels as the rules count them: a trivial task is a small one. */
export function sizeOfLevel(level: Difficulty): TaskSize {
  return level === "trivial" ? "small" : level;
}

const LIMIT_WORD: Record<TaskSizeLimit, string> = {
  small: "Small only",
  medium: "Up to medium",
  any: "Any size",
};

export function limitWord(limit: TaskSizeLimit): string {
  return LIMIT_WORD[limit];
}

/** Whether a task of this size may start under the limit. An unknown size fits only `any`. */
export function fitsSize(limit: TaskSizeLimit, size: TaskSize | undefined): boolean {
  if (limit === "any") return true;
  if (size === undefined) return false;
  return limit === "medium" ? size !== "large" : size === "small";
}

/** Why the size rule keeps the task from starting, or undefined when it fits. */
export function sizeProblem(limit: TaskSizeLimit, of: SizeOf): string | undefined {
  if (fitsSize(limit, of.size)) return undefined;
  return of.size === undefined
    ? `its size is not known (${lowerFirst(of.note)}), and the size rule is ${LIMIT_WORD[limit]}`
    : `it is ${of.size}, and the size rule is ${LIMIT_WORD[limit]}`;
}

/** The line for a rating: counted, a guess, or none. */
export function sizeFromRating(rating: TaskRating | undefined): SizeOf {
  if (rating === undefined) return { note: "No decision provider could rate it" };
  if (rating.level === undefined) return { note: `${rating.by} said no size fits it` };
  if (!rating.counted) {
    return {
      note: `${rating.by} guessed ${sizeOfLevel(rating.level)}, not sure enough to count${rating.why === "" ? "" : ` (${rating.why})`}`,
    };
  }
  return {
    size: sizeOfLevel(rating.level),
    note: `${rating.by} rated it ${sizeOfLevel(rating.level)} (${rating.confidence.toFixed(2)})`,
  };
}

/** A hash of what was rated, so an edited task is rated again. */
export function sizeKey(task: Pick<SizeInput, "title" | "brief">): string {
  return createHash("sha256").update(`${task.title}\n${task.brief}`).digest("hex").slice(0, 32);
}

interface SizeRow {
  task: string;
  key: string;
  size: string | null;
  note: string;
  at: string;
}

const SIZES: readonly string[] = ["small", "medium", "large"];

export class TaskSizes {
  private rater: SizeRater | undefined;
  /** One rating per task at a time. */
  private readonly rating = new Map<string, Promise<SizeOf>>();

  constructor(
    private readonly db: Database.Database,
    rater: SizeRater | undefined,
    private readonly now: () => Date,
  ) {
    this.rater = rater;
  }

  /** Replaces the rater (tests use a fixed one). */
  useRater(rater: SizeRater | undefined): void {
    this.rater = rater;
  }

  /** The cached size, while the task's text is the one rated and an unknown size is not due again. */
  known(task: Task): SizeOf | undefined {
    const row = this.db.prepare("SELECT * FROM autonomy_sizes WHERE task = ?").get(task.id) as
      | SizeRow
      | undefined;
    if (row === undefined || row.key !== sizeKey(task)) return undefined;
    const size = row.size !== null && SIZES.includes(row.size) ? (row.size as TaskSize) : undefined;
    if (size === undefined && this.now().getTime() - Date.parse(row.at) > RETRY_UNKNOWN_MS) return undefined;
    return { ...(size === undefined ? {} : { size }), note: row.note };
  }

  /** The size of an existing task: cached, or rated now and kept. */
  of(task: Task): Promise<SizeOf> {
    const cached = this.known(task);
    if (cached !== undefined) return Promise.resolve(cached);
    const running = this.rating.get(task.id);
    if (running !== undefined) return running;
    const next = this.rateText(inputOf(task))
      .then((of) => {
        this.record(task, of);
        return of;
      })
      .finally(() => this.rating.delete(task.id));
    this.rating.set(task.id, next);
    return next;
  }

  /** Rates text that is not a task yet. Not kept. */
  async rateText(input: SizeInput): Promise<SizeOf> {
    if (this.rater === undefined) return { note: "No decision provider could rate it" };
    return sizeFromRating(await this.rater(input).catch(() => undefined));
  }

  /**
   * Rates the tasks with no known size, in order, until `budgetMs` passed. True when it rated any.
   * Used before a tick, so the digest shows sizes, and in the background for the page.
   */
  async fill(tasks: readonly Task[], budgetMs: number): Promise<boolean> {
    const until = Date.now() + budgetMs;
    let rated = false;
    for (const task of tasks) {
      if (Date.now() > until) break;
      if (this.known(task) !== undefined) continue;
      await this.of(task);
      rated = true;
    }
    return rated;
  }

  /** Keeps a size for the task's current text. */
  record(task: Pick<Task, "id" | "title" | "brief">, of: SizeOf): void {
    try {
      this.db
        .prepare(
          `INSERT INTO autonomy_sizes (task, key, size, note, at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (task) DO UPDATE SET key = excluded.key, size = excluded.size, note = excluded.note, at = excluded.at`,
        )
        .run(task.id, sizeKey(task), of.size ?? null, of.note, this.now().toISOString());
    } catch {
      // The task was removed meanwhile: its foreign key refuses the row.
    }
  }
}

function inputOf(task: Task): SizeInput {
  return {
    id: task.id,
    title: task.title,
    brief: task.brief,
    kind: task.kind,
    repos: task.repos.map((r) => r.project),
  };
}

function lowerFirst(text: string): string {
  return text === "" ? text : text[0]?.toLowerCase() + text.slice(1);
}
