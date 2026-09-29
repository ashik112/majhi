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

/** The line under a card: why it is paused, that it is your turn, or who is working. */
export function cardNote(task: TaskSummary): CardNote | null {
  if (task.status === "paused") {
    return { text: PAUSE_TEXT[task.pausedReason ?? ""] ?? "Paused", tone: "coral" };
  }
  if (task.status === "running") {
    const who = task.working[0];
    return who ? { text: `@${who} working`, tone: "amber" } : { text: "Your turn", tone: "violet" };
  }
  return null;
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
