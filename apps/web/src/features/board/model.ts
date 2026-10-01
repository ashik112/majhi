import type { TaskSummary } from "@majhi/shared";
import type { LampState } from "@/components/ui/lamp";
import { inOrg, isOpen } from "../shell/model";
import { isYourTurn, taskLamp } from "../tasks/model";

export type ColumnId = "inbox" | "working" | "needs" | "mr" | "done";

export const COLUMN_LABEL: Record<ColumnId, string> = {
  inbox: "Inbox",
  working: "Working",
  needs: "Needs you",
  mr: "MR open",
  done: "Done",
};

/** The lamp of each column's header: the state its cards share. */
export const COLUMN_LAMP: Record<ColumnId, LampState> = {
  inbox: "idle",
  working: "working",
  needs: "needs",
  mr: "done",
  done: "done",
};

const COLUMNS: readonly ColumnId[] = ["inbox", "working", "needs", "mr", "done"];

/**
 * The column of a task. Inbox holds what nobody works on yet (inbox and ready). Needs you holds every
 * task that waits for the owner: a finished one to review, a running one whose agents all finished
 * their turn, and a paused one.
 */
export function columnOf(task: Pick<TaskSummary, "status" | "working">): ColumnId {
  switch (task.status) {
    case "inbox":
    case "ready":
      return "inbox";
    case "running":
      return isYourTurn(task) ? "needs" : "working";
    case "paused":
    case "review":
      return "needs";
    case "mr":
      return "mr";
    case "done":
      return "done";
  }
}

/** The one live line of a card, in its lamp's color: who works, or why it needs the owner. */
export interface CardLine {
  text: string;
  lamp: LampState;
}

const PAUSE_TEXT: Record<string, string> = {
  limit: "Paused: the account is at its usage limit",
  offline: "Paused: the connection was lost",
  error: "Paused: an error stopped it",
  owner: "Paused by you",
};

/** "Waiting on GLX-412", or "Waiting on GLX-412, GLX-413 +1" when there are more than two. */
export function waitingText(waitingOn: readonly string[]): string {
  const shown = waitingOn.slice(0, 2).join(", ");
  const more = waitingOn.length - 2;
  return `Waiting on ${shown}${more > 0 ? ` +${more}` : ""}`;
}

/** "@lead working", "@lead and @builder working", "@lead +2 working". */
export function workingText(working: readonly string[]): string {
  const [first, second] = working;
  if (first === undefined) return "Working";
  if (second === undefined) return `@${first} working`;
  if (working.length === 2) return `@${first} and @${second} working`;
  return `@${first} +${working.length - 1} working`;
}

export function cardLine(task: TaskSummary): CardLine | null {
  switch (task.status) {
    case "inbox":
    case "ready":
      if (task.waitingOn.length > 0) return { text: waitingText(task.waitingOn), lamp: "idle" };
      return task.status === "ready" ? { text: "Ready to start", lamp: "idle" } : null;
    case "running":
      return isYourTurn(task)
        ? { text: "Your turn: reply in the room", lamp: "needs" }
        : { text: workingText(task.working), lamp: "working" };
    case "paused":
      return { text: PAUSE_TEXT[task.pausedReason ?? ""] ?? "Paused", lamp: "paused" };
    case "review":
      return { text: "Finished: reply or mark done", lamp: "needs" };
    case "mr":
      return { text: "MR open, waiting for the merge", lamp: "done" };
    case "done":
      return null;
  }
}

/** Progress of a parent task: "3 of 5 done" and the filled share of the bar. Null without children. */
export function cardProgress(task: Pick<TaskSummary, "children">): { text: string; pct: number } | null {
  const kids = task.children;
  if (kids === undefined || kids.total === 0) return null;
  return { text: `${kids.done} of ${kids.total} done`, pct: Math.round((kids.done / kids.total) * 100) };
}

/** The parent a task is part of, as its id. */
export function partOf(task: Pick<TaskSummary, "links">): string | undefined {
  return task.links.find((l) => l.type === "parent")?.task;
}

