/**
 * Who holds a project's environment (its network, services, compose stacks and preview), and who waits.
 * One task at a time holds it; the others wait in order and the first in line gets it when it is released
 * (docs/briefs/workflow-reset.md, step 2: the owner chose the queue over a second slot).
 *
 * Pure bookkeeping: it starts and stops nothing. `ContainerService` releases an environment only after its
 * containers are gone, so a task that is handed the environment never meets what the last one left.
 */

/** A task's request for an environment, answered with its place in line. */
interface Waiter {
  task: string;
  /** Called once with the task as the new holder; or with an error when the task leaves the line. */
  settle: { grant: () => void; refuse: (reason: Error) => void }[];
}

/** One environment as the owner sees it: who holds it and who waits, in order. */
export interface EnvSnapshot {
  env: string;
  holder: string;
  waiting: string[];
}

/** The task left the line (it paused, stopped or ended) before it got the environment. */
export class LeftTheLine extends Error {}

export class EnvQueue {
  private readonly holders = new Map<string, string>();
  private readonly lines = new Map<string, Waiter[]>();

  /** The task that holds the environment now. */
  holder(env: string): string | undefined {
    return this.holders.get(env);
  }

  /** The environments this task holds. */
  heldBy(task: string): string[] {
    return [...this.holders].flatMap(([env, holder]) => (holder === task ? [env] : []));
  }

  /** Takes a free environment, or keeps one the task holds. False when another task holds it. */
  take(env: string, task: string): boolean {
    const holder = this.holders.get(env);
    if (holder === undefined) {
      this.holders.set(env, task);
      return true;
    }
    return holder === task;
  }

  /** The task's place in line, 1 for next, or 0 when it is not waiting. */
  place(env: string, task: string): number {
    return (this.lines.get(env) ?? []).findIndex((w) => w.task === task) + 1;
  }

  /**
   * Gets the environment now, or waits in line for it: the promise settles when the task holds it, and
   * rejects with `LeftTheLine` when `leave` takes the task out. A task that waits twice keeps its place.
   */
  acquire(
    env: string,
    task: string,
  ): { held: true } | { held: false; place: number; granted: Promise<void> } {
    if (this.take(env, task)) return { held: true };
    const line = this.lines.get(env) ?? [];
    this.lines.set(env, line);
    let waiter = line.find((w) => w.task === task);
    if (waiter === undefined) {
      waiter = { task, settle: [] };
      line.push(waiter);
    }
    const found = waiter;
    const granted = new Promise<void>((grant, refuse) => found.settle.push({ grant, refuse }));
    return { held: false, place: line.indexOf(found) + 1, granted };
  }

  /**
   * The holder lets go. The first in line holds it from now on, and is returned so the caller can tell
   * it. Nothing happens for a task that does not hold it.
   */
  release(env: string, task: string): string | undefined {
    if (this.holders.get(env) !== task) return undefined;
    this.holders.delete(env);
    const line = this.lines.get(env) ?? [];
    const next = line.shift();
    if (line.length === 0) this.lines.delete(env);
    if (next === undefined) return undefined;
    this.holders.set(env, next.task);
    for (const s of next.settle) s.grant();
    return next.task;
  }

  /** The task leaves every line it waits in, and its waiting calls fail. What it holds stays until `release`. */
  leave(task: string): void {
    for (const [env, line] of this.lines) {
      const rest = line.filter((w) => w.task !== task);
      for (const w of line) if (w.task === task) for (const s of w.settle) s.refuse(new LeftTheLine());
      if (rest.length === 0) this.lines.delete(env);
      else this.lines.set(env, rest);
    }
  }

  /** Forgets everything: majhi started, and nothing it ran before is running. */
  clear(): void {
    for (const line of this.lines.values())
      for (const w of line) for (const s of w.settle) s.refuse(new LeftTheLine());
    this.holders.clear();
    this.lines.clear();
  }

  snapshot(): EnvSnapshot[] {
    return [...this.holders].map(([env, holder]) => ({
      env,
      holder,
      waiting: (this.lines.get(env) ?? []).map((w) => w.task),
    }));
  }
}
