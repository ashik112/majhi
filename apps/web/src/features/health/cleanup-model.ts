import type { CleanupStep, CleanupTask } from "@majhi/shared";

/** The days field as a whole number from 1 to 3650, or undefined when it is not one. */
export function parseDays(text: string): number | undefined {
  const value = Number(text.trim());
  return /^[0-9]+$/.test(text.trim()) && value >= 1 && value <= 3650 ? value : undefined;
}

/** One line for a step: "Remove worktree /path", or "Keep branch x: it is not merged". */
export function stepText(step: CleanupStep, done: boolean): string {
  const what = `${step.kind} ${step.kind === "worktree" ? step.name : `${step.name} (${step.project})`}`;
  if (step.action === "skip") return `Kept ${what}: ${step.reason ?? "kept"}`;
  return `${done ? "Removed" : "Remove"} ${what}`;
}

/** How many worktrees and branches go, and how many room items, across tasks. */
export function taskTotals(tasks: readonly CleanupTask[]): { removes: number; roomItems: number } {
  return {
    removes: tasks.reduce((n, t) => n + t.steps.filter((s) => s.action === "remove").length, 0),
    roomItems: tasks.reduce((n, t) => n + t.roomItems, 0),
  };
}

/** What a cleanup would free, in words: "3 worktrees, 2 branches, 4 caches and 12 room items in 5 tasks". */
export function freeSummary(tasks: readonly CleanupTask[]): string {
  const count = (kind: CleanupStep["kind"]) =>
    tasks.reduce((n, t) => n + t.steps.filter((s) => s.kind === kind && s.action === "remove").length, 0);
  const rooms = tasks.reduce((n, t) => n + t.roomItems, 0);
  const parts = [
    [count("worktree"), "worktree", "worktrees"],
    [count("branch"), "branch", "branches"],
    [count("cache"), "dependency cache", "dependency caches"],
    [rooms, "room item", "room items"],
  ] as const;
  const named = parts.filter(([n]) => n > 0).map(([n, one, many]) => `${n} ${n === 1 ? one : many}`);
  if (named.length === 0) return "";
  const list = named.length === 1 ? named[0] : `${named.slice(0, -1).join(", ")} and ${named.at(-1)}`;
  return `${list} in ${tasks.length} ${tasks.length === 1 ? "task" : "tasks"}`;
}
