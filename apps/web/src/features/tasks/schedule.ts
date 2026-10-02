import type { TaskPriority } from "@majhi/shared";

/**
 * The owner's priority and due date on a task, as the board, the task rows and the task header
 * show them. Priority is absent for normal; due is a local calendar day, `YYYY-MM-DD`.
 */

export const PRIORITY_LABEL: Record<TaskPriority, string> = { high: "High", normal: "Normal", low: "Low" };

/** The local calendar day `days` after `now`, `YYYY-MM-DD`. */
export function dayFrom(now: number, days = 0): string {
  const d = new Date(now);
  d.setDate(d.getDate() + days);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Whole days from today to `day`: negative when it is past, NaN for a day that does not parse. */
export function daysUntil(day: string, now: number): number {
  const today = Date.parse(`${dayFrom(now)}T00:00:00`);
  return Math.round((Date.parse(`${day}T00:00:00`) - today) / 86_400_000);
}

/** "Oct 9", or "Oct 9, 2027" outside this year. */
export function shortDay(day: string, now: number): string {
  const date = new Date(`${day}T00:00:00`);
  if (Number.isNaN(date.getTime())) return day;
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

export type DueTone = "late" | "soon" | "later";

export interface DueInfo {
  /** "Overdue 2 days", "Due today", "Due tomorrow", "Due Oct 9". */
  text: string;
  /** For tight rows: "Overdue 2d", "Today", "Tomorrow", "Oct 9". */
  short: string;
  tone: DueTone;
}

/** How a due date reads on a card: overdue is late, today and tomorrow are soon. */
export function dueInfo(day: string, now: number): DueInfo {
  const days = daysUntil(day, now);
  if (Number.isNaN(days)) return { text: `Due ${day}`, short: day, tone: "later" };
  if (days < 0)
    return {
      text: `Overdue ${-days} ${days === -1 ? "day" : "days"}`,
      short: `Overdue ${-days}d`,
      tone: "late",
    };
  if (days === 0) return { text: "Due today", short: "Today", tone: "soon" };
  if (days === 1) return { text: "Due tomorrow", short: "Tomorrow", tone: "soon" };
  const label = shortDay(day, now);
  return { text: `Due ${label}`, short: label, tone: "later" };
}

/** The due chip of an open task; a done task's deadline no longer matters. */
export function openDue(
  task: { due?: string | undefined; status: string },
  now: number,
): DueInfo | undefined {
  return task.due !== undefined && task.status !== "done" ? dueInfo(task.due, now) : undefined;
}

/** The quick picks for a due date. */
export function duePicks(now: number): { label: string; day: string }[] {
  return [
    { label: "Today", day: dayFrom(now, 0) },
    { label: "Tomorrow", day: dayFrom(now, 1) },
    { label: "In a week", day: dayFrom(now, 7) },
  ];
}

/** "now", "5m", "3h", "4d", then "Oct 3": a quiet age for a row. */
export function shortAgo(iso: string, now: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const minutes = Math.floor((now - then) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(then).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** "Updated Oct 2, 14:05" for a tooltip. */
export function fullTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
