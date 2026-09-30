import type { TaskSummary } from "@majhi/shared";
import { inOrg, isOpen } from "../shell/model";
import { isYourTurn } from "../tasks/model";

export type ColumnId = "inbox" | "ready" | "working" | "review" | "mr" | "done";

export const COLUMN_LABEL: Record<ColumnId, string> = {
  inbox: "Inbox",
  ready: "Ready",
  working: "Working",
  review: "Your review",
  mr: "MR open",
  done: "Done",
};

/** Dot colors of the column headers, as Tailwind background classes. */
export const COLUMN_DOT: Record<ColumnId, string> = {
  inbox: "bg-fg-muted",
  ready: "bg-blue",
  working: "bg-amber",
  review: "bg-violet",
  mr: "bg-green",
  done: "bg-fg-dim",
};

const OPEN_COLUMNS: readonly ColumnId[] = ["inbox", "ready", "working", "review", "mr"];

/**
 * The column of a task. Paused tasks stay under Working, as in the design, with a note on the card.
 * A running task waiting for the owner ("your turn") stays there too, marked violet: Your review is
 * for tasks whose work is finished and needs a decision.
 */
export function columnOf(task: Pick<TaskSummary, "status">): ColumnId {
  switch (task.status) {
    case "inbox":
      return "inbox";
    case "ready":
      return "ready";
    case "running":
    case "paused":
      return "working";
    case "review":
      return "review";
    case "mr":
      return "mr";
    case "done":
      return "done";
  }
}

export type NoteTone = "amber" | "violet" | "coral";

export interface CardNote {
  text: string;
  tone: NoteTone;
}

const PAUSE_TEXT: Record<string, string> = {
  limit: "Paused · usage limit",
  offline: "Paused · connection lost",
  error: "Paused · an error stopped it",
  owner: "Paused · stopped by you",
};

/** "Waiting on GLX-412", or "Waiting on GLX-412, GLX-413 +1" when there are more than two. */
export function waitingText(waitingOn: readonly string[]): string {
  const shown = waitingOn.slice(0, 2).join(", ");
  const more = waitingOn.length - 2;
  return `Waiting on ${shown}${more > 0 ? ` +${more}` : ""}`;
}

/** The line under a card: why it is paused, that it is your turn, who is working, or what it waits on. */
/** The boss's chat lives behind Cmd J and on Hub setup, not on the board. */
export function isBossChat(
  task: Pick<TaskSummary, "kind" | "title" | "team">,
  bossId: string | undefined,
): boolean {
  return (
    bossId !== undefined && task.kind === "chat" && task.title === "Boss chat" && task.team[0] === bossId
  );
}

export function cardNote(task: TaskSummary): CardNote | null {
  if ((task.status === "inbox" || task.status === "ready") && task.waitingOn.length > 0) {
    return { text: waitingText(task.waitingOn), tone: "coral" };
  }
  if (task.status === "paused") {
    return { text: PAUSE_TEXT[task.pausedReason ?? ""] ?? "Paused", tone: "coral" };
  }
  if (task.status === "review") return { text: "Finished · reply or mark done", tone: "violet" };
  if (task.status === "mr") return { text: "MR open · waiting for the merge", tone: "violet" };
  if (task.status === "running") {
    const who = task.working[0];
    return who ? { text: `@${who} working`, tone: "amber" } : { text: "Your turn", tone: "violet" };
  }
  return null;
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

/** Sort key of a task id: prefix, then its number, so LOCAL-10 follows LOCAL-9. */
function idParts(id: string): [string, number] {
  const at = id.lastIndexOf("-");
  return [id.slice(0, at), Number(id.slice(at + 1))];
}

function newestFirst(a: TaskSummary, b: TaskSummary): number {
  return b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);
}

/** The order inside Working stays put while agents stream: needs-you first, then by id. */
function stableWorking(a: TaskSummary, b: TaskSummary): number {
  const need = (t: TaskSummary) => (t.status === "paused" ? 0 : isYourTurn(t) ? 1 : 2);
  const [pa, na] = idParts(a.id);
  const [pb, nb] = idParts(b.id);
  return need(a) - need(b) || pa.localeCompare(pb) || nb - na;
}

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
  showDone: boolean;
}

/** The columns in the design's order, with the tasks that pass the org filter and the search. */
export function buildColumns(tasks: readonly TaskSummary[], options: BoardOptions): Column[] {
  const visible = tasks.filter((t) => inOrg(t, options.org) && matchesQuery(t, options.query));
  const ids: readonly ColumnId[] = options.showDone ? [...OPEN_COLUMNS, "done"] : OPEN_COLUMNS;
  return ids.map((id) => ({
    id,
    label: COLUMN_LABEL[id],
    tasks: visible.filter((t) => columnOf(t) === id).toSorted(id === "working" ? stableWorking : newestFirst),
  }));
}

/** "8 open", or "8 open · 3 done" for the org filter's tasks. */
export function boardCounts(
  tasks: readonly TaskSummary[],
  org: string | undefined,
): { open: number; done: number } {
  const own = tasks.filter((t) => inOrg(t, org));
  return { open: own.filter(isOpen).length, done: own.filter((t) => !isOpen(t)).length };
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
