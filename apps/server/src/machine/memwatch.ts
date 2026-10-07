import type { MachineContainer } from "@majhi/shared";

/** A run container counts as thrashing at this share of its memory limit. */
export const MEMORY_HOT_PCT = 95;
/** It must stay there for this many readings in a row (45 s apart), so a spike does not count. */
export const MEMORY_HOT_READINGS = 2;

/**
 * Finds run containers that sit at their memory limit. `read` returns the containers that just
 * crossed the bar after enough readings in a row, once each: it stays quiet until the container drops
 * below the bar again or goes away.
 */
export class MemoryWatch {
  private readonly streak = new Map<string, number>();
  private readonly noted = new Set<string>();

  read(containers: readonly MachineContainer[]): string[] {
    const hot = new Set<string>();
    const fresh: string[] = [];
    for (const c of containers) {
      if (!c.name.startsWith("majhi-run-") || c.memLimitBytes === undefined) continue;
      if ((c.memBytes / c.memLimitBytes) * 100 < MEMORY_HOT_PCT) continue;
      hot.add(c.name);
      const n = (this.streak.get(c.name) ?? 0) + 1;
      this.streak.set(c.name, n);
      if (n >= MEMORY_HOT_READINGS && !this.noted.has(c.name)) {
        this.noted.add(c.name);
        fresh.push(c.name);
      }
    }
    for (const name of [...this.streak.keys()]) {
      if (hot.has(name)) continue;
      this.streak.delete(name);
      this.noted.delete(name);
    }
    return fresh;
  }
}

/** The warning's id: one line per task and level, whatever number of runs or checks reach the bar. */
export function hotMemoryItemId(task: string, level: "hot"): string {
  return `memory:${task}:${level}`;
}

export const HOT_MEMORY_TEXT =
  "An agent on this task is using almost all of its memory limit and may be slow or get stopped. Raise the memory limit for runs, or ask it to do less at once.";

/**
 * Posts the warning for each hot container's task. The id is the task's and the level's, so the same
 * condition read again (every check, every reading) updates the one line instead of adding another.
 * `rows` is `docker ps` with a name and a task per line.
 */
export function noteHotContainers(args: {
  hot: readonly string[];
  rows: string;
  taskExists: (task: string) => boolean;
  post: (task: string, id: string, text: string) => void;
}): void {
  for (const line of args.rows.split("\n")) {
    const [name, task] = line.split("\t");
    if (name === undefined || task === undefined || task === "" || !args.hot.includes(name)) continue;
    if (!args.taskExists(task)) continue;
    args.post(task, hotMemoryItemId(task, "hot"), HOT_MEMORY_TEXT);
  }
}
