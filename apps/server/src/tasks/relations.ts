import type { TaskId, TaskLink, TaskStatus } from "@majhi/shared";

/** One row of `task_links`: `task` is the child or the waiting task, `other` is the parent or the target. */
export interface LinkRow {
  task: string;
  type: TaskLink["type"];
  other: string;
  when?: TaskLink["when"] | undefined;
}

/**
 * Whether a dependency counts as met (5.4a). `merged` means the target is done: merge requests
 * come in Phase 5, until then closing a task counts as merging it. `ready` means the target is
 * ready for review or further along.
 */
export function isMet(when: TaskLink["when"], status: TaskStatus): boolean {
  if (when === "ready") return status === "review" || status === "mr" || status === "done";
  return status === "done";
}

/** The dependencies of a task that are not met yet. A target that no longer exists is skipped. */
export function unmetDependencies(
  links: readonly Pick<LinkRow, "type" | "other" | "when">[],
  statusOf: (id: string) => TaskStatus | undefined,
): TaskId[] {
  const out: TaskId[] = [];
  for (const l of links) {
    if (l.type !== "depends-on") continue;
    const status = statusOf(l.other);
    if (status !== undefined && !isMet(l.when, status)) out.push(l.other as TaskId);
  }
  return out;
}

/**
 * The path a new link would close into a loop, or undefined. For `parent`, follows parent links
 * up from the new parent; for `depends-on`, follows dependencies from the target. Either way
 * a path that reaches `task` is a cycle: `[task, target, ..., task]`.
 */
export function findCycle(
  rows: readonly LinkRow[],
  type: "parent" | "depends-on",
  task: string,
  target: string,
): string[] | undefined {
  if (task === target) return [task, task];
  const next = new Map<string, string[]>();
  for (const r of rows) {
    if (r.type !== type) continue;
    const list = next.get(r.task) ?? [];
    list.push(r.other);
    next.set(r.task, list);
  }
  const seen = new Set<string>();
  const walk = (at: string, path: string[]): string[] | undefined => {
    if (at === task) return path;
    if (seen.has(at)) return undefined;
    seen.add(at);
    for (const n of next.get(at) ?? []) {
      const found = walk(n, [...path, n]);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  const found = walk(target, [task, target]);
  return found;
}

export function describeCycle(type: "parent" | "depends-on", path: readonly string[]): string {
  const what = type === "parent" ? "parents" : "dependencies";
  return `That would make a loop of ${what}: ${path.join(" -> ")}.`;
}

/** Children of a parent that are not done. Empty for a parent without children means nothing to finish. */
export function parentIsComplete(childStatuses: readonly TaskStatus[]): boolean {
  return childStatuses.length > 0 && childStatuses.every((s) => s === "done");
}

/** The tasks a task relates to, for TASK.md. */
export interface RelatedTask {
  id: string;
  title: string;
  status: TaskStatus;
  /** Branch names of the task's repos. */
  branches: string[];
}
export interface Related {
  parent?: RelatedTask;
  depends: (RelatedTask & { when: "merged" | "ready" })[];
  children: RelatedTask[];
}

export const NO_RELATED: Related = { depends: [], children: [] };

export function hasRelated(r: Related): boolean {
  return r.parent !== undefined || r.depends.length > 0 || r.children.length > 0;
}