/** A title as plain text: the backticks of inline code in markdown titles go. */
export function plainTitle(title: string): string {
  return title
    .replace(/`+([^`]*)`+/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** Sort key of a task id: prefix, then its number, so LOCAL-10 follows LOCAL-9. */
function idParts(id: string): [string, number] {
  const at = id.lastIndexOf("-");
  return [id.slice(0, at), Number(id.slice(at + 1))];
}

function newestFirst(a: TaskSummary, b: TaskSummary): number {
  return b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);
}

/** Newest id first. Stable while agents stream, since ids never change. */
function byIdDesc(a: TaskSummary, b: TaskSummary): number {
  const [pa, na] = idParts(a.id);
  const [pb, nb] = idParts(b.id);
  return pa.localeCompare(pb) || nb - na;
}

/** Ready tasks first: they were planned and can start now. */
function inboxOrder(a: TaskSummary, b: TaskSummary): number {
  const rank = (t: TaskSummary) => (t.status === "ready" ? 0 : 1);
  return rank(a) - rank(b) || newestFirst(a, b);
}

/** Red lamps first (review, your turn), then paused; each group keeps its place while agents stream. */
function needsOrder(a: TaskSummary, b: TaskSummary): number {
  const rank = (t: TaskSummary) => (taskLamp(t) === "needs" ? 0 : 1);
  return rank(a) - rank(b) || byIdDesc(a, b);
}

const ORDER: Record<ColumnId, (a: TaskSummary, b: TaskSummary) => number> = {
  inbox: inboxOrder,
  working: byIdDesc,
  needs: needsOrder,
  mr: newestFirst,
  done: newestFirst,
};

export function matchesQuery(task: TaskSummary, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  return (
    task.id.toLowerCase().includes(q) ||
    task.title.toLowerCase().includes(q) ||
    task.repos.some((r) => r.project.toLowerCase().includes(q))
  );
}

export interface Column {
  id: ColumnId;
  label: string;
  tasks: TaskSummary[];
}

export interface BoardOptions {
  org: string | undefined;
  query: string;
}

/** Every column in order, Done included, with the tasks that pass the org filter and the search. */
export function buildColumns(tasks: readonly TaskSummary[], options: BoardOptions): Column[] {
  const visible = tasks.filter((t) => inOrg(t, options.org) && matchesQuery(t, options.query));
  return COLUMNS.map((id) => ({
    id,
    label: COLUMN_LABEL[id],
    tasks: visible.filter((t) => columnOf(t) === id).toSorted(ORDER[id]),
  }));
}

export interface BoardCounts {
  open: number;
  working: number;
  needs: number;
  done: number;
}

/** The telemetry of the org filter's tasks: open, working now, waiting for the owner, done. */
export function boardCounts(tasks: readonly TaskSummary[], org: string | undefined): BoardCounts {
  const own = tasks.filter((t) => inOrg(t, org));
  return {
    open: own.filter(isOpen).length,
    working: own.filter((t) => columnOf(t) === "working").length,
    needs: own.filter((t) => columnOf(t) === "needs").length,
    done: own.filter((t) => !isOpen(t)).length,
  };
}

export type Direction = "up" | "down" | "left" | "right";

/** The key a board key stands for, or undefined. `j k h l` and the arrows. */
export function directionOf(key: string): Direction | undefined {
  switch (key) {
    case "j":
    case "ArrowDown":
      return "down";
    case "k":
    case "ArrowUp":
      return "up";
    case "h":
    case "ArrowLeft":
      return "left";
    case "l":
    case "ArrowRight":
      return "right";
    default:
      return undefined;
  }
}

/**
 * The card to move to. Up and down stay in the column; left and right jump to the nearest column
 * with cards, keeping the row where they can. Without a current card the first one is chosen.
 */
export function moveFocus(
  columns: readonly (readonly string[])[],
  current: string | undefined,
  direction: Direction,
): string | undefined {
  const col = current === undefined ? -1 : columns.findIndex((ids) => ids.includes(current));
  if (col === -1) {
    const first = columns.find((ids) => ids.length > 0);
    return first?.[0];
  }
  const ids = columns[col] ?? [];
  const row = current === undefined ? 0 : ids.indexOf(current);
  if (direction === "up") return ids[Math.max(0, row - 1)];
  if (direction === "down") return ids[Math.min(ids.length - 1, row + 1)];
  const step = direction === "left" ? -1 : 1;
  for (let at = col + step; at >= 0 && at < columns.length; at += step) {
    const target = columns[at];
    if (target && target.length > 0) return target[Math.min(row, target.length - 1)];
  }
  return current;
}

export interface TreeNode {
  task: TaskSummary;
  children: TreeNode[];
}

/**
 * The tasks as a tree: a task whose parent is also shown sits under it, the rest stand at the top.
 * Roots follow the board's column order, children follow their ids.
 */
export function buildTree(columns: readonly Column[]): TreeNode[] {
  const shown = columns.flatMap((c) => c.tasks);
  const ids = new Set(shown.map((t) => t.id));
  const kids = new Map<string, TaskSummary[]>();
  const roots: TaskSummary[] = [];
  for (const task of shown) {
    const parent = partOf(task);
    if (parent !== undefined && parent !== task.id && ids.has(parent)) {
      kids.set(parent, [...(kids.get(parent) ?? []), task]);
    } else {
      roots.push(task);
    }
  }
  const byId = (a: TaskSummary, b: TaskSummary) => {
    const [pa, na] = idParts(a.id);
    const [pb, nb] = idParts(b.id);
    return pa.localeCompare(pb) || na - nb;
  };
  const seen = new Set<string>();
  const node = (task: TaskSummary): TreeNode => {
    seen.add(task.id);
    return {
      task,
      children: (kids.get(task.id) ?? [])
        .toSorted(byId)
        .filter((k) => !seen.has(k.id))
        .map(node),
    };
  };
  return roots.map(node);
}

/** The rows a tree shows, skipping the children of collapsed parents. */
export function visibleRows(
  nodes: readonly TreeNode[],
  collapsed: ReadonlySet<string>,
  depth = 0,
): { task: TaskSummary; depth: number; hasChildren: boolean }[] {
  return nodes.flatMap((n) => [
    { task: n.task, depth, hasChildren: n.children.length > 0 },
    ...(collapsed.has(n.task.id) ? [] : visibleRows(n.children, collapsed, depth + 1)),
  ]);
}
