import { type MergeChecks, type QueuedMerge, QueuedMergeSchema, shipWords } from "@majhi/shared";
import type Database from "better-sqlite3";
import { errorMessage, UserError } from "../errors.ts";

/**
 * "Merge when checks pass". The owner picks a merge in Ship while the hand-off check of the task's
 * head runs. majhi records that intent with the head it was asked for. When the check of exactly
 * that head is green, it runs the same merge path as the Ship button (`TaskService.merge`, through
 * the merge gate). When the head moved, a check failed or the merge refuses, it forgets the intent,
 * merges nothing, and tells the owner why on a fresh review card. It never retries.
 */

/** What the merge needs of a task: where it stands now. */
export interface QueuedTask {
  id: string;
  status: string;
  repos: number;
}

export interface QueuedMergePorts {
  task(id: string): QueuedTask | undefined;
  /** The merge gate's verdict for the task's head now. */
  checks(id: string): Promise<MergeChecks>;
  /** Runs the merge. Resolves with why it failed, or undefined when it merged everywhere. */
  run(queued: QueuedMerge): Promise<string | undefined>;
  /** A line in the room. */
  say(task: string, text: string): void;
  /** Puts the reason on a fresh review card, so the owner decides. */
  refuse(task: string, text: string): void;
  changed(task: string): void;
  now(): Date;
}

/** What the recorded intent does with the checks as they are now. Pure: typed data, no text read. */
export type QueuedStep = { do: "wait" } | { do: "merge" } | { do: "cancel"; why: string };

export function decideQueued(queued: Pick<QueuedMerge, "head">, now: MergeChecks): QueuedStep {
  const { verdict } = now;
  if (verdict.kind === "running") return { do: "wait" };
  // Only the exact head that was asked for merges: a commit since then is a different state.
  if (now.head !== queued.head) return { do: "cancel", why: "the task has new commits since you asked" };
  switch (verdict.kind) {
    case "ok":
      return { do: "merge" };
    case "failed":
      return {
        do: "cancel",
        why:
          verdict.check === "secret"
            ? "the diff holds what looks like a secret"
            : `the ${verdict.check} check failed`,
      };
    case "blocked":
      return { do: "cancel", why: verdict.why };
    case "stale":
      return { do: "cancel", why: "no check ran on this commit" };
  }
}

export class QueuedMerges {
  private readonly evaluating = new Set<string>();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly db: Database.Database,
    private readonly ports: QueuedMergePorts,
  ) {}

  get(task: string): QueuedMerge | undefined {
    const row = this.db.prepare("SELECT body FROM queued_merges WHERE task = ?").get(task) as
      | { body: string }
      | undefined;
    if (row === undefined) return undefined;
    try {
      const parsed = QueuedMergeSchema.safeParse(JSON.parse(row.body));
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  private put(q: QueuedMerge): void {
    this.db
      .prepare("INSERT OR REPLACE INTO queued_merges (task, body) VALUES (?, ?)")
      .run(q.task, JSON.stringify(QueuedMergeSchema.parse(q)));
  }

  /** Removes the intent. True when one was there: only the one who removes it may act on it. */
  private take(task: string): QueuedMerge | undefined {
    const q = this.get(task);
    if (q === undefined) return undefined;
    const gone = this.db.prepare("DELETE FROM queued_merges WHERE task = ?").run(task).changes > 0;
    return gone ? q : undefined;
  }

  /**
   * Records the intent. Only for the owner (the command checks who asks), only for a task in review,
   * and only while the check of its head runs: with a verdict already there, Ship merges or refuses now.
   */
  async request(input: {
    task: string;
    action: QueuedMerge["action"];
    into?: string | undefined;
    targets?: Readonly<Record<string, string>> | undefined;
    method: QueuedMerge["method"];
    deleteAfter: boolean;
    by: string;
  }): Promise<QueuedMerge> {
    const task = this.ports.task(input.task);
    if (task === undefined) throw new UserError(`There is no task ${input.task}.`, 404);
    if (task.status !== "review") throw new UserError(`${task.id} is not in review.`, 409);
    if (task.repos === 0) throw new UserError(`${task.id} has no repo to merge.`, 409);
    const checks = await this.ports.checks(task.id);
    if (checks.verdict.kind !== "running") {
      throw new UserError(
        "The checks are not running for this commit. Merge now, or run the checks first.",
        409,
      );
    }
    const into =
      input.targets === undefined
        ? (input.into ?? "")
        : [...new Set(Object.values(input.targets))].join(", ");
    const queued: QueuedMerge = {
      task: task.id,
      action: input.action,
      into,
      ...(input.targets === undefined ? {} : { targets: { ...input.targets } }),
      method: input.method,
      deleteAfter: input.deleteAfter,
      head: checks.head,
      by: input.by,
      at: this.ports.now().toISOString(),
    };
    this.put(queued);
    this.ports.changed(task.id);
    this.start();
    return queued;
  }

  /** The owner changed their mind. Nothing merges. */
  cancel(task: string): void {
    if (this.take(task) !== undefined) this.ports.changed(task);
  }

  /** Looks at every waiting intent now, and again every few seconds while any exists. */
  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => void this.evaluateAll(), 3_000);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async evaluateAll(): Promise<void> {
    const rows = this.db.prepare("SELECT task FROM queued_merges").all() as { task: string }[];
    if (rows.length === 0) return this.stop();
    await Promise.all(rows.map((r) => this.evaluate(r.task)));
  }

  /** Decides one task's intent from the checks as they are now. Safe to call as often as you like. */
  async evaluate(id: string): Promise<void> {
    const queued = this.get(id);
    if (queued === undefined || this.evaluating.has(id)) return;
    this.evaluating.add(id);
    try {
      const task = this.ports.task(id);
      // The task left review (the owner merged it or closed it themselves): the intent has no use.
      if (task === undefined || task.status !== "review") {
        this.cancel(id);
        return;
      }
      const step = decideQueued(queued, await this.ports.checks(id));
      if (step.do === "wait") return;
      // Removed before it runs, so it runs at most once.
      if (this.take(id) === undefined) return;
      this.ports.changed(id);
      if (step.do === "cancel") {
        this.ports.refuse(id, `Did not ${shipWords(queued)} when the checks passed: ${step.why}.`);
        return;
      }
      this.ports.say(id, `The checks passed. majhi will ${shipWords(queued)}, as you asked.`);
      const failed = await this.ports.run(queued).catch((err: unknown) => errorMessage(err));
      if (failed !== undefined) {
        this.ports.refuse(
          id,
          `Did not ${shipWords(queued)} when the checks passed: ${failed.replace(/\.$/, "")}.`,
        );
      }
    } finally {
      this.evaluating.delete(id);
    }
  }
}
